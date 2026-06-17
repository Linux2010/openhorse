# OpenHorse

> **OpenHorse — Universal Agent Harness Framework**
> A CLI-driven coding agent with safety boundaries, tool orchestration, memory, and context management.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)
[![npm](https://img.shields.io/npm/v/openhorse.svg)](https://www.npmjs.com/package/openhorse)

---

**🌍 Language**: [English](README.md) | [简体中文](README.zh-CN.md)

---

## Overview

**OpenHorse** is a terminal-based coding agent that wraps LLM APIs in a harness of safety checks, tool orchestration, session management, and context awareness.

| Dimension | Description |
|-----------|-------------|
| **AI as Horse** | Powerful models need guidance and constraints |
| **OpenHorse as Reins** | Precise control to prevent runaway behavior |
| **Harness System** | Safety boundaries, task constraints, result validation |
| **Tool Calling** | LLM autonomously invokes tools to complete tasks |
| **Memory System** | Layered memory with semantic search |
| **MCP Protocol** | Connect external MCP servers for tool extension |

## Quick Start

### Requirements

- Node.js >= 18.0
- npm >= 9.0

### Install & Run

```bash
# Install globally
npm install -g openhorse

# Or from source
git clone https://github.com/Linux2010/openhorse.git
cd openhorse && npm install && npm run build

# Configure API key
export OPENHORSE_API_KEY=your-api-key
# or create ~/.openhorse/openhorse.json on first run

# Start
openhorse
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Tool Orchestration** | 20+ built-in tools: file I/O, shell, web, memory, git, LSP |
| **Multi-Model** | OpenAI, Claude, GLM, Qwen, DeepSeek, custom endpoints |
| **Context Awareness** | Per-model context windows, token-based auto-compact at 95% |
| **MCP Protocol** | stdio MCP servers with heartbeat + reconnect |
| **Memory System** | User / Project / Session memory with semantic search |
| **Session Management** | Persistent sessions with history restore |
| **Safety Boundaries** | Bash safety checks, audit logging, permission modes |
| **Streaming Output** | Real-time LLM responses with Markdown rendering |
| **Skills System** | Builtin, user, and project-level skill extensions |

## Configuration

Minimal user config — the agent controls internal parameters.

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://coding.dashscope.aliyuncs.com/v1",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus",
  "toolConfirmation": "allow"
}
```

| Field | Description |
|-------|-------------|
| `apiKey` | LLM API key |
| `apiBaseUrl` | API endpoint URL |
| `defaultModel` | Default model |
| `fallbackModel` | Fallback model on failure |
| `toolConfirmation` | Tool confirmation mode: `allow`, `deny`, or `ask` |
| `webSearch` | WebSearch mode/provider: `auto`, `tavily`, `brave`, `ddg` |

Configuration priority: `CLI flags > ~/.openhorse/openhorse.json > env vars > defaults`

See [docs/config.md](docs/config.md) for full details.

## Models

OpenHorse supports OpenAI-compatible providers and auto-discovers model context windows at startup via the `/models` endpoint.

| Provider | Example Models |
|----------|---------------|
| **GLM (智谱)** | `glm-5`, `glm-4` |
| **Qwen (通义)** | `qwen-turbo`, `qwen-plus`, `qwen-max`, `qwen-long` |
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `gpt-4` |
| **Claude** | `claude-sonnet-4-6`, `claude-opus-4-8` |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner` |

Context usage is tracked in real tokens. When usage reaches **95%**, auto-compact generates a summary of early messages to free up space.

```bash
/model               # Show current model
/model list          # List all available models
/model glm-5         # Switch to GLM-5
```

## Tools

20+ built-in tools the LLM can invoke:

| Category | Tools |
|----------|-------|
| **File** | `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep` |
| **Shell** | `exec_command` (with safety checks) |
| **Network** | `web_fetch`, `web_search` |
| **Memory** | `memory_save`, `memory_recall`, `memory_forget` |
| **Task** | `todo_write`, `enter_plan_mode`, `exit_plan_mode` |
| **Git** | `git_command` |
| **MCP** | Connected MCP server tools (e.g. `mcp__filesystem__read_file`) |

## MCP Protocol

OpenHorse connects stdio MCP servers and exposes their tools to the agent.

```json
// ~/.openhorse/mcp.json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["path/to/plugin-telegram/dist/index.js"]
    }
  }
}
```

```bash
/mcp                # Show MCP server connection status
```

## Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` `/h` | Show help |
| `/status` `/s` | System status |
| `/model` | View or switch models |
| `/config` | Show configuration |
| `/cost` | Token usage and cost |
| `/compact` | Trigger context compact |
| `/sessions` | List recent sessions |
| `/resume` | Resume last session |
| `/memory` | Memory system status |
| `/skills` | List loaded skills |
| `/mcp` | MCP server status |
| `/clear` | Clear screen |
| `/exit` `/q` | Exit |

## Development

```bash
npm install      # Install dependencies
npm run dev      # Development mode (hot reload)
npm run build    # Build
npm test         # Run tests
npm run lint     # Lint
npm run format   # Format
```

## Contributing

Issues and Pull Requests are welcome!

## License

MIT License — see [LICENSE](LICENSE) for details.

---

**OpenHorse — Universal Agent Harness Framework.**

*"AI as a horse, OpenHorse as the reins."*
