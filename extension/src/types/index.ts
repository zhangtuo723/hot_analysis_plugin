export interface NoteItem {
  title: string;
  likes: string;
  collects: string;
  comments: string;
  author: string;
  url: string;
  publishTime: string;
  cover: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  notes?: NoteItem[];
  // tool 消息专用
  id?: string;
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
  status?: "running" | "done" | "error";
  expanded?: boolean;
}
