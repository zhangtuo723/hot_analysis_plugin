"""Deep Agent - 基于 deepagents create_deep_agent + ChatMoonshot + LangGraph checkpoint"""

from __future__ import annotations

from pathlib import Path
from typing import Awaitable, Callable

import aiosqlite
from langchain_moonshot import ChatMoonshot
from deepagents import create_deep_agent
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.backends.composite import CompositeBackend
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from app.config import settings
from app.agent.tools import create_browser_tool

CHECKPOINT_DB_PATH = str(
    Path(__file__).resolve().parent.parent.parent / "agent_checkpoints.db"
)

_checkpointer: AsyncSqliteSaver | None = None


async def _get_checkpointer() -> AsyncSqliteSaver:
    """延迟初始化 AsyncSqliteSaver（单例）"""
    global _checkpointer
    if _checkpointer is None:
        conn = await aiosqlite.connect(CHECKPOINT_DB_PATH)
        _checkpointer = AsyncSqliteSaver(conn)
    return _checkpointer


async def close_checkpointer() -> None:
    """关闭 checkpointer 的 sqlite 连接（优雅退出用）"""
    global _checkpointer
    if _checkpointer is not None:
        await _checkpointer.conn.close()
        _checkpointer = None

SYSTEM_PROMPT = """你是小红书爆款分析助手，也是通用浏览器操作 Agent。

**核心能力**
- 操控浏览器：点击、输入、滚动、截图、提取页面内容、获取 DOM 结构
- 多模态感知：screenshot 和视频抽帧工具会返回图片，你可以直接"看到"页面当前状态
- 执行 Skill：涉及小红书爆款分析时，按需加载 xhs skill 获取完整指令

**工作原则**
1. **先观察再行动**：操作页面前先用 screenshot 或 get_dom_structure 确认当前状态
2. **韧性执行**：工具报错（元素未找到、操作失败）时，换选择器或换方法继续，绝不中断任务
3. **基于视觉反馈调整**：截图后发现页面不对（如弹窗遮挡、加载中、跳转错误），主动处理后再继续
4. **CSS 选择器规范**：只使用标准语法（#id、.class、[attr='value']、:nth-child(n)），禁止 jQuery 伪类如 :contains()
5. **完成时输出结构化总结**：不要只回复"完成了"，要给出关键发现、数据结论或可执行建议"""


def create_agent(
    browser_executor: Callable[..., Awaitable[str]], checkpointer: AsyncSqliteSaver
):
    """创建 Deep Agent"""
    tools = create_browser_tool(browser_executor)

    llm = ChatMoonshot(
        model=settings.kimi_model,
        api_key=settings.kimi_api_key,
        base_url=settings.kimi_base_url,
        default_headers={
            "X-Client-Name": "claude-code",
            "User-Agent": "claude-code/1.0.0",
        },
        temperature=0.7,
    )

    root_dir = Path(__file__).resolve().parent.parent.parent
    skills_dir = root_dir / "skills"
    workspace_dir = root_dir / "workspace"
    workspace_dir.mkdir(exist_ok=True)

    backend = CompositeBackend(
        default=FilesystemBackend(root_dir=str(workspace_dir), virtual_mode=True),
        routes={
            "/skills/": FilesystemBackend(root_dir=str(skills_dir), virtual_mode=True),
        },
        artifacts_root="/workspace/",
    )

    return create_deep_agent(
        model=llm,
        tools=tools,
        system_prompt=SYSTEM_PROMPT,
        skills=["/skills/"],
        backend=backend,
        checkpointer=checkpointer,
    )


async def run_agent(
    browser_executor: Callable[..., Awaitable[str]],
    messages: list[dict],
    thread_id: str,
) -> str:
    """运行 Agent，返回最终回复文本。

    Args:
        browser_executor: 浏览器工具执行器
        messages: 当前轮次的消息（LangGraph 会从 checkpoint 自动恢复历史）
        thread_id: 对话线程 ID（对应 conversation_id）
    """
    checkpointer = await _get_checkpointer()
    agent = create_agent(browser_executor, checkpointer)

    langchain_messages = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            langchain_messages.append(("user", content))
        elif role == "assistant":
            langchain_messages.append(("assistant", content))

    result = await agent.ainvoke(
        {"messages": langchain_messages},
        config={"configurable": {"thread_id": thread_id}},
    )

    ai_messages = [m for m in result["messages"] if m.type == "ai"]
    if ai_messages:
        return ai_messages[-1].content

    return "Agent 未生成回复"


async def run_agent_stream(
    browser_executor: Callable[..., Awaitable[str]],
    messages: list[dict],
    thread_id: str,
):
    """运行 Agent，流式 yield 中间事件。

    Args:
        browser_executor: 浏览器工具执行器
        messages: 当前轮次的消息（LangGraph 会从 checkpoint 自动恢复历史）
        thread_id: 对话线程 ID（对应 conversation_id）

    Yields:
        {"type": "tool_start", "tool": str, "params": dict}
        {"type": "tool_result", "tool": str, "result": str}
        {"type": "message", "content": str}
        {"type": "error", "message": str}
        {"type": "done"}
    """
    checkpointer = await _get_checkpointer()
    agent = create_agent(browser_executor, checkpointer)

    langchain_messages = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            langchain_messages.append(("user", content))
        elif role == "assistant":
            langchain_messages.append(("assistant", content))

    tool_call_map: dict[str, str] = {}

    try:
        async for chunk in agent.astream(
            {"messages": langchain_messages},
            config={"configurable": {"thread_id": thread_id}},
        ):
            for node_name, node_output in chunk.items():
                # 忽略中间件节点
                if "Middleware" in node_name:
                    continue

                if node_name == "model" and isinstance(node_output, dict):
                    for msg in node_output.get("messages", []):
                        # Tool call 意图
                        if hasattr(msg, "tool_calls") and msg.tool_calls:
                            for tc in msg.tool_calls:
                                tool_name = tc.get(
                                    "name",
                                    tc.get("function", {}).get("name", "unknown"),
                                )
                                tool_id = tc.get("id", "")
                                if tool_id:
                                    tool_call_map[tool_id] = tool_name
                                yield {
                                    "type": "tool_start",
                                    "tool": tool_name,
                                    "params": tc.get(
                                        "args",
                                        tc.get("function", {}).get("arguments", {}),
                                    ),
                                }
                        # AI 回复内容（最终回复，无 tool_calls）
                        elif msg.content:
                            yield {"type": "message", "content": msg.content}

                elif node_name == "tools" and isinstance(node_output, dict):
                    for msg in node_output.get("messages", []):
                        # 获取工具名：优先 msg.name，其次通过 tool_call_id 查表
                        tool_name = None
                        if hasattr(msg, "name") and msg.name:
                            tool_name = msg.name
                        elif hasattr(msg, "tool_call_id") and msg.tool_call_id:
                            tool_name = tool_call_map.get(msg.tool_call_id)

                        if tool_name:
                            # 处理多模态结果（如 screenshot 返回的 image_url list）
                            if isinstance(msg.content, list):
                                result_parts = []
                                for block in msg.content:
                                    if (
                                        isinstance(block, dict)
                                        and block.get("type") == "image_url"
                                    ):
                                        result_parts.append(
                                            f"[图片: {block.get('image_url', {}).get('url', '')}]"
                                        )
                                    elif (
                                        isinstance(block, dict)
                                        and block.get("type") == "text"
                                    ):
                                        result_parts.append(
                                            block.get("text", "")
                                        )
                                result_text = " ".join(result_parts)
                            else:
                                result_text = str(msg.content)
                            yield {
                                "type": "tool_result",
                                "tool": tool_name,
                                "result": result_text,
                            }

        yield {"type": "done"}

    except Exception as e:
        yield {"type": "error", "message": f"Agent 运行出错：{e}"}
        yield {"type": "done"}
