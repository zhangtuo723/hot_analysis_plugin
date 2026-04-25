import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.models.analyze import Conversation, AnalyzeLog
from app.agent.agent import run_agent, run_agent_stream
from app.agent.ws import browser_manager

router = APIRouter(prefix="/api", tags=["analyze"])


# ---- Chat ----

class ChatRequest(BaseModel):
    conversation_id: str | None = None
    client_id: str
    content: str


class ChatResponse(BaseModel):
    conversation_id: str
    content: str


@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest, db: Session = Depends(get_db)):
    if req.conversation_id:
        conv = (
            db.query(Conversation)
            .filter(Conversation.id == req.conversation_id)
            .first()
        )
        if not conv:
            raise HTTPException(404, "对话不存在")
        history = json.loads(conv.messages_json)
    else:
        conv = Conversation(user_id=req.client_id)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        history = []

    history.append({"role": "user", "content": req.content})
    conv.messages_json = json.dumps(history, ensure_ascii=False)
    db.commit()

    executor = browser_manager.get_executor(req.client_id)
    start_time = datetime.now()
    try:
        reply = await run_agent(executor, [history[-1]], conv.id)
    except Exception as e:
        reply = f"分析过程中出错：{e}"

    history.append({"role": "assistant", "content": reply})
    conv.messages_json = json.dumps(history, ensure_ascii=False)
    if not conv.title and req.content:
        conv.title = req.content[:50]
    db.commit()

    _write_analyze_log(db, conv.id, req.client_id, req.content, start_time)
    return ChatResponse(conversation_id=conv.id, content=reply)


# ---- Chat Stream (SSE) ----

@router.post("/chat/stream")
async def chat_stream_endpoint(req: ChatRequest, db: Session = Depends(get_db)):
    """SSE 流式接口：实时返回 Agent 工具调用和回复"""
    if req.conversation_id:
        conv = (
            db.query(Conversation)
            .filter(Conversation.id == req.conversation_id)
            .first()
        )
        if not conv:
            raise HTTPException(404, "对话不存在")
        history = json.loads(conv.messages_json)
    else:
        conv = Conversation(user_id=req.client_id)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        history = []

    history.append({"role": "user", "content": req.content})
    conv.messages_json = json.dumps(history, ensure_ascii=False)
    db.commit()

    executor = browser_manager.get_executor(req.client_id)
    conv_id = conv.id

    async def event_stream():
        full_reply = ""
        round_tool_calls: list[dict] = []
        start_time = datetime.now()
        try:
            async for event in run_agent_stream(
                executor, [{"role": "user", "content": req.content}], conv_id
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["type"] == "message":
                    full_reply += event["content"]
                elif event["type"] == "tool_start":
                    round_tool_calls.append(
                        {
                            "id": f"{event['tool']}_{int(start_time.timestamp() * 1000)}_{len(round_tool_calls)}",
                            "tool": event["tool"],
                            "params": event.get("params", {}),
                            "status": "running",
                        }
                    )
                elif event["type"] == "tool_result":
                    for tc in reversed(round_tool_calls):
                        if tc["tool"] == event["tool"] and tc["status"] == "running":
                            tc["result"] = event.get("result", "")
                            tc["status"] = "done"
                            break
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

        # 用新 Session 保存结果（原 Session 在 StreamingResponse 返回后已关闭）
        with SessionLocal() as db2:
            conv2 = db2.query(Conversation).filter(Conversation.id == conv_id).first()
            if conv2:
                current_history = json.loads(conv2.messages_json)
                current_history.append(
                    {"role": "assistant", "content": full_reply or "Agent 未生成回复"}
                )
                conv2.messages_json = json.dumps(current_history, ensure_ascii=False)

                existing_tool_calls = json.loads(conv2.tool_calls_json or "[]")
                existing_tool_calls.extend(round_tool_calls)
                conv2.tool_calls_json = json.dumps(existing_tool_calls, ensure_ascii=False)

                if not conv2.title and req.content:
                    conv2.title = req.content[:50]
                db2.commit()

                _write_analyze_log(
                    db2, conv2.id, req.client_id, req.content, start_time
                )

        yield f"data: {json.dumps({'type': 'done', 'conversation_id': conv_id}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


# ---- Conversations ----

class ConversationSummary(BaseModel):
    id: str
    title: str
    created_at: str | None


@router.get("/conversations", response_model=list[ConversationSummary])
def list_conversations(user_id: str | None = None, db: Session = Depends(get_db)):
    query = db.query(Conversation).order_by(Conversation.updated_at.desc())
    if user_id:
        query = query.filter(Conversation.user_id == user_id)
    convs = query.limit(50).all()
    return [
        ConversationSummary(
            id=c.id,
            title=c.title,
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in convs
    ]


class MessageItem(BaseModel):
    role: str
    content: str


class ConversationDetail(BaseModel):
    id: str
    title: str
    messages: list[MessageItem]
    tool_calls: list[dict]
    created_at: str | None


@router.get("/conversations/{conv_id}", response_model=ConversationDetail)
def get_conversation(conv_id: str, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "对话不存在")
    messages = json.loads(conv.messages_json)
    tool_calls = json.loads(conv.tool_calls_json or "[]")
    return ConversationDetail(
        id=conv.id,
        title=conv.title,
        messages=[MessageItem(**m) for m in messages],
        tool_calls=tool_calls,
        created_at=conv.created_at.isoformat() if conv.created_at else None,
    )


@router.delete("/conversations/{conv_id}")
def delete_conversation(conv_id: str, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "对话不存在")
    db.delete(conv)
    db.commit()
    return {"ok": True}


# ---- WebSocket ----

@router.websocket("/ws/browser/{client_id}")
async def browser_websocket(websocket: WebSocket, client_id: str):
    await websocket.accept()
    browser_manager.add(client_id, websocket)
    try:
        while not browser_manager.shutdown_event.is_set():
            try:
                data = await asyncio.wait_for(
                    websocket.receive_json(), timeout=1.0
                )
                browser_manager.handle_message(client_id, data)
            except asyncio.TimeoutError:
                continue
    except WebSocketDisconnect:
        pass
    finally:
        browser_manager.remove(client_id)


# ---- Helpers ----

def _write_analyze_log(
    db: Session,
    conversation_id: str,
    user_id: str,
    keyword: str,
    start_time: datetime,
) -> None:
    """写入分析任务日志"""
    duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
    log = AnalyzeLog(
        conversation_id=conversation_id,
        user_id=user_id,
        keyword=keyword[:50],
        duration_ms=duration_ms,
    )
    db.add(log)
    db.commit()
