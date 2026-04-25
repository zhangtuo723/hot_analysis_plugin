"""浏览器操作工具 - 使用 LangChain @tool 装饰器，独立可测试"""

from __future__ import annotations

from typing import Callable, Awaitable
from langchain_core.tools import tool


def create_browser_tool(executor: Callable[..., Awaitable[str]]):
    """创建所有浏览器工具，注入 WebSocket 执行器。

    所有工具内部都有 try-except 兜底：无论底层（WebSocket / content script）
    抛什么异常，都会变成字符串返回给 Agent，绝不因工具失败而中断 Agent 流程。
    """

    async def _safe_exec(tool: str, params: dict) -> str:
        try:
            return await executor(tool, params)
        except Exception as e:
            return f"Error: {e}"

    @tool
    async def screenshot():
        """截取当前浏览器页面的截图。用于查看页面当前状态、确认操作效果。返回 JPEG 格式图片。"""
        result = await _safe_exec("screenshot", {})
        if result.startswith("Error:"):
            # 执行失败，返回文本错误信息（多模态格式），让 Agent 决定下一步
            return [{"type": "text", "text": result}]
        # 返回多模态 content list，让 LLM 能直接"看到"图片
        return [{"type": "image_url", "image_url": {"url": result}}]

    @tool
    async def click(selector: str) -> str:
        """点击页面上的元素。

        Args:
            selector: CSS 选择器，如 '#search-input', '.search-btn'
        """
        return await _safe_exec("click", {"selector": selector})

    @tool
    async def type_text(selector: str, text: str, submit: bool = False) -> str:
        """在输入框中输入文字，可选是否按回车提交。

        Args:
            selector: CSS 选择器
            text: 要输入的文字
            submit: 输入后是否按回车提交，默认 False
        """
        return await _safe_exec("type", {"selector": selector, "text": text, "submit": submit})

    @tool
    async def scroll_page(pixels: int = 500) -> str:
        """向下滚动页面，用于加载更多内容。

        Args:
            pixels: 滚动像素数，默认 500
        """
        return await _safe_exec("scroll", {"pixels": pixels})

    @tool
    async def get_page_content(selector: str = "") -> str:
        """获取页面的文本内容。用于提取笔记标题、点赞数等信息。

        Args:
            selector: CSS 选择器，限定提取范围。留空则提取整个页面。
        """
        return await _safe_exec("get_page_content", {"selector": selector})

    @tool
    async def get_dom_structure(selector: str = "body", depth: int = 3) -> str:
        """获取页面的 DOM 结构，用于了解页面布局和找到元素选择器。操作页面前应先调用此工具。

        Args:
            selector: CSS 选择器，留空则获取整个 body。
            depth: DOM 树深度，默认 3。
        """
        return await _safe_exec("get_dom_structure", {"selector": selector, "depth": depth})

    return [screenshot, click, type_text, scroll_page, get_page_content, get_dom_structure]
