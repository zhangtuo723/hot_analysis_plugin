// Background service worker
// 1. 启动时连接后端 WebSocket
// 2. 收到工具命令时注入到页面执行
// 3. 截图请求处理

const WS_URL = "ws://localhost:8000/api/ws/browser";
const CLIENT_ID = "xhs-ext-" + Math.random().toString(36).substring(2, 8);

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect() {
  ws = new WebSocket(`${WS_URL}/${CLIENT_ID}`);

  ws.onopen = () => {
    console.log("[XHS Agent] WebSocket connected, client_id:", CLIENT_ID);
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "tool_request") {
      await handleToolRequest(data);
    }
  };

  ws.onclose = () => {
    console.log("[XHS Agent] WebSocket closed, reconnecting...");
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

async function handleToolRequest(data: {
  request_id: string;
  tool: string;
  params: Record<string, string | number | boolean>;
}) {
  try {
    // 找到小红书标签页
    const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
    const tab = tabs[0];
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
      chrome.tabs.sendMessage(
        tab.id!,
        { action: "executeTool", tool: data.tool, params: data.params },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
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
    sendToolResponse(data.request_id, false, String(e));
  }
}

function sendToolResponse(
  requestId: string,
  success: boolean,
  result: string
) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "tool_response",
        request_id: requestId,
        success,
        result,
      })
    );
  }
}

// Popup 请求获取 client_id
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getClientId") {
    sendResponse({ clientId: CLIENT_ID });
    return;
  }

  if (msg.action === "getConnectionStatus") {
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
    return;
  }
});

connect();
