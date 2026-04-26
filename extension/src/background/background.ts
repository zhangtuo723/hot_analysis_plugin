// Background service worker
// 1. 启动时连接后端 WebSocket
// 2. 收到工具命令时注入到页面执行
// 3. 截图请求处理
// 4. 点击图标打开独立浮动窗口（替代默认 popup，防止失焦关闭）

const WS_URL = "ws://localhost:8000/api/ws/browser";
const HEARTBEAT_ALARM = "xhs-heartbeat";

let clientId: string | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastPongAt: number = 0;

// 持久化 client_id：首次生成后写入 storage，后续重启读取已保存的值
function initClientId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["clientId"], (result) => {
      if (result.clientId) {
        clientId = result.clientId;
        resolve(result.clientId);
      } else {
        const newId = "xhs-ext-" + Math.random().toString(36).substring(2, 8);
        clientId = newId;
        chrome.storage.local.set({ clientId: newId }, () => {
          resolve(newId);
        });
      }
    });
  });
}

// ---- 独立窗口管理 ----

let popupWindowId: number | null = null;

chrome.action.onClicked.addListener(async () => {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 480,
    height: 560,
    focused: true,
  });

  if (win.id) {
    popupWindowId = win.id;
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// 禁止窗口 resize：尺寸变化时强制重置
chrome.windows.onBoundsChanged.addListener((win) => {
  if (win.id === popupWindowId && (win.width !== 480 || win.height !== 560)) {
    chrome.windows.update(win.id!, { width: 480, height: 560 });
  }
});

function connect() {
  if (!clientId) return;
  ws = new WebSocket(`${WS_URL}/${clientId}`);

  ws.onopen = () => {
    console.log("[XHS Agent] WebSocket connected, client_id:", clientId);
    lastPongAt = Date.now();
    // 启动心跳闹钟：每 30 秒触发一次（Chrome alarms 最小间隔）
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  };

  ws.onmessage = async (event) => {
    lastPongAt = Date.now();
    const data = JSON.parse(event.data);
    if (data.type === "tool_request") {
      await handleToolRequest(data);
    }
  };

  ws.onclose = () => {
    console.log("[XHS Agent] WebSocket closed, reconnecting...");
    chrome.alarms.clear(HEARTBEAT_ALARM);
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    chrome.alarms.clear(HEARTBEAT_ALARM);
    ws?.close();
  };
}

async function handleToolRequest(data: {
  request_id: string;
  tool: string;
  params: Record<string, string | number | boolean>;
}) {
  console.log(`[XHS Agent] handleToolRequest start: ${data.tool} ${data.request_id}`);
  try {
    // 找到小红书标签页：优先当前激活的，其次第一个匹配的
    const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
    const activeTab = tabs.find((t) => t.active);
    const tab = activeTab || tabs[0];
    if (!tab?.id) {
      sendToolResponse(data.request_id, false, "未找到小红书页面");
      return;
    }

    if (data.tool === "screenshot") {
      // 截图：用 JPEG 压缩 + 缩小尺寸，避免 token 爆炸
      // MV3 service worker 没有 Image 构造函数，改用 fetch + createImageBitmap
      const dataUrl = await new Promise<string>((resolve) => {
        chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, async (result) => {
          if (chrome.runtime.lastError || !result) {
            console.error("[XHS Agent] captureVisibleTab failed:", chrome.runtime.lastError);
            resolve("");
            return;
          }
          try {
            const blob = await (await fetch(result)).blob();
            const bitmap = await createImageBitmap(blob);
            const scale = Math.min(1, 800 / bitmap.width);
            const canvas = new OffscreenCanvas(
              Math.round(bitmap.width * scale),
              Math.round(bitmap.height * scale)
            );
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => resolve("");
            reader.readAsDataURL(outBlob);
          } catch (e) {
            console.error("[XHS Agent] screenshot processing failed:", e);
            resolve("");
          }
        });
      });
      sendToolResponse(data.request_id, !!dataUrl, dataUrl || "截图失败");
      return;
    }

    // 其他工具注入到页面执行
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    await new Promise((r) => setTimeout(r, 100));

    const response = await new Promise<{
      success: boolean;
      result?: string;
      error?: string;
    }>((resolve) => {
      const timer = setTimeout(() => {
        console.error(`[XHS Agent] ${data.tool} ${data.request_id} timeout after 30s`);
        resolve({ success: false, error: "工具执行超时（30秒）" });
      }, 30000);

      chrome.tabs.sendMessage(
        tab.id!,
        { action: "executeTool", tool: data.tool, params: data.params },
        (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            console.error(`[XHS Agent] ${data.tool} ${data.request_id} lastError:`, chrome.runtime.lastError.message);
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            const resultSize = resp?.result ? String(resp.result).length : 0;
            console.log(`[XHS Agent] ${data.tool} ${data.request_id} received result size=${resultSize} success=${resp?.success}`);
            resolve(resp || { success: false, error: "无响应" });
          }
        }
      );
    });

    if (response.success) {
      sendToolResponse(data.request_id, true, response.result || "");
    } else {
      sendToolResponse(data.request_id, false, response.error || "工具执行失败");
    }
  } catch (e) {
    console.error(`[XHS Agent] ${data.tool} ${data.request_id} exception:`, e);
    sendToolResponse(data.request_id, false, String(e));
  }
}

function sendToolResponse(
  requestId: string,
  success: boolean,
  payload: string
) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const body: Record<string, unknown> = {
      type: "tool_response",
      request_id: requestId,
      success,
    };
    // 成功放 result，失败放 error，避免后端把错误当成正常结果
    if (success) {
      body.result = payload;
    } else {
      body.error = payload;
    }
    const json = JSON.stringify(body);
    console.log(`[XHS Agent] sendToolResponse ${requestId} size=${json.length} success=${success}`);
    ws.send(json);
  } else {
    console.error(`[XHS Agent] sendToolResponse ${requestId} FAILED: WS not open (readyState=${ws?.readyState})`);
  }
}

// Popup 请求获取 client_id
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getClientId") {
    sendResponse({ clientId });
    return;
  }

  if (msg.action === "getConnectionStatus") {
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
    return;
  }

  if (msg.action === "keepalive") {
    // content script 定期发来的心跳，什么都不做，只要收到消息 Service Worker 就不会休眠
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "reconnect") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    }
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
    return;
  }
});

// 心跳闹钟：每 15 秒触发一次，防止 Service Worker 休眠断连
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;

  // 超过 45 秒没收到任何消息（含 pong），说明连接已死，强制断开重连
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastPongAt > 45000) {
    console.log("[XHS Agent] Heartbeat timeout, forcing reconnect...");
    ws.close();
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "ping", client_id: clientId }));
    } catch {
      ws.close();
    }
  } else {
    // 连接已断开：取消等待中的延迟重连，立即重连
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }
});

initClientId().then(() => connect());
