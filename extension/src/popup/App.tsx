import { useState, useRef, useEffect } from "react";
import type { ChatMessage } from "../types";

const API_BASE = "http://localhost:8000";

interface ToolCallItem {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  result?: string;
  status: "running" | "done" | "error";
  expanded?: boolean;
}

function App() {
  const [clientId, setClientId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "你好！我是小红书爆款分析助手\n\n告诉我你想分析什么关键词，我会自动操作浏览器抓取数据并分析爆款规律。",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 获取 client_id 和连接状态
  useEffect(() => {
    chrome.runtime.sendMessage({ action: "getClientId" }, (resp) => {
      if (resp?.clientId) setClientId(resp.clientId);
    });
    const checkConn = () => {
      chrome.runtime.sendMessage({ action: "getConnectionStatus" }, (resp) => {
        setConnected(resp?.connected || false);
      });
    };
    checkConn();
    const timer = setInterval(checkConn, 3000);
    return () => clearInterval(timer);
  }, []);

  // 恢复对话：从后端拿全量数据（消息 + 工具调用记录）
  useEffect(() => {
    chrome.storage.local.get(["conversationId"], async (result) => {
      const cid = result.conversationId as string | undefined;
      if (cid) {
        try {
          const resp = await fetch(`${API_BASE}/api/conversations/${cid}`);
          if (resp.ok) {
            const data = await resp.json();
            setConversationId(cid);
            setMessages(data.messages);
            if (data.tool_calls) setToolCalls(data.tool_calls);
          }
        } catch {
          /* ignore */
        }
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (conversationId) chrome.storage.local.set({ conversationId });
  }, [conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolCalls]);

  const stopGeneration = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    if (!connected) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "未连接到后端，请确保后端服务正在运行。" },
      ]);
      return;
    }

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setToolCalls([]);

    // 添加一个空的 AI 消息占位，用于流式填充
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    abortRef.current = new AbortController();

    try {
      const resp = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          client_id: clientId,
          content: text,
        }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`请求失败: ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalConvId: string | null = null;
      let gotDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") continue;

          try {
            const event = JSON.parse(dataStr);
            handleStreamEvent(event, finalConvId);
            if (event.type === "done" && event.conversation_id) {
              finalConvId = event.conversation_id;
              gotDone = true;
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      }

      if (finalConvId) {
        setConversationId(finalConvId);
      }

      // 如果未收到 done 且被中断，标记为已停止
      if (!gotDone && abortRef.current?.signal.aborted) {
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.role === "assistant" && !updated[lastIdx].content) {
            updated[lastIdx] = { role: "assistant", content: "（已停止生成）" };
          }
          return updated;
        });
        setToolCalls((prev) =>
          prev.map((t) => (t.status === "running" ? { ...t, status: "error", result: "已取消" } : t))
        );
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        // 用户主动停止，已在上面处理
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.role === "assistant") {
            updated[lastIdx] = { role: "assistant", content: `请求失败：${err.message}` };
          }
          return updated;
        });
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  const handleStreamEvent = (event: Record<string, unknown>, _convId: string | null) => {
    switch (event.type) {
      case "tool_start": {
        const tool = String(event.tool || "unknown");
        const params = (event.params as Record<string, unknown>) || {};
        setToolCalls((prev) => [
          ...prev,
          { id: `${tool}_${Date.now()}`, tool, params, status: "running" },
        ]);
        break;
      }
      case "tool_result": {
        const tool = String(event.tool || "");
        const result = String(event.result || "");
        setToolCalls((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].tool === tool && updated[i].status === "running") {
              updated[i] = { ...updated[i], result, status: "done" };
              break;
            }
          }
          return updated;
        });
        break;
      }
      case "message": {
        const content = String(event.content || "");
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.role === "assistant") {
            updated[lastIdx] = {
              role: "assistant",
              content: updated[lastIdx].content + content,
            };
          }
          return updated;
        });
        break;
      }
      case "error": {
        const msg = String(event.message || "未知错误");
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.role === "assistant") {
            updated[lastIdx] = { role: "assistant", content: msg };
          }
          return updated;
        });
        break;
      }
      case "done": {
        setToolCalls((prev) =>
          prev.map((t) => (t.status === "running" ? { ...t, status: "error", result: "未返回结果" } : t))
        );
        break;
      }
    }
  };

  const toggleToolExpand = (id: string) => {
    setToolCalls((prev) =>
      prev.map((t) => (t.id === id ? { ...t, expanded: !t.expanded } : t))
    );
  };

  const clearChat = async () => {
    if (conversationId) {
      fetch(`${API_BASE}/api/conversations/${conversationId}`, { method: "DELETE" }).catch(() => {});
    }
    setConversationId(null);
    setMessages([
      {
        role: "assistant",
        content:
          "你好！我是小红书爆款分析助手\n\n告诉我你想分析什么关键词，我会自动操作浏览器抓取数据并分析爆款规律。",
      },
    ]);
    setToolCalls([]);
    chrome.storage.local.remove("conversationId");
  };

  const formatParamsSummary = (tool: string, params: Record<string, unknown>): string => {
    if (tool === "type_text") {
      const text = String(params.text || "");
      return `"${text.slice(0, 15)}${text.length > 15 ? "..." : ""}"`;
    }
    if (tool === "click") {
      return String(params.selector || "");
    }
    if (tool === "scroll_page") {
      return `${params.pixels || 500}px`;
    }
    if (tool === "get_dom_structure") {
      return String(params.selector || "body");
    }
    if (tool === "get_page_content") {
      return String(params.selector || "body");
    }
    return "";
  };

  if (!ready) return null;

  return (
    <div className="flex flex-col h-[600px] w-[400px] bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-red-50">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold text-red-600">小红书爆款分析</h1>
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-gray-300"}`} />
        </div>
        <button onClick={clearChat} className="text-xs text-gray-400 hover:text-gray-600">
          新对话
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === "assistant" && i > 0 && messages[i - 1].role === "user" && toolCalls.length > 0 && (
              <div className="mb-2 space-y-1">
                <div className="text-[10px] text-gray-400 font-medium">Agent 执行记录</div>
                {toolCalls.map((tc) => (
                  <div
                    key={tc.id}
                    onClick={() => toggleToolExpand(tc.id)}
                    className="cursor-pointer border rounded-md bg-white hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2 px-2 py-1">
                      <span className="text-xs">
                        {tc.status === "running" ? "⏳" : tc.status === "done" ? "✅" : "❌"}
                      </span>
                      <span className="text-xs font-medium text-gray-700">{tc.tool}</span>
                      <span className="text-[10px] text-gray-400 truncate flex-1">
                        {formatParamsSummary(tc.tool, tc.params)}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {tc.expanded ? "▲" : "▼"}
                      </span>
                    </div>
                    {tc.expanded && (
                      <div className="px-2 pb-1.5 space-y-1 max-h-48 overflow-y-auto">
                        <div className="text-[10px] text-gray-500 bg-gray-50 rounded px-1.5 py-1">
                          <div className="font-medium text-gray-600">参数：</div>
                          <pre className="whitespace-pre-wrap break-all">
                            {JSON.stringify(tc.params, null, 2)}
                          </pre>
                        </div>
                        {tc.result && (
                          <div className="text-[10px] text-gray-500 bg-gray-50 rounded px-1.5 py-1">
                            <div className="font-medium text-gray-600">结果：</div>
                            <ToolResultContent result={tc.result} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap leading-relaxed ${
                  msg.role === "user"
                    ? "bg-red-500 text-white"
                    : msg.content
                    ? "bg-gray-100 text-gray-800"
                    : "bg-gray-50 text-gray-400 italic"
                }`}
              >
                {msg.content || (loading && msg.role === "assistant" ? "思考中..." : "")}
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t px-3 py-2.5 bg-white">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && sendMessage()}
            placeholder="输入消息，如：帮我分析减肥餐的爆款规律"
            disabled={loading}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-red-400 disabled:bg-gray-50"
          />
          {loading ? (
            <button
              onClick={stopGeneration}
              className="px-3 py-2 bg-gray-500 text-white text-sm rounded-lg hover:bg-gray-600"
            >
              停止
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim()}
              className="px-3 py-2 bg-red-500 text-white text-sm rounded-lg hover:bg-red-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolResultContent({ result }: { result: string }) {
  const parts: React.ReactNode[] = [];
  const regex = /\[图片: ([^\]]+)\]/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(result)) !== null) {
    const textBefore = result.slice(lastIndex, match.index);
    if (textBefore) {
      parts.push(
        <span key={key++} className="whitespace-pre-wrap break-all">{textBefore}</span>
      );
    }
    parts.push(
      <img
        key={key++}
        src={match[1]}
        alt="tool-result"
        className="max-w-full rounded border mt-1"
        style={{ maxHeight: 200 }}
      />
    );
    lastIndex = regex.lastIndex;
  }

  const textAfter = result.slice(lastIndex);
  if (textAfter) {
    parts.push(
      <span key={key++} className="whitespace-pre-wrap break-all">{textAfter}</span>
    );
  }

  return <>{parts}</>;
}

export default App;
