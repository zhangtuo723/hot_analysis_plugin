import { useState, useRef, useEffect } from "react";
import { marked } from "marked";
import type { ChatMessage } from "../types";

const API_BASE = "http://localhost:8000";

interface ConversationItem {
  id: string;
  title: string;
  created_at: string | null;
}

function App() {
  const [clientId, setClientId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<"home" | "chat">("home");

  // home
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // chat
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skipScrollRef = useRef(false);

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

  // home: 加载历史列表
  useEffect(() => {
    if (view !== "home" || !clientId) return;
    loadConversations();
  }, [view, clientId]);

  async function loadConversations() {
    setLoadingList(true);
    try {
      const resp = await fetch(`${API_BASE}/api/conversations?user_id=${clientId}`);
      if (resp.ok) {
        const data = await resp.json();
        setConversations(data);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingList(false);
    }
  }

  async function openConversation(cid: string) {
    try {
      const resp = await fetch(`${API_BASE}/api/conversations/${cid}`);
      if (resp.ok) {
        const data = await resp.json();
        setConversationId(cid);
        const msgs: ChatMessage[] = data.messages.length > 0 ? data.messages : [
          {
            role: "assistant",
            content:
              "你好！我是小红书爆款分析助手\n\n告诉我你想分析什么关键词，我会自动操作浏览器抓取数据并分析爆款规律。",
          },
        ];
        setMessages(msgs);
        setView("chat");
      }
    } catch {
      /* ignore */
    }
  }

  function startNewChat() {
    setConversationId(null);
    setMessages([
      {
        role: "assistant",
        content:
          "你好！我是小红书爆款分析助手\n\n告诉我你想分析什么关键词，我会自动操作浏览器抓取数据并分析爆款规律。",
      },
    ]);
    setInput("");
    setView("chat");
  }

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const stopGeneration = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    // 如果未连接，先尝试唤醒 background 并重连
    if (!connected) {
      let ok = false;
      try {
        const status = await chrome.runtime.sendMessage({ action: "reconnect" });
        if (status?.connected) {
          ok = true;
          setConnected(true);
        } else {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const check = await chrome.runtime.sendMessage({ action: "getConnectionStatus" });
            if (check?.connected) {
              ok = true;
              setConnected(true);
              break;
            }
          }
        }
      } catch {
        /* ignore */
      }
      if (!ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "未连接到后端，请确保扩展已启用且后端服务正在运行。" },
        ]);
        return;
      }
    }

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);

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

      // 如果未收到 done 且被中断
      if (!gotDone && abortRef.current?.signal.aborted) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant" && !last.content) {
            updated[updated.length - 1] = { ...last, content: "（已停止生成）" };
          } else if (last?.role !== "assistant") {
            updated.push({ role: "assistant", content: "（已停止生成）" });
          }
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === "tool" && updated[i].status === "running") {
              updated[i] = { ...updated[i], status: "error", content: "已取消" };
            }
          }
          return updated;
        });
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        // 用户主动停止，已在上面处理
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: `请求失败：${err.message}` };
          } else {
            updated.push({ role: "assistant", content: `请求失败：${err.message}` });
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
        // 优先用后端 LLM tool_call_id 做唯一键，缺失时退化为带随机串的合成 id
        const eventId = event.id ? String(event.id) : "";
        const id =
          eventId ||
          `${tool}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setMessages((prev) => [
          ...prev,
          { role: "tool", id, tool, params, status: "running", content: "" },
        ]);
        break;
      }
      case "tool_result": {
        const result = String(event.result || "");
        const eventId = event.id ? String(event.id) : "";
        const eventTool = String(event.tool || "");
        setMessages((prev) => {
          const updated = [...prev];
          let targetIdx = -1;
          // 优先按 id 精确匹配（修复并行工具调用时结果错配）
          if (eventId) {
            for (let i = 0; i < updated.length; i++) {
              const m = updated[i];
              if (m.role === "tool" && m.id === eventId) {
                targetIdx = i;
                break;
              }
            }
          }
          // 回退：按工具名找最早一个还在 running 的（FIFO，匹配后端并行返回顺序）
          if (targetIdx === -1) {
            for (let i = 0; i < updated.length; i++) {
              const m = updated[i];
              if (
                m.role === "tool" &&
                m.status === "running" &&
                (!eventTool || m.tool === eventTool)
              ) {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx >= 0) {
            updated[targetIdx] = {
              ...updated[targetIdx],
              status: "done",
              content: result,
              result,
            };
          }
          return updated;
        });
        break;
      }
      case "message": {
        const content = String(event.content || "");
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: last.content + content };
          } else {
            updated.push({ role: "assistant", content });
          }
          return updated;
        });
        break;
      }
      case "error": {
        const msg = String(event.message || "未知错误");
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: msg };
          } else {
            updated.push({ role: "assistant", content: msg });
          }
          return updated;
        });
        break;
      }
      case "done": {
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === "tool" && updated[i].status === "running") {
              updated[i] = { ...updated[i], status: "error", content: "未返回结果" };
            }
          }
          if (updated.length === 0 || updated[updated.length - 1].role !== "assistant") {
            updated.push({ role: "assistant", content: "" });
          }
          return updated;
        });
        break;
      }
    }
  };

  const toggleToolExpand = (msgIndex: number) => {
    skipScrollRef.current = true;
    setMessages((prev) => {
      const updated = [...prev];
      if (updated[msgIndex].role !== "tool") return updated;
      updated[msgIndex] = {
        ...updated[msgIndex],
        expanded: !updated[msgIndex].expanded,
      };
      return updated;
    });
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

  const formatTime = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  // ---- Home View ----
  if (view === "home") {
    return (
      <div className="flex flex-col h-full w-full bg-gray-50">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b bg-white">
          <div className="flex items-center gap-2">
            <span className="text-lg">🔥</span>
            <h1 className="text-sm font-bold text-red-600">小红书爆款分析</h1>
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-gray-300"}`} />
          </div>
          <span className="text-[11px] text-gray-400">AI Agent 驱动</span>
        </div>

        {/* Welcome + Create Task */}
        <div className="px-5 pt-3 pb-3 text-center">
          <div className="text-3xl mb-1">🤖</div>
          <h2 className="text-base font-bold text-gray-800 mb-1">小红书爆款分析助手</h2>
          <p className="text-[11px] text-gray-500 leading-relaxed max-w-xs mx-auto mb-3">
            输入关键词，AI 自动抓取小红书热门笔记，分析爆款规律并生成可视化报告。
          </p>
          <button
            onClick={startNewChat}
            disabled={!connected}
            className="w-full py-2 bg-gradient-to-r from-red-500 to-red-400 text-white text-sm font-semibold rounded-lg hover:from-red-600 hover:to-red-500 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all shadow hover:shadow-md flex items-center justify-center gap-2"
          >
            <span>🚀</span>
            开始新分析
          </button>
          {!connected && (
            <p className="text-[10px] text-gray-400 mt-1 text-center">请确保后端服务正在运行</p>
          )}
        </div>

        {/* Divider */}
        <div className="px-5 pb-1">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-[11px] text-gray-400 font-medium">📋 历史任务</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto px-5 py-1.5">
          {loadingList ? (
            <div className="text-sm text-gray-400 text-center py-4">加载中...</div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-4">
              <div className="text-xl mb-1">📭</div>
              <div className="text-xs text-gray-400">暂无历史任务</div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => openConversation(conv.id)}
                  className="cursor-pointer border rounded-lg px-3.5 py-2.5 bg-white hover:bg-red-50 hover:border-red-200 transition-all shadow-sm hover:shadow"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{conv.title || "未命名任务"}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1">
                        <span>🕐</span>
                        {formatTime(conv.created_at)}
                      </div>
                    </div>
                    <span className="text-gray-300 text-base ml-2">›</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Chat View ----
  return (
    <div className="flex flex-col h-full w-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b bg-red-50">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setView("home");
              loadConversations();
            }}
            className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-200 transition-colors flex items-center gap-1"
          >
            ← 返回
          </button>
          <h1 className="text-sm font-bold text-red-600">{conversationId ? "任务详情" : "新任务"}</h1>
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-gray-300"}`} />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === "user" && (
              <div className="flex justify-end">
                <div className="max-w-[80%] min-w-0 px-4 py-2.5 rounded-xl text-sm leading-relaxed overflow-hidden bg-red-500 text-white rounded-br-sm">
                  <MessageContent content={msg.content} isUser={true} />
                </div>
              </div>
            )}
            {msg.role === "assistant" && (
              <div className="flex justify-start">
                <div
                  className={`max-w-[80%] min-w-0 px-4 py-2.5 rounded-xl text-sm leading-relaxed overflow-hidden ${
                    msg.content
                      ? "bg-gray-100 text-gray-800 rounded-bl-sm"
                      : "bg-gray-50 text-gray-400 italic rounded-bl-sm"
                  }`}
                >
                  {msg.content ? (
                    <MessageContent content={msg.content} isUser={false} />
                  ) : loading ? (
                    "思考中..."
                  ) : (
                    ""
                  )}
                </div>
              </div>
            )}
            {msg.role === "tool" && (
              <div
                onClick={() => toggleToolExpand(i)}
                className="cursor-pointer border rounded-lg bg-white hover:bg-gray-50 transition-colors shadow-sm"
              >
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span className="text-sm">
                    {msg.status === "running" ? "⏳" : msg.status === "done" ? "✅" : "❌"}
                  </span>
                  <span className="text-sm font-medium text-gray-700">{msg.tool}</span>
                  <span className="text-xs text-gray-400 truncate flex-1">
                    {formatParamsSummary(msg.tool ?? "", msg.params ?? {})}
                  </span>
                  <span className="text-xs text-gray-400">
                    {msg.expanded ? "▲" : "▼"}
                  </span>
                </div>
                {msg.expanded && (
                  <div className="px-3 pb-2 space-y-1.5 max-h-56 overflow-y-auto">
                    <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1.5">
                      <div className="font-semibold text-gray-600 mb-0.5">参数：</div>
                      <pre className="whitespace-pre-wrap break-all">
                        {JSON.stringify(msg.params, null, 2)}
                      </pre>
                    </div>
                    {msg.result && (
                      <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1.5">
                        <div className="font-semibold text-gray-600 mb-0.5">结果：</div>
                        <ToolResultContent result={msg.result} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="bg-gray-50 text-gray-400 italic px-4 py-2.5 rounded-xl text-sm rounded-bl-sm">
              思考中...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t px-5 py-3 bg-white">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && sendMessage()}
            placeholder="输入关键词，如：帮我分析减肥餐的爆款规律"
            disabled={loading}
            className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 disabled:bg-gray-50 transition-all"
          />
          {loading ? (
            <button
              onClick={stopGeneration}
              className="px-4 py-2.5 bg-gray-500 text-white text-sm rounded-xl hover:bg-gray-600 transition-colors"
            >
              停止
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim()}
              className="px-5 py-2.5 bg-red-500 text-white text-sm font-medium rounded-xl hover:bg-red-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// 配置 marked：链接在新标签页打开
const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) => {
  const t = title ? ` title="${title}"` : "";
  return `<a href="${href}"${t} target="_blank" rel="noopener noreferrer" class="underline break-all">${text}</a>`;
};
marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
});

function MessageContent({ content, isUser }: { content: string; isUser: boolean }) {
  if (isUser) {
    const parts: React.ReactNode[] = [];
    const urlRegex = /https?:\/\/[^\s<>"{}|\^`[\]]+/g;
    let lastIndex = 0;
    let match;
    let key = 0;
    while ((match = urlRegex.exec(content)) !== null) {
      const textBefore = content.slice(lastIndex, match.index);
      if (textBefore) {
        parts.push(<span key={key++} className="whitespace-pre-wrap">{textBefore}</span>);
      }
      const url = match[0];
      parts.push(
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer" className="underline break-all text-white" onClick={(e) => e.stopPropagation()}>
          {url}
        </a>
      );
      lastIndex = urlRegex.lastIndex;
    }
    const textAfter = content.slice(lastIndex);
    if (textAfter) {
      parts.push(<span key={key++} className="whitespace-pre-wrap">{textAfter}</span>);
    }
    return <>{parts}</>;
  }

  const html = marked.parse(content, { async: false }) as string;
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
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
