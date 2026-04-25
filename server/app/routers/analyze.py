import json

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.analyze import Conversation
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
        conv = db.query(Conversation).filter(Conversation.id == req.conversation_id).first()
        if not conv:
            raise HTTPException(404, "对话不存在")
        history = json.loads(conv.messages_json)
    else:
        conv = Conversation()
        db.add(conv)
        db.commit()
        db.refresh(conv)
        history = []

    history.append({"role": "user", "content": req.content})

    executor = browser_manager.get_executor(req.client_id)
    try:
        reply = await run_agent(executor, history)
    except Exception as e:
        reply = f"分析过程中出错：{e}"

    history.append({"role": "assistant", "content": reply})

    conv.messages_json = json.dumps(history, ensure_ascii=False)
    if not conv.title and req.content:
        conv.title = req.content[:50]
    db.commit()

    return ChatResponse(conversation_id=conv.id, content=reply)


# ---- Chat Stream (SSE) ----

@router.post("/chat/stream")
async def chat_stream_endpoint(req: ChatRequest, db: Session = Depends(get_db)):
    """SSE 流式接口：实时返回 Agent 工具调用和回复"""
    if req.conversation_id:
        conv = db.query(Conversation).filter(Conversation.id == req.conversation_id).first()
        if not conv:
            raise HTTPException(404, "对话不存在")
        history = json.loads(conv.messages_json)
    else:
        conv = Conversation()
        db.add(conv)
        db.commit()
        db.refresh(conv)
        history = []

    history.append({"role": "user", "content": req.content})

    executor = browser_manager.get_executor(req.client_id)

    async def event_stream():
        full_reply = ""
        try:
            async for event in run_agent_stream(executor, history):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["type"] == "message":
                    full_reply += event["content"]
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

        # 保存对话
        history.append({"role": "assistant", "content": full_reply or "Agent 未生成回复"})
        conv.messages_json = json.dumps(history, ensure_ascii=False)
        if not conv.title and req.content:
            conv.title = req.content[:50]
        db.commit()

        yield f"data: {json.dumps({'type': 'done', 'conversation_id': conv.id}, ensure_ascii=False)}\n\n"

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
def list_conversations(db: Session = Depends(get_db)):
    convs = db.query(Conversation).order_by(Conversation.updated_at.desc()).limit(50).all()
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
    created_at: str | None


@router.get("/conversations/{conv_id}", response_model=ConversationDetail)
def get_conversation(conv_id: str, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "对话不存在")
    messages = json.loads(conv.messages_json)
    return ConversationDetail(
        id=conv.id,
        title=conv.title,
        messages=[MessageItem(**m) for m in messages],
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
        while True:
            data = await websocket.receive_json()
            browser_manager.handle_message(client_id, data)
    except WebSocketDisconnect:
        browser_manager.remove(client_id)
