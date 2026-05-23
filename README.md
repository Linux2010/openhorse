# OpenHorse

> **OpenHorse — Universal Agent Harness Framework**
> 一个完整的 Harness Coding CLI Agent

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)

---

## 🎯 项目定位

**OpenHorse** — 一个完整的 Agent Harness Coding CLI 工具，提供安全边界、工具调用、记忆系统、MCP 协议支持。

### 核心理念

| 维度 | 说明 |
|------|------|
| **🐴 AI 如马** | 强大的 AI 模型需要引导和约束 |
| **🪢 OpenHorse 如缰** | 精准控制方向，防止跑偏失控 |
| **🎯 Harness 系统** | 安全边界、任务约束、结果验证 |
| **🛠️ 工具调用** | LLM 自动调用工具完成任务 |
| **🧠 记忆系统** | 分层记忆：Working / Short-term / Long-term |
| **🔌 MCP 协议** | 支持 MCP 工具扩展 |

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| **LLM 工具调用** | 支持 20+ 工具：文件读写、搜索、执行命令、网页抓取等 |
| **多模型支持** | OpenAI、Claude、阿里百炼（GLM/Qwen/Kimi）、自定义 endpoint |
| **MCP 协议** | 完整支持 MCP Server 连接和工具调用 |
| **记忆系统** | 用户记忆、项目记忆、会话记忆三层存储 |
| **会话管理** | 会话持久化、历史恢复、摘要生成 |
| **安全边界** | Bash 命令白名单、危险模式检测、审计日志 |
| **Todo/Plan** | 任务列表管理、计划模式切换 |
| **流式输出** | 实时显示 LLM 响应，支持 Markdown 渲染 |
| **状态栏** | Token 使用量、成本、MCP 连接状态实时显示 |

---

## 🏗️ 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    CLI 交互层                             │
│   readline + chalk + 流式 Markdown + 状态栏              │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Harness 驾驭层                         │
│  目标约束 │ 边界检查 │ 结果验证 │ Bash 安全 │ 审计日志    │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Query 查询引擎                         │
│  LLM Stream │ Tool Calling │ Retry/Fallback │ Cost Tracker│
└──────────┬─────────────────┬─────────────────┬──────────┘
           │                 │                 │
┌──────────▼─────┐ ┌─────────▼─────┐ ┌─────────▼──────────┐
│   Tools 工具集  │ │  MCP Client   │ │   Skills 技能系统   │
│  File/Bash/Web │ │  Server 连接  │ │  Builtin/User/Proj │
└─────────────────┘ └───────────────┘ └───────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Memory 记忆层                          │
│  User Memory │ Project Memory │ Session Memory │ Semantic│
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0
- npm >= 9.0

### 安装与运行

```bash
# 克隆项目
git clone https://github.com/Linux2010/openhorse.git
cd openhorse

# 安装依赖
npm install

# 构建
npm run build

# 配置 API Key（任选一种）
# 方式 1: 环境变量
export OPENHORSE_API_KEY=your-api-key

# 方式 2: .env 文件
cp .env.example .env
# 编辑 .env 设置 OPENHORSE_API_KEY

# 方式 3: ~/.openhorse/openhorse.json（推荐）
# 运行后会自动创建配置文件

# 启动交互式 CLI
npm start

# 或直接运行
node dist/cli.js
```

### 全局安装

```bash
# 本地链接
npm link

# 任意目录运行
openhorse
```

---

## 📦 支持的模型

### OpenAI 系列

```bash
/model gpt-4o        # GPT-4 Omni
/model gpt-3.5-turbo # GPT-3.5
```

### Claude 系列

```bash
/model opus          # Claude Opus 4.7
/model sonnet        # Claude Sonnet 4.6
/model haiku         # Claude Haiku 4.5
```

### 阿里百炼系列（coding.dashscope.aliyuncs.com）

```bash
/model qwen          # Qwen 3.5 Plus
/model qwenmax       # Qwen 3 Max
/model coder         # Qwen 3 Coder Plus
/model glm           # GLM-5（智谱）
/model kimi          # Kimi K2.5（月之暗面）
/model minimax       # MiniMax M2.5
```

### 模型命令

```bash
/model               # 显示当前模型
/model list          # 显示所有可用模型
/model sonnet        # 切换到 Sonnet
```

---

## 🛠️ 工具列表

OpenHorse 内置 20+ 工具，LLM 可自动调用：

### 文件操作

| 工具 | 功能 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `edit_file` | 编辑文件（行替换） |
| `list_files` | 列出目录内容 |
| `glob` | Glob 模式搜索文件 |
| `grep` | 正则搜索文件内容 |

### Shell 执行

| 工具 | 功能 |
|------|------|
| `exec_command` | 执行 shell 命令（带安全检查） |

### 网络工具

| 工具 | 功能 |
|------|------|
| `web_fetch` | 抓取网页内容 |
| `web_search` | 网络搜索 |

### 记忆系统

| 工具 | 功能 |
|------|------|
| `memory_save` | 保存记忆 |
| `memory_recall` | 搜索记忆 |
| `memory_forget` | 删除记忆 |

### 任务管理

| 工具 | 功能 |
|------|------|
| `todo_write` | 创建/更新任务列表 |
| `enter_plan_mode` | 进入计划模式 |
| `exit_plan_mode` | 退出计划模式 |

---

## 🔌 MCP 协议支持

OpenHorse 完整支持 MCP（Model Context Protocol）协议：

### 配置 MCP Server

创建 `~/.openhorse/mcp.json`：

```json
{
  "servers": {
    "telegram": {
      "command": "node",
      "args": ["path/to/plugin-telegram/dist/index.js"],
      "env": {}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/path/to/allowed/dir"]
    }
  }
}
```

### MCP 命令

```bash
/mcp                # 显示 MCP Server 连接状态
```

启动时自动连接所有配置的 MCP Server。

---

## 💬 交互命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help` | `/h` | 显示帮助信息 |
| `/status` | `/s` | 系统状态总览 |
| `/model` | - | 查看或切换模型 |
| `/config` | - | 显示当前配置 |
| `/cost` | - | 显示会话 token 使用量 |
| `/usage` | `/stats` | 详细使用统计 |
| `/sessions` | - | 列出最近会话 |
| `/resume` | - | 恢复上次会话 |
| `/memory` | - | 记忆系统状态 |
| `/memory reindex` | - | 重建语义搜索索引 |
| `/skills` | - | 列出加载的技能 |
| `/mcp` | - | MCP Server 状态 |
| `/agents` | - | Agent 列表 |
| `/safety` | - | 安全检查配置 |
| `/harness` | - | Harness 配置 |
| `/task` | - | 任务管理 |
| `/run` | - | 通过 Agent 执行任务 |
| `/clear` | - | 清屏 |
| `/clear-history` | `/reset` | 清除对话历史 |
| `/exit` | `/q` | 退出 |

---

## 📁 项目结构

```
openhorse/
├── bin/
│   └── openhorse            # CLI 入口
├── src/
│   ├── cli.ts               # 命令行交互入口
│   ├── commands/
│   │   ├── index.ts         # 命令注册表
│   │   ├── parser.ts        # 输入解析
│   │   └── types.ts         # 命令类型定义
│   ├── core/
│   │   ├── agent.ts         # Agent 基类
│   │   ├── brain.ts         # 决策引擎
│   │   └── strategy-tracker.ts  # 策略追踪
│   ├── agents/
│   │   ├── leader.ts        # 协调者 Agent
│   │   ├── coder.ts         # 编码 Agent
│   │   └── router.ts        # Agent 路由
│   ├── framework/
│   │   ├── store.ts         # 状态管理
│   │   ├── query.ts         # 查询引擎
│   │   └── tool-state.ts    # 工具状态管理
│   ├── harness/
│   │   ├── safety.ts        # 安全边界检查
│   │   └── bash-safety.ts   # Bash 命令安全
│   │   └── harness.ts       # Harness 引擎
│   ├── memory/
│   │   ├── storage.ts       # 记忆存储
│   │   ├── semantic-search.ts   # 语义搜索
│   │   ├── embeddings.ts    # Embedding 生成
│   │   └── vector-store.ts  # 向量存储
│   ├── skills/
│   │   ├── loader.ts        # 技能加载器
│   │   └ registry.ts        # 技能注册表
│   ├── services/
│   │   ├── llm.ts           # LLM 服务（含 Retry/Fallback）
│   │   ├── config.ts        # 配置加载
│   │   ├── global-config.ts # 全局配置管理
│   │   ├── session-storage.ts   # 会话持久化
│   │   ├── atomic-write.ts  # 原子文件写入
│   │   ├── agent-runner.ts  # Agent 执行器
│   │   └ task-manager.ts    # 任务管理器
│   │   ├── file-glob.ts     # 文件匹配
│   │   └ mcp-bootstrap.ts   # MCP 启动
│   ├── tools/
│   │   ├── index.ts         # 工具集注册
│   │   ├── mcp.ts           # MCP 客户端（心跳/重连）
│   │   ├── todo.ts          # Todo 工具
│   │   ├── plan.ts          # Plan 工具
│   │   └ web.ts             # Web 工具
│   │   └ memory.ts          # Memory 工具
│   ├── ui/
│   │   ├── box.ts           # UI 组件（Header/Spinner）
│   │   ├── markdown.ts      # Markdown 渲染
│   │   ├── status-bar.ts    # 状态栏
│   │   ├── stream-markdown.ts   # 流式 Markdown
│   │   ├── tool-preview.ts  # 工具预览卡片
│   │   └ suggestions.ts     # 命令建议
│   └── index.ts             # 公共 API 导出
├── tests/
│   ├── ui.test.ts           # UI 组件测试
│   ├── config.test.ts       # 配置测试
│   └ ...
├── docs/
│   ├── roadmap/             # 版本路线图
│   │   ├── v0.1.1.md
│   │   ├── v0.1.2.md
│   │   ├── v0.1.3.md
│   │   ├── v0.1.4.md
│   │   ├── v0.1.4-plus.md
│   │   └ v0.1.5.md
│   │   └ ...
│   ├── architecture.md      # 架构设计
│   ├── harness-design.md    # Harness 系统
│   └ memory-system.md       # 记忆系统
│   └ agent-lifecycle.md     # Agent 生命周期
├── .env.example             # 环境变量模板
├── package.json
└ tsconfig.json
└ LICENSE
└ README.md
```

---

## 📝 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENHORSE_API_KEY` | - | LLM API Key |
| `OPENHORSE_API_BASE_URL` | - | LLM API Base URL |
| `OPENHORSE_MODEL` | `gpt-4o` | 默认模型 |
| `OPENHORSE_MAX_TOKENS` | `4096` | 最大输出 token |
| `OPENHORSE_TEMPERATURE` | `0.7` | 温度 |
| `OPENHORSE_MODE` | `development` | 运行模式 |
| `OPENHORSE_LOG_LEVEL` | `info` | 日志级别 |
| `OPENHORSE_EMBEDDING_PROVIDER` | - | Embedding 服务（ollama/openai） |
| `OPENHORSE_BUDGET_LIMIT` | - | 预算限制（USD） |

---

## 📚 版本历史

### v0.1.5 - CLI 交互体验增强

- 状态栏：实时显示 token/cost/MCP 状态
- 流式 Markdown 渲染：代码块缓冲防断裂
- 工具预览卡片：工具执行结果可视化
- UI 组件测试

### v0.1.4-plus - 集成与健壮性

- MCP 客户端：心跳、断线重连、自动启动
- 状态管理：Todo/Plan 状态持久化
- 语义搜索：Embedding + Vector Store
- Skills 系统：技能加载与注入
- 原子写入：防止数据损坏
- 模型别名：Bailian 模型支持

### v0.1.4 - 工具扩展与 MCP

- 20+ 工具：File/Bash/Web/Memory/Todo/Plan
- MCP 协议支持
- 多模型支持

### v0.1.1 - v0.1.3 - 基础架构

- CLI 交互框架
- Harness 驾驭系统
- 记忆系统
- 会话管理

---

## 🔧 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 运行测试
npm test

# 代码检查
npm run lint

# 格式化
npm run format
```

---

## 📖 Roadmap

| 版本 | 目标 |
|------|------|
| v0.1.5 | CLI UX：状态栏、流式 Markdown、工具卡片 |
| v0.1.6 | Agent 增强：Router、多 Agent 协作 |
| v0.1.7 | Hooks 系统：工具调用前后钩子 |
| v0.1.8 | Cron 定时任务：定时执行、提醒 |
| v0.1.9 | VS Code 扩展 |
| v0.1.10 | Web UI |

详见 `docs/roadmap/` 目录。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📝 许可

MIT License - See [LICENSE](LICENSE) for details

---

**OpenHorse — Universal Agent Harness Framework.**

*"AI 如马，OpenHorse 如缰。"*