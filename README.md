# 小红书爆款分析插件

Chrome 浏览器插件 + FastAPI 后端，基于 AI Agent 自动操控浏览器抓取小红书数据并分析爆款规律。

## 功能

- 输入关键词（如"减肥餐"、"副业"），AI Agent 自动操作浏览器
- 自动搜索、抓取热门笔记、进入详情页
- 多模态分析：支持截图识别封面风格、视频抽帧分析画面
- 流式返回分析过程，实时查看 Agent 每一步操作
- 对话式交互，支持多轮追问

## 技术架构

```
┌─────────────────────────┐
│  Chrome Extension (MV3) │  React + TypeScript + TailwindCSS
│  - popup: 对话 UI         │
│  - content.js: 页面注入   │
│  - background: WebSocket  │
└───────────┬─────────────┘
            │ WebSocket + HTTP API
            ▼
┌─────────────────────────┐
│  FastAPI 后端 (localhost:8000)
│  - SSE 流式对话           │
│  - WebSocket 浏览器控制   │
│  - LangGraph Deep Agent   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Kimi API (多模态大模型) │
└─────────────────────────┘
```

## 环境要求

- Python 3.11+
- Node.js 18+
- Chrome 浏览器
- Kimi API Key（[获取地址](https://platform.moonshot.cn/)）

## 项目结构

```
.
├── extension/          # Chrome 插件
│   ├── src/
│   │   ├── popup/      # 弹窗 UI (React)
│   │   ├── content/    # 内容脚本 (页面注入)
│   │   └── background/ # Service Worker
│   ├── manifest.json
│   └── package.json
│
├── server/             # FastAPI 后端
│   ├── app/
│   │   ├── agent/      # Agent 核心 (tools, ws, agent)
│   │   ├── routers/    # API 路由
│   │   ├── models/     # 数据库模型
│   │   ├── database.py
│   │   ├── config.py
│   │   └── main.py
│   ├── skills/         # Agent Skill 指令
│   ├── requirements.txt
│   └── .env            # 环境变量配置
│
└── README.md
```

## 1. 配置模型 API

进入 `server/` 目录，复制环境变量模板：

```bash
cd server
cp .env.example .env
```

编辑 `.env` 文件，填入你的 Kimi API Key：

```env
KIMI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
KIMI_BASE_URL=https://api.kimi.com/coding/v1
KIMI_MODEL=kimi-coding/k2p6
DATABASE_URL=sqlite:///./hot_analysis.db
```

**参数说明：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `KIMI_API_KEY` | Kimi / Moonshot API Key | `sk-...` |
| `KIMI_BASE_URL` | API 基础地址 | `https://api.kimi.com/coding/v1` |
| `KIMI_MODEL` | 模型名称 | `kimi-coding/k2p6` |
| `DATABASE_URL` | 数据库地址 | SQLite 本地文件 |

> **获取 API Key**：访问 [Kimi 开放平台](https://platform.moonshot.cn/) 注册并创建 API Key。

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

# 构建（开发模式带监听）
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

## 4. 使用

1. **打开小红书网页版**：访问 [https://www.xiaohongshu.com](https://www.xiaohongshu.com)
2. **点击插件图标**：打开 popup 对话面板
3. **输入关键词**：例如"帮我分析减肥餐的爆款规律"
4. **观察 Agent 执行**：面板会实时显示 AI 的每一步操作（点击、输入、滚动、截图）
5. **查看结果**：Agent 会自动抓取数据并生成爆款分析报告

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 健康检查 |
| `/api/chat` | POST | 非流式对话 |
| `/api/chat/stream` | POST | SSE 流式对话（推荐） |
| `/api/conversations` | GET | 获取对话列表 |
| `/api/conversations/{id}` | GET | 获取对话详情 |
| `/api/conversations/{id}` | DELETE | 删除对话 |
| `/api/ws/browser/{client_id}` | WebSocket | 浏览器控制通道 |

## Agent 浏览器工具

AI Agent 可调用的原子级浏览器操作工具：

| 工具 | 功能 |
|------|------|
| `screenshot` | 截取当前页面截图（多模态返回） |
| `click` | 点击页面元素 |
| `type_text` | 在输入框输入文字 |
| `scroll_page` | 向下滚动页面 |
| `get_page_content` | 获取页面文本内容 |
| `get_dom_structure` | 获取页面 DOM 结构 |
| `extract_video_frames` | 视频均匀抽帧分析 |
| `capture_video_snapshot` | 截取视频指定时间点画面 |

## 常见问题

**Q: 后端启动后 Ctrl+C 退出不了？**

A: 使用 `--timeout-graceful-shutdown 5` 参数限制退出等待时间。如果还有问题，按两次 Ctrl+C 强制退出。

**Q: 插件显示"未连接到后端"？**

A: 确保后端服务已启动（`http://localhost:8000`），且插件 popup 已重新打开。

**Q: Agent 操作页面没反应？**

A: 确保当前浏览器标签页是 `xiaohongshu.com` 域名，且页面已完全加载。

**Q: 截图工具返回错误？**

A: 确保小红书页面在浏览器中是**可见标签页**（非后台标签），Chrome 截图 API 要求页面可见。

## License

MIT
