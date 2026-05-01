# Rein

> **Rein the AI, Unleash the Potential.**
> 通用 Agent 驾驭框架 — Universal Agent Harness Framework

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)

---

## 🎯 项目定位

**Rein**（缰绳）—— 让 Agent 不跑偏的通用驾驭框架。

> Agent 容易跑偏，所以需要 Harness。
> Rein 就是那根缰绳：给 AI 自由度，同时保持控制力。

### 核心理念

| 维度 | 说明 |
|------|------|
| **🐴 AI 如马** | 强大的 AI 模型需要引导和约束 |
| **🪢 Rein 如缰** | 精准控制方向，防止跑偏失控 |
| **🎯 Harness 系统** | 安全边界、任务约束、结果验证 |

---

## 🏗️ 架构设计

```
┌─────────────────────────────────────────┐
│         Harness 驾驭层                    │
│  目标约束 │ 边界检查 │ 结果验证 │ 安全沙箱  │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│          Brain 决策层                     │
│  任务分解 │ 优先级 │ 路由 │ 状态管理       │
└─────────┬─────────┬─────────┬──────────┘
          │         │         │
┌─────────▼┐ ┌──────▼──┐ ┌────▼──────┐
│ Coder    │ │Analyst  │ │Ops Agent  │
└────┬─────┘ └────┬────┘ └────┬──────┘
     │            │            │
┌────▼────────────▼────────────▼──────┐
│          Skills + Tools              │
│  Web │ Browser │ Git │ DB │ MCP     │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│          Memory 记忆层                │
│  Working │ Short-term │ Long-term    │
└─────────────────────────────────────┘
```

---

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0
- npm >= 9.0

### 安装与运行

```bash
# 克隆项目
git clone https://github.com/Linux2010/rein-agent.git
cd rein-agent

# 安装依赖
npm install

# 复制环境变量（可选）
cp .env.example .env

# 启动交互式 CLI（默认模式）
npm start

# 或直接运行
npx ts-node src/cli.ts
```

### 命令行模式

```bash
# 系统状态概览
npm start -- status

# 查看已注册 Agent
npm start -- agents

# 查看安全检查配置
npm start -- safety

# 提交测试任务
npm start -- task "我的任务"
```

### 交互命令

启动后进入交互模式，支持以下命令：

| 命令 | 说明 |
|------|------|
| `help` / `h` | 显示帮助信息 |
| `status` / `s` | 系统状态总览 |
| `agents` | 列出 Agent 及其状态 |
| `memory` | 记忆系统状态 |
| `safety` | 安全检查器状态 |
| `harness` | Harness 配置详情 |
| `task <name>` | 提交测试任务 |
| `clear` | 清屏 |
| `exit` / `quit` / `q` | 退出 |

---

## 📚 文档

| 文档 | 说明 |
|------|------|
| [整体架构设计](docs/architecture.md) | 6 层架构、模块职责、技术选型、MVP 范围 |
| [Harness 驾驭系统](docs/harness-design.md) | 四层防御：目标约束/边界检查/结果验证/安全沙箱 |
| [记忆系统设计](docs/memory-system.md) | 三层记忆：Working/Short-term/Long-term |
| [Agent 生命周期](docs/agent-lifecycle.md) | 5 状态状态机、Brain 调度、多 Agent 协作 |

---

## 📁 项目结构

```
rein-agent/
├── src/
│   ├── cli.ts              # 命令行交互入口
│   ├── index.ts            # 公共 API 导出
│   ├── init.ts             # 统一初始化入口
│   ├── core/
│   │   ├── agent.ts        # Agent 基类
│   │   └── brain.ts        # 决策引擎
│   ├── agents/
│   │   ├── leader.ts       # 协调者 Agent
│   │   └── coder.ts        # 编码专家 Agent
│   ├── harness/
│   │   └── safety.ts       # 安全边界检查
│   └── memory/
│       └── store.ts        # 记忆系统存储
├── .env.example            # 环境变量模板
├── package.json
└── tsconfig.json
```

---

## 📦 核心特性

| 特性 | 说明 |
|------|------|
| **Harness 驾驭系统** | 目标约束、边界检查、结果验证 |
| **多 Agent 编排** | Leader/Worker 协作模式 |
| **技能插件化** | 可扩展 Skills 和 Tools |
| **记忆分层** | 工作记忆 / 短期 / 长期 |
| **安全边界** | 操作白名单、危险模式检测、审计日志 |
| **任务驱动** | 优先级调度、能力匹配 |
| **本地优先** | 隐私保护，可选云端 |

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

## 📝 环境变量

复制 `.env.example` 为 `.env` 进行配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REIN_MODE` | `development` | 运行模式 |
| `REIN_LOG_LEVEL` | `info` | 日志级别 |
| `REIN_NAME` | `rein-agent` | 实例名称 |

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📝 许可

MIT License - See [LICENSE](LICENSE) for details

---

**Rein the AI, Unleash the Potential.** 🐴
