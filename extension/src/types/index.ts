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
  role: "user" | "assistant";
  content: string;
  notes?: NoteItem[];
}
