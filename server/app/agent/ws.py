"""WebSocket 管理器 - 后端与扩展之间的浏览器工具执行通道"""

from __future__ import annotations

import asyncio
import uuid
from typing import Awaitable, Callable

from fastapi import WebSocket


class BrowserConnection:
    """管理一个扩展 WebSocket 连接"""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self._pending: dict[str, asyncio.Future] = {}

    async def execute(self, tool: str, params: dict) -> str:
        """发送工具命令，等待结果"""
        request_id = f"{tool}_{uuid.uuid4().hex}"
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        await self.ws.send_json({
            "type": "tool_request",
            "request_id": request_id,
            "tool": tool,
            "params": params,
        })

        try:
            return await asyncio.wait_for(future, timeout=60)
        finally:
            self._pending.pop(request_id, None)

    def handle_response(self, data: dict):
        """处理扩展返回的工具结果"""
        request_id = data.get("request_id", "")
        future = self._pending.get(request_id)
        if future and not future.done():
            if data.get("success"):
                future.set_result(data.get("result", ""))
            else:
                # 扩展端在失败时把真实错误塞在 result 字段（见 background.ts sendToolResponse），
                # 这里优先取 result，兼容 error 字段，最后才用兜底文案。
                err_msg = (
                    data.get("error")
                    or data.get("result")
                    or "工具执行失败"
                )
                future.set_exception(Exception(err_msg))

    async def close(self):
        """取消所有 pending future 并关闭 websocket"""
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
        try:
            await self.ws.close()
        except Exception:
            pass


class BrowserToolManager:
    """管理所有扩展连接，提供工具执行器"""

    def __init__(self):
        self._connections: dict[str, BrowserConnection] = {}
        self.shutdown_event = asyncio.Event()

    def add(self, client_id: str, ws: WebSocket):
        self._connections[client_id] = BrowserConnection(ws)

    def remove(self, client_id: str, ws=None):
        """移除连接。如果传入 ws，只移除匹配该 WebSocket 对象的连接，防止旧连接误删新连接。"""
        if ws is not None:
            conn = self._connections.get(client_id)
            if conn and conn.ws is ws:
                self._connections.pop(client_id, None)
        else:
            self._connections.pop(client_id, None)

    def handle_message(self, client_id: str, data: dict):
        conn = self._connections.get(client_id)
        if conn:
            conn.handle_response(data)

    def get_executor(self, client_id: str) -> Callable[..., Awaitable[str]]:
        """返回给 Agent 用的工具执行器"""
        async def executor(tool: str, params: dict) -> str:
            conn = self._connections.get(client_id)
            if not conn:
                raise RuntimeError("浏览器连接不存在，请确保扩展已连接")
            return await conn.execute(tool, params)
        return executor

    async def close_all(self):
        """关闭所有 WebSocket 连接（优雅退出用）"""
        self.shutdown_event.set()
        for conn in list(self._connections.values()):
            await conn.close()
        self._connections.clear()


# 全局单例
browser_manager = BrowserToolManager()
