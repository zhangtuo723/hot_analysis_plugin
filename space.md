# 小红书爆款分析浏览器 AI 插件技术方案（前后端完整）

---

# 一、项目目标

开发一个 **Chrome 浏览器插件 + AI SaaS 后端系统**

用户输入关键词，例如：

```text
减肥餐
副业
护肤
穿搭
AI绘画
```

插件自动在网页版小红书执行：

1. 搜索关键词
2. 抓取热门笔记（多篇）
3. 分析爆款规律
4. 输出行业爆款秘籍
5. 给出可复制选题

---

# 二、整体系统架构

```text
┌────────────────────┐
│ Chrome 插件前端     │
│ popup + content.js │
└────────┬───────────┘
         │ HTTPS API
         ▼
┌────────────────────┐
│ Python 后端服务     │
│ FastAPI + AI网关   │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 大模型平台          │
│ Kimi（多模态）      │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 本地 MySQL 数据库   │
└────────┘
```

---

# 三、前端技术方案（Chrome 插件）

# 技术栈

```text
Chrome Extension Manifest V3
React（插件UI）
TailwindCSS
TypeScript
```

---

# 插件模块设计

## 1.popup 页面（用户交互入口）

功能：

* 输入关键词
* 点击开始分析
* 展示结果
* 用户登录状态
* 套餐额度显示

页面结构：

```text
┌─────────────────┐
│ 输入关键词       │
│ [减肥餐      ]  │
│ [开始分析]      │
│                 │
│ 最近爆款规律    │
│ 蓝海机会        │
└─────────────────┘
```

---

## 2.content.js（注入小红书页面）

负责：

* 自动输入搜索词
* 点击搜索
* 自动滚动页面
* 抓取笔记数据
* 返回给 popup

抓取字段：

```json
{
  "title": "",
  "likes": "",
  "collects": "",
  "comments": "",
  "author": "",
  "url": "",
  "publishTime": "",
  "cover": ""
}
```

---

## 3.background.js

负责：

* 管理标签页
* 消息转发
* 跨域请求
* Token存储

---

# 四、插件执行流程

```text
用户输入关键词
↓
popup 发送消息
↓
打开小红书页面
↓
content.js 自动搜索
↓
抓取50篇笔记
↓
发送给后端
↓
AI分析返回
↓
插件展示报告
```

---

# 五、后端技术方案

# 技术栈

```text
Python 3.11+
FastAPI
SQLAlchemy（ORM）
MySQL（本地开发，后续迁移阿里云 RDS）
Redis（后续接入）
Uvicorn（ASGI 服务器）
JWT 登录认证
```

---

# 后端模块设计

## 1. 用户系统

功能：

* 注册登录
* 微信登录（后期）
* 套餐管理
* 调用次数统计

表结构：

```sql
users
plans
usage_logs
```

---

## 2. 分析任务系统

接口：

```http
POST /api/analyze
```

参数：

```json
{
  "keyword":"减肥餐",
  "notes":[...]
}
```

返回：

```json
{
  "summary":"最近30天爆款规律...",
  "hotRules":[...],
  "opportunity":[...],
  "titles":[...]
}
```

---

## 3. AI网关层

统一封装：

```text
Kimi（默认，多模态，可识别封面图）
OpenAI
Claude
Qwen
```

根据套餐切换模型。

---

## 4. 缓存系统（Redis，后续接入）

如果多人搜：

```text
减肥餐
护肤
副业
```

直接返回缓存结果，降低成本。

---

# 六、AI 分析方案（核心）

---

## Prompt 模板

```text
你是小红书爆款内容分析师。

以下是关键词：减肥餐
最近热门笔记数据：

[JSON数据]

请输出：

1. 最近爆款共性
2. 标题套路
3. 封面风格
4. 用户真实需求
5. 蓝海机会
6. 10个可复制爆款选题
```

---

## 返回格式（结构化 JSON）

```json
{
  "summary":"",
  "rules":[],
  "needs":[],
  "opportunity":[],
  "titles":[]
}
```

---

# 七、数据库设计

---

## users

```sql
id            INT AUTO_INCREMENT PRIMARY KEY
email         VARCHAR(255) UNIQUE NOT NULL
password      VARCHAR(255) NOT NULL
plan          VARCHAR(50) DEFAULT 'free'
created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
```

---

## analyze_logs

```sql
id            INT AUTO_INCREMENT PRIMARY KEY
user_id       INT FOREIGN KEY REFERENCES users(id)
keyword       VARCHAR(255)
result_json   TEXT
created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
```

---

## quota_logs

```sql
id            INT AUTO_INCREMENT PRIMARY KEY
user_id       INT FOREIGN KEY REFERENCES users(id)
used_count    INT DEFAULT 0
month         VARCHAR(7)
```

---

# 八、前后端接口设计

---

## 登录

```http
POST /api/login
```

---

## 获取用户信息

```http
GET /api/me
```

---

## 提交分析

```http
POST /api/analyze
```

---

## 获取历史记录

```http
GET /api/history
```

---

# 九、部署方案

## 当前阶段：本地开发

```text
后端：Uvicorn 本地运行（localhost:8000）
数据库：本地 MySQL
插件：chrome://extensions 开发者模式加载
```

## 后续上线：阿里云

```text
后端：阿里云 ECS 部署 FastAPI
数据库：阿里云 RDS MySQL
缓存：阿里云 Redis
```

---

# 十、安全设计

---

## 插件端不存 API Key

所有模型调用走后端。

---

## 用户鉴权

JWT + Refresh Token

---

## 防刷接口

限制：

```text
每分钟3次分析
会员每日100次
```

---

# 十一、开发资源清单

## 必须申请

| 资源 | 用途 | 费用 |
|------|------|------|
| Kimi API Key | AI 分析核心（多模态，可识别封面图） | 按量付费 |

## 本地安装

| 软件 | 用途 |
|------|------|
| MySQL | 本地数据库 |
| Python 3.11+ | 后端运行环境 |
| Node.js | 插件前端构建 |

## 后续按需

| 资源 | 用途 | 时机 |
|------|------|------|
| 阿里云 RDS MySQL | 云数据库 | 上线时 |
| 阿里云 ECS | 部署后端 | 上线时 |
| Redis | 缓存 | 用户量上来后 |
| Chrome Web Store 开发者账号 | 发布插件 | 上线时（$5） |

---

# 十二、成本预估（月）

## 本地开发阶段

```text
服务器：0（本地运行）
数据库：0（本地 MySQL）
模型成本：按量付费，几元起步
总计：几乎为零
```

## 后续上线（1000用户 MVP）

```text
阿里云 ECS：200元/月
阿里云 RDS：100元/月
模型成本：500元/月
总计：800元/月
```

---

# 十三、推荐目录结构

```text
project/

extension/
  popup/
  content/
  background/

server/
  app/
    main.py
    auth/
    analyze/
    ai/
    users/
    models/
    database.py

shared/
```

---

# 十四、开发周期

---

## 第1周 MVP

```text
插件搜索抓取
后端分析接口
基础UI
```

---

## 第2周 商业版

```text
登录系统
套餐系统
支付
历史记录
```

---

## 第3周 增长版

```text
多关键词批量分析
自动生成选题
爆款标题生成器
```

---

# 十五、起步建议

## 模型：

Kimi（多模态，可识别封面图）

## 后端：

FastAPI + SQLAlchemy

## 数据库：

本地 MySQL（后续迁移阿里云 RDS）

## 插件：

React + TS

---

# 十六、下一步：先跑通 MVP

> 输入关键词 → 自动抓小红书 → 输出爆款分析报告

这是最快验证核心功能的版本。
