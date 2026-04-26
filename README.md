# 小红书爆款分析插件

Chrome 浏览器插件 + FastAPI 后端，基于 Deep Agent 自动操控浏览器抓取小红书数据并分析爆款规律。

## 功能

- 输入关键词（如"减肥餐"、"副业"），AI Agent 自动操作浏览器
- 自动搜索、抓取热门笔记、进入详情页深度分析
- 多模态分析：支持截图识别封面风格、视频抽帧分析画面
- 流式返回分析过程，实时查看 Agent 每一步操作
- 对话式交互，支持多轮追问，自动恢复历史上下文
- 生成结构化爆款分析报告 + 可复制选题建议

## 技术架构

```
┌─────────────────────────┐
│  Chrome Extension (MV3) │  React 18 + TypeScript + TailwindCSS
│  - popup: 对话 UI (独立窗口)│
│  - content.js: 页面注入    │
│  - background: WebSocket   │
└───────────┬─────────────┘
            │ WebSocket + HTTP API
            ▼
┌─────────────────────────┐
│  FastAPI 后端 (localhost:8000)
│  - SSE 流式对话 (/api/chat/stream)
│  - WebSocket 浏览器控制 (/api/ws/browser/{client_id})
│  - Deep Agent (deepagents + ChatMoonshot + LangGraph)
│  - SQLite 持久化 + LangGraph Checkpoint
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Moonshot API (多模态)   │
│  - screenshot / 视频抽帧  │
│  - 结构化爆款分析输出     │
└─────────────────────────┘
```

## 环境要求

- Python 3.11+
- Node.js 18+
- Chrome 浏览器
- Moonshot API Key（[获取地址](https://platform.moonshot.cn/)）

## 项目结构

```
.
├── extension/                 # Chrome 插件 (MV3)
│   ├── src/
│   │   ├── popup/
│   │   │   ├── App.tsx        # 对话 UI (React + SSE 流式)
│   │   │   ├── main.tsx       # 入口
│   │   │   └── index.css      # Tailwind 样式
│   │   ├── content/
│   │   │   ├── content.ts     # 内容脚本：原子级浏览器操作
│   │   │   └── videoCapture.ts # 视频抽帧 / 快照工具
│   │   ├── background/
│   │   │   └── background.ts  # Service Worker：WebSocket + 截图处理
│   │   └── types/
│   │       └── index.ts       # 类型定义
│   ├── manifest.json          # 插件清单 (v0.3.0)
│   ├── popup.html
│   └── vite.config.ts
│
├── server/                    # FastAPI 后端
│   ├── app/
│   │   ├── agent/
│   │   │   ├── agent.py       # Deep Agent 创建与运行 (流式/非流式)
│   │   │   ├── tools.py       # LangChain 浏览器工具定义
│   │   │   └── ws.py          # WebSocket 连接管理器
│   │   ├── routers/
│   │   │   └── analyze.py     # API 路由：chat / stream / conversations / ws
│   │   ├── models/
│   │   │   └── analyze.py     # SQLAlchemy 模型：Conversation / AnalyzeLog
│   │   ├── database.py        # SQLite 引擎
│   │   ├── config.py          # Pydantic Settings (从 .env 加载)
│   │   └── main.py            # FastAPI 应用入口
│   ├── skills/
│   │   └── xhs/
│   │       └── SKILL.md       # 小红书爆款分析 Skill 指令
│   ├── requirements.txt
│   └── .env                   # 环境变量配置
│
└── README.md
```

## 1. 配置模型 API

进入 `server/` 目录，创建 `.env` 文件：

```bash
cd server
# 创建 .env 文件
```

编辑 `.env`，填入你的 Moonshot API Key：

```env
KIMI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
KIMI_BASE_URL=https://api.kimi.com/coding/v1
KIMI_MODEL=kimi-k2-0711
DATABASE_URL=sqlite:///./hot_analysis.db
```

**参数说明：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `KIMI_API_KEY` | Moonshot API Key | `sk-...` |
| `KIMI_BASE_URL` | API 基础地址 | `https://api.kimi.com/coding/v1` |
| `KIMI_MODEL` | 模型名称 | `kimi-k2-0711` |
| `DATABASE_URL` | SQLite 数据库路径 | `sqlite:///./hot_analysis.db` |

> **获取 API Key**：访问 [Moonshot 开放平台](https://platform.moonshot.cn/) 注册并创建 API Key。

## 2. 启动后端服务

```bash
cd server

# 创建虚拟环境（推荐）
python -m venv venv

# Windows 激活
venv\Scripts\activate
# macOS/Linux 激活
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 启动服务
uvicorn app.main:app --reload --timeout-graceful-shutdown 5
```

服务启动后：
- API 地址：`http://localhost:8000`
- WebSocket 地址：`ws://localhost:8000/api/ws/browser/{client_id}`

> `--timeout-graceful-shutdown 5`：设置优雅退出超时为 5 秒，防止 Ctrl+C 卡死。

## 3. 构建并加载插件

```bash
cd extension

# 安装依赖
npm install

# 开发模式（带监听，自动重建）
npm run watch

# 或单次构建
npm run build
```

构建产物输出到 `extension/dist/` 目录。

**加载到 Chrome：**

1. 打开 Chrome，输入 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/dist/` 文件夹

> **注意**：插件使用独立浮动窗口（非默认 popup），点击图标会打开 420x640 的独立窗口，避免失焦关闭问题。

## 4. 使用

1. **打开小红书网页版**：访问 [https://www.xiaohongshu.com](https://www.xiaohongshu.com)
2. **点击插件图标**：打开独立对话窗口
3. **输入关键词**：例如"帮我分析减肥餐的爆款规律"
4. **观察 Agent 执行**：面板实时显示 AI 的每一步操作（点击、输入、滚动、截图、视频抽帧）
5. **查看结果**：Agent 自动抓取数据并生成结构化爆款分析报告

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 健康检查 |
| `/api/chat` | POST | 非流式对话 |
| `/api/chat/stream` | POST | **SSE 流式对话（推荐）** |
| `/api/conversations` | GET | 获取对话列表 |
| `/api/conversations/{id}` | GET | 获取对话详情（含消息 + 工具调用记录） |
| `/api/conversations/{id}` | DELETE | 删除对话 |
| `/api/ws/browser/{client_id}` | WebSocket | 浏览器控制通道 |

## Agent 浏览器工具

AI Agent 可调用的原子级浏览器操作工具：

| 工具 | 功能 |
|------|------|
| `screenshot` | 截取当前页面截图（JPEG 压缩 + 缩放，多模态返回） |
| `click` | 点击页面元素 |
| `hover` | 悬停到元素上（触发 hover 状态、显示隐藏按钮） |
| `type_text` | 在输入框输入文字（支持原生 input 和 contenteditable） |
| `scroll_page` | 向下滚动页面 |
| `get_page_content` | 获取页面文本内容 |
| `get_dom_structure` | 获取页面 DOM 结构（用于定位选择器） |
| `extract_video_frames` | 视频均匀抽帧分析（多模态返回） |
| `capture_video_snapshot` | 截取视频指定时间点画面（精确 seek） |

## 核心特性

### Deep Agent 架构

后端使用 `deepagents` 的 `create_deep_agent` 构建 Agent：

- **LLM**：`ChatMoonshot`（Moonshot API，支持多模态图片输入）
- **工具**：9 个原子级浏览器操作工具（LangChain `@tool` 装饰器）
- **记忆**：`AsyncSqliteSaver`（LangGraph checkpoint）自动保存对话状态，支持多轮追问恢复上下文
- **文件系统**：`CompositeBackend` 提供虚拟 workspace + skill 目录访问
- **Skill 系统**：按需加载 `skills/xhs/SKILL.md` 获取小红书爆款分析完整指令

### 多模态感知

- `screenshot` 和 `extract_video_frames` 返回 `image_url` 多模态内容，LLM 可直接"看到"页面状态
- 截图自动压缩（宽度 800px、JPEG quality 0.5），避免 token 爆炸
- 视频抽帧精确 seek：先暂停、定位、截图、恢复原状态，无漂移

### 流式实时反馈

SSE 流式接口实时推送事件：

```
tool_start   → Agent 开始调用工具
tool_result  → 工具执行完成（含图片结果）
message      → AI 生成内容片段
done         → 对话完成
error        → 执行出错
```

前端 UI 实时展示工具调用链，可展开查看参数和结果。

### 数据持久化

- **对话记录**：SQLite 存储消息历史、工具调用链、标题
- **分析日志**：`AnalyzeLog` 记录每次分析任务的关键词、耗时
- **Checkpoint**：`agent_checkpoints.db` 保存 LangGraph 状态，重启后对话可恢复

## 常见问题

**Q: 后端启动后 Ctrl+C 退出不了？**

A: 使用 `--timeout-graceful-shutdown 5` 参数限制退出等待时间。如果还有问题，按两次 Ctrl+C 强制退出。

**Q: 插件显示"未连接到后端"？**

A: 确保后端服务已启动（`http://localhost:8000`），且插件窗口已重新打开。

**Q: Agent 操作页面没反应？**

A: 确保当前浏览器标签页是 `xiaohongshu.com` 域名，且页面已完全加载。

**Q: 截图工具返回错误？**

A: 确保小红书页面在浏览器中是**可见标签页**（非后台标签），Chrome 截图 API 要求页面可见。

**Q: 搜索框输入没反应？**

A: 小红书搜索框是 `contenteditable` div，`type_text` 工具已兼容此场景。如遇问题可尝试先点击搜索框聚焦。

## License

MIT
