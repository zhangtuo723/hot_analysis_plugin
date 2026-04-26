"""浏览器操作工具 - 使用 LangChain @tool 装饰器，独立可测试"""

from __future__ import annotations

import json
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
    async def hover(selector: str) -> str:
        """将鼠标悬停在指定元素上，触发 hover 状态。用于显示隐藏的按钮（如图片轮播的左右箭头）、下拉菜单等。

        Args:
            selector: CSS 选择器
        """
        return await _safe_exec("hover", {"selector": selector})

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

    @tool
    async def extract_video_frames(interval: int = 2, selector: str = ""):
        """提取页面视频的均匀抽帧画面。用于分析视频笔记的内容、画面风格、字幕设计等。
        返回多模态内容列表，包含视频元信息文本 + 每一帧的图片，让 LLM 能直接"看到"视频画面。

        Args:
            interval: 抽帧间隔（秒），默认 2 秒一帧。
            selector: CSS 选择器，定位具体 video 元素。留空则自动找页面上最大的视频。
        """
        params: dict = {"interval": interval}
        if selector:
            params["selector"] = selector
        result = await _safe_exec("extract_video_frames", params)
        if result.startswith("Error:"):
            return [{"type": "text", "text": result}]
        try:
            data = json.loads(result)
            info = data.get("video_info", {})
            frames = data.get("frames", [])
            frame_count = data.get("frame_count", len(frames))
            duration = info.get("duration", "?")
            content: list[dict] = [
                {
                    "type": "text",
                    "text": (
                        f"视频抽帧结果：共 {frame_count} 帧，"
                        f"时长 {duration}s，分辨率 {info.get('width', '?')}x{info.get('height', '?')}"
                    ),
                }
            ]
            for frame in frames:
                data_url = frame.get("data_url", "")
                if data_url:
                    content.append(
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url},
                        }
                    )
            return content
        except Exception:
            pass
        return [{"type": "text", "text": result}]

    @tool
    async def capture_video_snapshot(time: float = -1, selector: str = ""):
        """截取页面视频的画面。
        如果不指定 time，抓拍当前正在播放的画面（快速但可能有延迟偏差）。
        如果指定 time（秒），会先暂停视频、seek 到该时间点、确认帧加载后再截图，
        截图完成后自动恢复原来的播放进度和状态，精确无漂移。
        返回多模态图片，让 LLM 能直接"看到"视频画面。

        Args:
            time: 要截取的时间点（秒）。小于 0 时抓拍当前画面。
            selector: CSS 选择器，定位具体 video 元素。留空则自动找页面上最大的视频。
        """
        params: dict = {}
        if time >= 0:
            params["time"] = time
        if selector:
            params["selector"] = selector
        result = await _safe_exec("capture_video_snapshot", params)
        if result.startswith("Error:"):
            return [{"type": "text", "text": result}]
        try:
            data = json.loads(result)
            snapshot = data.get("snapshot", {})
            data_url = snapshot.get("data_url", "")
            if data_url:
                info = data.get("video_info", {})
                current = snapshot.get("time", info.get("currentTime", "?"))
                text = f"视频快照 @ {current}s / {info.get('duration', '?')}s"
                return [
                    {"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]
        except Exception:
            pass
        return [{"type": "text", "text": result}]

    return [
        screenshot,
        click,
        hover,
        type_text,
        scroll_page,
        get_page_content,
        get_dom_structure,
        extract_video_frames,
        capture_video_snapshot,
    ]
