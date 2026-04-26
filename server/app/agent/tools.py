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
    async def scroll_page(pixels: int = 500, selector: str = "", direction: str = "down") -> str:
        """滚动页面或指定元素，用于加载更多内容或定位到某个区域。

        Args:
            pixels: 滚动像素数，默认 500
            selector: CSS 选择器，定位要滚动的容器。留空则滚动整个页面。
            direction: 滚动方向，down（向下）或 up（向上），默认 down。
        """
        params: dict = {"pixels": pixels, "direction": direction}
        if selector:
            params["selector"] = selector
        return await _safe_exec("scroll", params)

    @tool
    async def get_page_content(selector: str = "", max_depth: int = 0) -> str:
        """获取页面的文本内容。用于提取笔记标题、点赞数等信息。

        Args:
            selector: CSS 选择器，限定提取范围。留空则提取整个页面。
            max_depth: 最大提取深度，0 表示不限制。
        """
        params: dict = {"selector": selector}
        if max_depth > 0:
            params["max_depth"] = max_depth
        return await _safe_exec("get_page_content", params)

    @tool
    async def get_dom_structure(selector: str = "body", depth: int = 3) -> str:
        """获取页面的 DOM 结构，用于了解页面布局和找到元素选择器。操作页面前应先调用此工具。

        Args:
            selector: CSS 选择器，留空则获取整个 body。
            depth: DOM 树深度，默认 3。
        """
        return await _safe_exec("get_dom_structure", {"selector": selector, "depth": depth})

    @tool
    async def extract_video_frames(selector: str, interval: int = 2):
        """提取页面视频的均匀抽帧画面。用于分析视频笔记的内容、画面风格、字幕设计等。
        返回多模态内容列表，包含视频元信息文本 + 每一帧的图片，让 LLM 能直接"看到"视频画面。

        **注意：调用前必须先用 `get_dom_structure` 或 `find_element_by_text` 定位到 video 元素的选择器。**

        Args:
            selector: CSS 选择器，定位具体 video 元素（必填）。
            interval: 抽帧间隔（秒），默认 2 秒一帧。
        """
        result = await _safe_exec("extract_video_frames", {"selector": selector, "interval": interval})
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
    async def capture_video_snapshot(selector: str, time: float = -1):
        """截取页面视频的画面。
        如果不指定 time，抓拍当前正在播放的画面（快速但可能有延迟偏差）。
        如果指定 time（秒），会先暂停视频、seek 到该时间点、确认帧加载后再截图，
        截图完成后自动恢复原来的播放进度和状态，精确无漂移。
        返回多模态图片，让 LLM 能直接"看到"视频画面。

        **注意：调用前必须先用 `get_dom_structure` 或 `find_element_by_text` 定位到 video 元素的选择器。**

        Args:
            selector: CSS 选择器，定位具体 video 元素（必填）。
            time: 要截取的时间点（秒）。小于 0 时抓拍当前画面。
        """
        params: dict = {"selector": selector}
        if time >= 0:
            params["time"] = time
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

    @tool
    async def scroll_to_element(selector: str) -> str:
        """平滑滚动到指定元素位置，使其位于视口中央。用于定位评论区、加载更多按钮、特定笔记等。

        Args:
            selector: CSS 选择器，定位目标元素
        """
        return await _safe_exec("scroll_to_element", {"selector": selector})

    @tool
    async def find_element_by_text(keyword: str, selector: str = "", nth: int = 1) -> str:
        """通过关键词在页面中查找元素，返回可用于 click/type 等操作的 CSS 选择器。

        当 Agent 从截图中看到某个按钮/文字但不知道其 CSS 选择器时调用。
        会按 textContent、aria-label、title、alt、placeholder 等属性匹配，
        返回分数最高且可见的元素的选择器。

        Args:
            keyword: 要匹配的关键词/文字，如"发布笔记"
            selector: 限定搜索范围的 CSS 选择器，留空则搜索整个页面
            nth: 如果多个元素匹配，取第几个（从 1 开始），默认第 1 个
        """
        params: dict = {"keyword": keyword, "nth": nth}
        if selector:
            params["selector"] = selector
        return await _safe_exec("find_element_by_text", params)

    @tool
    async def generate_report(title: str, content: str, fmt: str = "md") -> str:
        """生成可视化 HTML 分析报告并返回访问链接。

        当用户需要一份结构化、可分享的分析报告时调用此工具。
        支持 Markdown 自动转 HTML，或直接传入 HTML 代码。
        返回一个 URL，用户点击即可在新标签页查看完整报告。

        Args:
            title: 报告标题（如"减肥餐爆款分析报告"）
            content: 报告正文内容。fmt="md" 时为 Markdown，fmt="html" 时为原始 HTML 代码。
            fmt: 内容格式，"md" 或 "html"。默认 "md"。
        """
        from app.services.report import generate_html_report
        filename = generate_html_report(title, content, fmt)
        return f"报告已生成：http://localhost:8000/reports/{filename}"

    return [
        screenshot,
        click,
        hover,
        type_text,
        scroll_page,
        scroll_to_element,
        get_page_content,
        get_dom_structure,
        find_element_by_text,
        extract_video_frames,
        capture_video_snapshot,
        generate_report,
    ]
