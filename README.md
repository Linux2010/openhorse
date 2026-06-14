# OpenHorse

> **OpenHorse — Universal Agent Harness Framework**
> A CLI-driven coding agent with safety boundaries, tool orchestration, memory, and context management.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)
[![npm](https://img.shields.io/npm/v/openhorse.svg)](https://www.npmjs.com/package/openhorse)

---

**🌍 Language**: English | [简体中文](README.zh-CN.md)

---

## Overview

**OpenHorse** is a terminal-based coding agent that wraps LLM APIs in a harness of safety checks, tool orchestration, session management, and context awareness.

### Core Design

| Dimension | Description |
|-----------|-------------|
| **AI as Horse** | Powerful models need guidance and constraints |
| **OpenHorse as Reins** | Precise control to prevent runaway behavior |
| **Harness System** | Safety boundaries, task constraints, result validation |
| **Tool Calling** | LLM autonomously invokes tools to complete tasks |
| **Memory System** | Layered memory: Working / Short-term / Long-term / Semantic |
| **MCP Protocol** | Connect external MCP servers for tool extension |

---

## Features

| Feature | Description |
|---------|-------------|
| **Tool Orchestration** | 20+ built-in tools: file I/O, search, shell, web, memory, todo, plan |
| **Multi-Model** | OpenAI, Claude, DashScope (GLM/Qwen/Kimi), custom endpoints |
| **Context Awareness** | Per-model context windows, token-based auto-compact at 95% |
| **Dynamic Discovery** | Auto-discovers models via `/models` endpoint at startup |
| **MCP Protocol** | Full MCP server connection with heartbeat + reconnect |
| **Memory System** | User / Project / Session memory with semantic search |
| **Session Management** | Persistent sessions, history restore, summary generation |
| **Safety Boundaries** | Bash safety checks, audit logging, permission modes |
| **Streaming Output** | Real-time LLM responses with Markdown rendering |
| **Status Bar** | Live token usage, cost, model, context % display |
| **Simplified Config** | Only 4 user fields — agent controls internals |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLI Layer                              │
│   readline + chalk + streaming Markdown + status bar     │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Harness Layer                          │
│  Goal constraints │ Safety checks │ Result validation   │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Query Engine                           │
│  LLM Stream │ Tool Calling │ Retry/Fallback │ Compact    │
└──────────┬─────────────────┬─────────────────┬──────────┘
           │                 │                 │
┌──────────▼─────┐ ┌─────────▼─────┐ ┌─────────▼──────────┐
│   Tools        │ │  MCP Client   │ │   Skills           │
│  File/Bash/Web │ │  Server conn  │ │  Builtin/User/Proj │
└─────────────────┘ └───────────────┘ └───────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Memory Layer                           │
│  User │ Project │ Session │ Semantic Search │ Embeddings │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Requirements

- Node.js >= 18.0
- npm >= 9.0

### Install & Run

```bash
# Clone
git clone https://github.com/Linux2010/openhorse.git
cd openhorse

# Install
npm install

# Build
npm run build

# Configure API Key (choose one)
# Option 1: Environment variable
export OPENHORSE_API_KEY=your-api-key

# Option 2: .env file
cp .env.example .env
# Edit .env and set OPENHORSE_API_KEY

# Option 3: ~/.openhorse/openhorse.json (recommended)
# Created automatically on first run

# Start interactive CLI
npm start
# or
node dist/cli.js
```

### Global Install

```bash
npm link
# Run from any directory
openhorse
```

---

## Configuration

### User Config (`~/.openhorse/openhorse.json`)

Only a small set of fields are user-configurable. The agent controls internal generation parameters.

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://coding.dashscope.aliyuncs.com/v1",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus",
  "toolConfirmation": "allow"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `apiKey` | Yes | LLM API key |
| `apiBaseUrl` | No | API endpoint URL |
| `defaultModel` | No | Default model (`glm-5`) |
| `fallbackModel` | No | Fallback model on failure |
| `toolConfirmation` | No | How to handle tools that ask for confirmation: `allow`, `deny`, or `ask`. Defaults to `allow` until the Ink UI can prompt interactively. |

### Agent-Controlled Internals

These parameters are managed by the agent, not exposed to users:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxTokens` | 8192 | Maximum output tokens |
| `temperature` | 0.1 | Sampling temperature |
| `maxRetries` | 3 | Retry attempts on failure |
| `retryBaseDelay` | 1000ms | Base delay between retries |

### Configuration Priority

```
CLI flags > ~/.openhorse/openhorse.json > env vars > internal defaults
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENHORSE_API_KEY` | - | LLM API key |
| `OPENHORSE_API_BASE_URL` | - | API base URL |
| `OPENHORSE_MODEL` | `glm-5` | Default model |
| `OPENHORSE_MODE` | `development` | Run mode |
| `OPENHORSE_LOG_LEVEL` | `info` | Log level |
| `OPENHORSE_TOOL_CONFIRMATION` | `allow` | Tool confirmation fallback: `allow`, `deny`, or `ask` |
| `OPENHORSE_EMBEDDING_PROVIDER` | - | Embedding service (ollama/openai) |

See [docs/config.md](docs/config.md) for full details.

---

## Models

### Supported Model Families

| Provider | Models | Endpoint |
|----------|--------|----------|
| **GLM (智谱)** | `glm-5`, `glm-4` | DashScope coding |
| **Qwen (通义)** | `qwen-turbo`, `qwen-plus`, `qwen-max`, `qwen-long` | DashScope coding |
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `gpt-4` | OpenAI API |
| **Claude** | `claude-sonnet-4-6`, `claude-opus-4-8` | Anthropic API |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner` | DeepSeek API |

### Context Windows

OpenHorse tracks each model's context window and auto-compacts at **95% usage**:

| Model | Context | Max Output |
|-------|---------|------------|
| `glm-5` | 202,752 | 8,192 |
| `qwen-long` | 1,000,000 | 8,192 |
| `qwen-plus` | 131,072 | 8,192 |
| `gpt-4o` | 128,000 | 16,384 |
| `claude-sonnet-4-6` | 200,000 | 16,000 |
| `claude-opus-4-8` | 200,000 | 32,000 |

Unknown models default to **128,000** context.

### Dynamic Discovery

At startup, OpenHorse queries the `/models` endpoint for context window data. If unsupported (e.g., DashScope coding returns 404), it falls back to the builtin database silently.

### Model Commands

```bash
/model               # Show current model
/model list          # List all available models
/model glm-5         # Switch to GLM-5
```

---

## Tools

20+ built-in tools available for LLM invocation:

### File Operations

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write to a file |
| `edit_file` | Edit file (line replacement) |
| `list_files` | List directory contents |
| `glob` | Glob pattern file search |
| `grep` | Regex search file contents |

### Shell

| Tool | Description |
|------|-------------|
| `exec_command` | Execute shell command (with safety checks) |

### Network

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch web page content |
| `web_search` | Web search |

### Memory

| Tool | Description |
|------|-------------|
| `memory_save` | Save a memory entry |
| `memory_recall` | Search memories |
| `memory_forget` | Delete a memory entry |

### Task Management

| Tool | Description |
|------|-------------|
| `todo_write` | Create/update todo list |
| `enter_plan_mode` | Enter plan mode |
| `exit_plan_mode` | Exit plan mode |

---

## Context Management

### Auto-Compact

When context usage reaches **95%**, OpenHorse automatically compacts the conversation history:

1. **Generates a summary** of early messages via the LLM
2. **Replaces** old messages with a `[Context Summary]` block
3. **Preserves** the system message and recent messages
4. **Displays** compact notification in the status bar

```
Compact: 30 → 8 messages | Context: 45% → 12%
```

### Token-Based Threshold

Unlike message-count-based approaches, OpenHorse uses **actual token counts** from the API response for precise context awareness:

```
ctxPercent = (promptTokens / modelContextWindow) × 100
```

Compact triggers only when `ctxPercent >= 95%`, not based on message count.

### 30-Second Interval

To avoid over-compact, auto-compact runs at most once per 30 seconds. Manual `/compact` command bypasses this interval.

---

## MCP Protocol

Full support for MCP (Model Context Protocol) servers:

### Configure MCP Servers

Create `~/.openhorse/mcp.json`:

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
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/allowed/dir"]
    }
  }
}
```

### MCP Commands

```bash
/mcp                # Show MCP server connection status
```

Servers connect automatically at startup with heartbeat monitoring and exponential backoff reconnect.

---

## Interactive Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `/help` | `/h` | Show help information |
| `/status` | `/s` | System status overview |
| `/model` | - | View or switch models |
| `/config` | - | Show current configuration |
| `/cost` | - | Show session token usage and cost |
| `/compact` | - | Manually trigger context compact |
| `/sessions` | - | List recent sessions |
| `/resume` | - | Resume last session |
| `/memory` | - | Memory system status |
| `/memory reindex` | - | Rebuild semantic search index |
| `/skills` | - | List loaded skills |
| `/mcp` | - | MCP server status |
| `/agents` | - | List available agents |
| `/safety` | - | Safety check configuration |
| `/task` | - | Task management |
| `/run` | - | Execute task via agent |
| `/clear` | - | Clear screen |
| `/clear-history` | `/reset` | Clear conversation history |
| `/exit` | `/q` | Exit |

---

## Project Structure

```
openhorse/
├── bin/
│   └── openhorse                  # CLI entry point
├── src/
│   ├── cli.ts                     # CLI interactive entry
│   ├── commands/                  # Slash commands
│   │   ├── index.ts               # Command registry
│   │   ├── parser.ts              # Input parser
│   │   └── types.ts               # Command types
│   ├── core/                      # Core logic
│   │   ├── agent.ts               # Agent base class
│   │   ├── brain.ts               # Decision engine
│   │   └── strategy-tracker.ts    # Strategy tracking
│   ├── agents/                    # Agent implementations
│   │   ├── leader.ts              # Coordinator agent
│   │   ├── coder.ts               # Coding agent
│   │   └── router.ts              # Agent router
│   ├── framework/
│   │   ├── store.ts               # State management
│   │   ├── query.ts               # Query engine (async generator)
│   │   └── tool-state.ts          # Tool state
│   ├── harness/                   # Safety & constraints
│   │   ├── safety.ts              # Safety boundary checks
│   │   └── bash-safety.ts         # Bash command safety
│   ├── memory/                    # Memory system
│   │   ├── storage.ts             # Memory storage
│   │   ├── semantic-search.ts     # Semantic search
│   │   ├── embeddings.ts          # Embedding generation
│   │   └── vector-store.ts        # Vector store (SQLite vec0)
│   ├── skills/                    # Skill system
│   │   ├── loader.ts              # Skill loader
│   │   └── registry.ts            # Skill registry
│   ├── services/
│   │   ├── llm.ts                 # LLM service (retry/fallback)
│   │   ├── config.ts              # Config loading
│   │   ├── global-config.ts       # Global config
│   │   ├── model-context.ts       # Model context window DB + discovery
│   │   ├── session-storage.ts     # Session persistence
│   │   ├── atomic-write.ts        # Atomic file writes
│   │   ├── agent-runner.ts        # Agent runner
│   │   ├── task-manager.ts        # Task manager
│   │   └── file-glob.ts           # File matching
│   ├── services/compact/          # Context compaction
│   │   ├── auto-compact.ts        # Token-based auto-compact
│   │   ├── compact.ts             # Compact implementation
│   │   └── summary-generator.ts   # Summary generation
│   ├── tools/                     # Tool implementations
│   │   ├── index.ts               # Tool registry
│   │   ├── mcp.ts                 # MCP client
│   │   ├── todo.ts                # Todo tool
│   │   ├── plan.ts                # Plan tool
│   │   ├── web.ts                 # Web tools
│   │   └── memory.ts              # Memory tools
│   └── ui/                        # UI components
│       ├── box.ts                 # UI boxes
│       ├── markdown.ts            # Markdown rendering
│       ├── status-bar.ts          # Status bar
│       ├── stream-markdown.ts     # Streaming Markdown
│       ├── tool-preview.ts        # Tool preview cards
│       └── suggestions.ts         # Command suggestions
├── tests/                         # Test suite
├── docs/                          # Documentation
│   ├── version/                   # Version release notes
│   ├── roadmap/                   # Version roadmaps
│   └── config.md                  # Configuration guide
├── .env.example                   # Environment template
├── package.json
└── tsconfig.json
```

---

## Version History

### v0.1.16 (Current — in development)

- **Token-based auto-compact** at 95% context usage (replaces message-count threshold)
- **Model context awareness** — per-model context windows (15+ known models)
- **Dynamic model discovery** — queries `/models` endpoint at startup
- **Simplified user config** — core fields: `apiKey`, `apiBaseUrl`, `defaultModel`, `fallbackModel`, `toolConfirmation`
- **Agent-controlled internals** — `maxTokens`, `temperature`, `retries` managed internally
- **Fallback model** configurable by user
- **Streamlined command panel** rendering
- **Context harness workflow** for multi-agent context orchestration

### v0.1.15

- **Full Markdown streaming** rendering with syntax highlighting
- **CJK text width** calculation fix for terminal display
- **Command panel** input clearing improvements
- Table rendering removed (raw passthrough)

### v0.1.14

- LSP crash fix, compact UI, concise agent output

### v0.1.10 — v0.1.13

- MCP client with heartbeat/reconnect, semantic search, skills system, atomic writes, model aliases (Bailian), storage fixes

### v0.1.1 — v0.1.9

- CLI framework, harness system, memory system, session management, tool orchestration

See `docs/version/` for detailed release notes.

---

## Development

```bash
# Install dependencies
npm install

# Development mode (hot reload)
npm run dev

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Format
npm run format
```

---

## Roadmap

| Version | Target |
|---------|--------|
| v0.1.16 | Context awareness, auto-compact, config simplification |
| v0.1.17 | Agent lifecycle improvements, enhanced tool orchestration |
| v0.1.18 | Plugin/hook system for extensibility |
| v0.1.19 | VS Code extension |
| v0.1.20 | Web UI dashboard |

See `docs/roadmap/` for details.

---

## Contributing

Issues and Pull Requests are welcome!

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

**OpenHorse — Universal Agent Harness Framework.**

*"AI as a horse, OpenHorse as the reins."*
