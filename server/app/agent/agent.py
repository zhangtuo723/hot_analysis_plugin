"""Deep Agent - 基于 deepagents create_deep_agent + ChatMoonshot"""

from __future__ import annotations

from typing import Awaitable, Callable

from langchain_moonshot import ChatMoonshot
from deepagents import create_deep_agent

from app.config import settings
from app.agent.tools import create_browser_tool

SYSTEM_PROMPT = """你是小红书爆款内容分析专家，同时也是一个可以操控浏览器的 Agent。

你可以通过工具来操作浏览器页面，获取小红书上的数据并进行分析。

**重要操作规范：**
1. 每个操作后，工具会自动等待页面稳定（检测 loading 消失和 DOM 高度稳定）
2. type_text 提交搜索后，工具内部已等待 4 秒让页面跳转和笔记列表加载
3. scroll_page 滚动后，工具内部已等待 2 秒让懒加载内容出现
4. 如果获取到的内容看起来不完整或包含 loading 状态，请用 screenshot 截图确认页面实际状态
5. **CSS 选择器必须使用标准语法**：如 `#id`、`.class`、`[attr='value']`、`:nth-child(n)`。**不要使用 jQuery 语法如 `:contains('文本')`**。如果要找包含特定文本的元素，先获取 DOM 结构查看实际 class 和属性
6. **如果工具返回了错误信息（如 Error: Element not found），不要中断任务**。分析错误原因，换一种选择器或方法继续尝试，直到成功

**标准工作流程：**
1. 先用 get_dom_structure 了解页面结构，找到搜索框等关键元素
2. 用 type_text 在搜索框输入关键词（submit=true 提交搜索）——工具会自动等待页面加载
3. 用 screenshot 查看搜索结果页是否加载完成
4. 用 scroll_page 滚动加载更多内容——工具会自动等待
5. 用 get_page_content 提取页面上的笔记数据
6. 基于提取的数据进行深度分析

**分析维度包括：** 爆款共性、标题套路、封面风格、用户真实需求、蓝海机会、可复制选题等。

请用中文分析，结构清晰，重点突出。"""


def create_agent(browser_executor: Callable[..., Awaitable[str]]):
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

    return create_deep_agent(
        model=llm,
        tools=tools,
        system_prompt=SYSTEM_PROMPT,
    )


async def run_agent(
    browser_executor: Callable[..., Awaitable[str]],
    messages: list[dict],
) -> str:
    """运行 Agent，返回最终回复文本"""
    agent = create_agent(browser_executor)

    langchain_messages = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            langchain_messages.append(("user", content))
        elif role == "assistant":
            langchain_messages.append(("assistant", content))

    result = await agent.ainvoke({"messages": langchain_messages})

    ai_messages = [m for m in result["messages"] if m.type == "ai"]
    if ai_messages:
        return ai_messages[-1].content

    return "Agent 未生成回复"


async def run_agent_stream(
    browser_executor: Callable[..., Awaitable[str]],
    messages: list[dict],
):
    """运行 Agent，流式 yield 中间事件

    Yields:
        {"type": "tool_start", "tool": str, "params": dict}
        {"type": "tool_result", "tool": str, "result": str}
        {"type": "message", "content": str}
        {"type": "error", "message": str}
        {"type": "done"}
    """
    agent = create_agent(browser_executor)

    langchain_messages = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            langchain_messages.append(("user", content))
        elif role == "assistant":
            langchain_messages.append(("assistant", content))

    # 记录 tool_call_id -> tool_name，用于工具异常时匹配
    tool_call_map: dict[str, str] = {}

    try:
        async for chunk in agent.astream({"messages": langchain_messages}):
            for node_name, node_output in chunk.items():
                # 忽略中间件节点
                if "Middleware" in node_name:
                    continue

                if node_name == "model" and isinstance(node_output, dict):
                    for msg in node_output.get("messages", []):
                        # Tool call 意图
                        if hasattr(msg, "tool_calls") and msg.tool_calls:
                            for tc in msg.tool_calls:
                                tool_name = tc.get("name", tc.get("function", {}).get("name", "unknown"))
                                tool_id = tc.get("id", "")
                                if tool_id:
                                    tool_call_map[tool_id] = tool_name
                                yield {
                                    "type": "tool_start",
                                    "tool": tool_name,
                                    "params": tc.get("args", tc.get("function", {}).get("arguments", {})),
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
                                    if isinstance(block, dict) and block.get("type") == "image_url":
                                        url = block.get("image_url", {}).get("url", "")
                                        if url.startswith("data:image"):
                                            result_parts.append(f"[图片: {url}]")
                                        else:
                                            result_parts.append(f"[图片: {url}]")
                                    elif isinstance(block, dict) and block.get("type") == "text":
                                        result_parts.append(block.get("text", ""))
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
