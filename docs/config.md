# OpenHorse 配置说明

## 配置文件位置

```
~/.openhorse/openhorse.json
```

## 配置原则

**用户只需配置少量核心项**，其余参数由 Agent 智能控制。

## 用户配置项

| 字段 | 类型 | 环境变量 | 默认值 | 说明 |
|------|------|----------|--------|------|
| `apiKey` | string | `OPENHORSE_API_KEY` | `""` | LLM API Key |
| `apiBaseUrl` | string | `OPENHORSE_API_BASE_URL` | `(OpenAI 默认)` | API 地址 |
| `defaultModel` | string | `OPENHORSE_MODEL` | `gpt-4o` | 默认模型 |
| `fallbackModel` | string | `OPENHORSE_FALLBACK_MODEL` | `(无)` | 备用模型（主模型过载时自动切换） |
| `toolConfirmation` | `allow` \| `deny` \| `ask` | `OPENHORSE_TOOL_CONFIRMATION` | `allow` | 工具需要确认时的兜底策略；当前 CLI 无交互确认 UI，默认自动允许 `ask` 级工具 |
| `ui.renderer` | `legacy` \| `v2` | `OPENHORSE_UI` / `OPENHORSE_UI_RENDERER` | `v2` | 终端 UI renderer。`v2` 是默认新 UI，`legacy` 用于回退 |
| `ui.confirmations` | `config` \| `interactive` | `OPENHORSE_UI_CONFIRMATIONS` | `config` | 工具确认由配置兜底，还是交给交互式 UI |
| `webSearch.provider` | string | `OPENHORSE_WEBSEARCH_PROVIDER` | `auto` | WebSearch 模式或 provider。`auto` 先 MCP 后 adapter；可设 `native`、`bailian`、`zhipu`、`tavily-mcp`、`tavily`、`brave`、`custom`、`ddg` |
| `webSearch.apiKey` | string | `OPENHORSE_WEBSEARCH_API_KEY` / provider env | 主 `apiKey` | WebSearch MCP 或 adapter API Key；未设置时 MCP 复用 OpenHorse 主 API Key |
| `webSearch.endpoint` | string | `OPENHORSE_WEBSEARCH_MCP_ENDPOINT` | provider 默认值 | WebSearch MCP Streamable HTTP Endpoint |
| `webSearch.toolName` | string | `OPENHORSE_WEBSEARCH_MCP_TOOL` | 自动发现 | MCP 服务暴露多个工具时指定搜索工具名 |
| `webSearch.authType` | `bearer` \| `header` \| `query` \| `none` | `OPENHORSE_WEBSEARCH_AUTH_TYPE` | `bearer` | API Key 注入方式 |
| `webSearch.apiKeyHeader` | string | `OPENHORSE_WEBSEARCH_API_KEY_HEADER` | `Authorization` | `bearer` / `header` 模式下使用的 header 名 |
| `webSearch.apiKeyQueryParam` | string | `OPENHORSE_WEBSEARCH_API_KEY_QUERY_PARAM` | provider 默认值 | `query` 模式下使用的查询参数名 |

## Agent 内部控制（用户无需关心）

以下参数由 Agent 根据任务自动选择，**不暴露给用户配置**：

| 参数 | Agent 默认值 | 说明 |
|------|-------------|------|
| `maxTokens` | 8192 | 代码场景需要足够长输出 |
| `temperature` | 0.1 | 代码场景需要确定性输出 |
| `maxRetries` | 3 | 指数退避，自动调整 |
| `retryBaseDelay` | 500ms | 500ms → 1s → 2s → 4s |

## 内部统计（自动生成）

| 字段 | 说明 |
|------|------|
| `totalSessions` | 总会话数 |
| `totalTokens` | 累计 token 消耗 |
| `totalCost` | 累计费用 (USD) |
| `userId` | 用户唯一 ID（自动生成） |
| `firstStartTime` | 首次启动时间 |

## 配置示例

### 最小配置（推荐）

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus",
  "toolConfirmation": "allow",
  "ui": {
    "renderer": "v2",
    "confirmations": "config"
  }
}
```

### OpenAI

```json
{
  "apiKey": "sk-xxx",
  "defaultModel": "gpt-4o",
  "toolConfirmation": "allow"
}
```

### 本地 Ollama

```json
{
  "apiBaseUrl": "http://localhost:11434/v1",
  "defaultModel": "qwen2.5-coder:latest",
  "toolConfirmation": "allow"
}
```

## Tool Confirmation

`toolConfirmation` only applies when a tool returns `ask` from its permission check and the session is in the default permission mode.

- `allow`: run the tool without prompting. This is the current default because the non-Ink CLI cannot show interactive confirmations.
- `deny`: reject tools that would need confirmation while still allowing safe/read-only tools.
- `ask`: preserve the confirmation-required result. Use this after an interactive prompt UI is available.

Tools that return `deny` from safety checks are still blocked regardless of this setting.

## UI

v0.1.20 开始引入 `ui-v2`，先把 shell header、prompt、status line、command suggestion / picker / command palette 抽成状态驱动模块，再逐步迁移完整 PromptInput、permission dialog 和 transcript viewer。v0.1.21 起，`v2` 是默认 renderer。

- `ui.renderer: "v2"`：默认模式，启动 header、prompt、status line、command palette 和 session picker 使用 v2 风格。
- `ui.renderer: "legacy"`：回退到旧 CLI renderer。
- `ui.confirmations: "config"`：工具确认沿用 `toolConfirmation` 兜底。
- `ui.confirmations: "interactive"`：预留给后续 permission dialog。

v2 参考 Codex CLI 的 keyboard-first 交互，当前支持：

- `/` 打开命令面板。
- `@` 打开文件补全。
- `?` 在空输入时显示快捷键面板。
- `Ctrl+R` 搜索历史输入。
- `Ctrl+L` 清空当前终端视图，但保留会话上下文。
- `Ctrl+C` 退出或取消当前多行输入。

环境变量示例：

```bash
OPENHORSE_UI=legacy npx openhorse
```

## WebSearch

`web_search` 参考 OpenClaude 的分层策略：`auto` 模式先调用当前模型 provider 对应的 WebSearch MCP；如果 MCP 不可用或被 provider 拒绝，再尝试 adapter 链。显式指定 `native` / `bailian` / `zhipu` / `tavily-mcp` 时只走 MCP；显式指定 `tavily` / `brave` / `custom` / `ddg` 时只走 adapter。

### MCP Profiles

OpenHorse 内置 MCP provider profile，会根据 `apiBaseUrl` / model 自动推断：

| Provider | 匹配条件 | 默认 endpoint | 默认 Key |
|----------|----------|---------------|----------|
| `bailian` | `apiBaseUrl` 包含 `dashscope.aliyuncs.com` 或 `coding.dashscope.aliyuncs.com` | `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp` | `OPENHORSE_WEBSEARCH_API_KEY` → `DASHSCOPE_API_KEY` → 主 `apiKey` |
| `zhipu` | `apiBaseUrl` 包含 `bigmodel.cn`，或非 DashScope 的 `glm*` 模型 | `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp` | `OPENHORSE_WEBSEARCH_API_KEY` → `GLM_API_KEY` / `ZHIPU_API_KEY` / `BIGMODEL_API_KEY` → 主 `apiKey` |
| `tavily-mcp` | 显式设置 `webSearch.provider` / `OPENHORSE_WEBSEARCH_PROVIDER` | `https://mcp.tavily.com/mcp/` | `TAVILY_API_KEY`，通过 query 参数 `tavilyApiKey` |

通常不需要在 `~/.openhorse/openhorse.json` 里写 `webSearch`。如果当前模型 provider 的 MCP 接受同一个 key，OpenHorse 会自动复用主 `apiKey`。

百炼普通 Key 可以通过环境变量覆盖：

```bash
export DASHSCOPE_API_KEY=sk-xxx
```

也可以使用 OpenHorse 专用环境变量：

```bash
export OPENHORSE_WEBSEARCH_API_KEY=sk-xxx
```

### Adapter Fallbacks

`auto` 模式下 MCP 失败后会按顺序尝试 adapter：

1. `tavily`：需要 `TAVILY_API_KEY`
2. `brave`：需要 `BRAVE_API_KEY`
3. `custom`：需要 `OPENHORSE_WEBSEARCH_API` 或 `WEB_SEARCH_API`
4. `ddg`：DuckDuckGo HTML fallback，无需 key，但可能被限流或被网络环境阻断

示例：

```bash
export OPENHORSE_WEBSEARCH_PROVIDER=tavily
export TAVILY_API_KEY=tvly-xxx
```

只有需要覆盖 MCP provider、endpoint、toolName、headers 或鉴权方式时，才添加 `webSearch`：

```json
{
  "webSearch": {
    "provider": "bailian",
    "endpoint": "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
    "apiKey": "sk-xxx",
    "authType": "bearer"
  }
}
```

实测：当前 `sk-sp` Coding Plan key 请求官方百炼 WebSearch MCP endpoint 返回 `401`，几个 `coding.dashscope.aliyuncs.com/.../WebSearch/mcp` 猜测路径返回 `404`。OpenHorse 不会本地拦截 `sk-sp`；如果 provider 后续支持同一个 key，会直接工作，否则会返回真实 HTTP 错误并提示覆盖 `webSearch.provider` / `endpoint` / `apiKey`。

在默认 `auto` 模式下，上述 MCP 失败会继续走 adapter fallback；如果你希望严格只测 MCP，设置：

```bash
export OPENHORSE_WEBSEARCH_PROVIDER=native
```

## 配置加载优先级

```
命令行参数 > ~/.openhorse/openhorse.json > 环境变量 > Agent 内部默认值
```

## OpenClaude 参考

OpenClaude 的用户配置方式：
- `--model` / 设置 → 主模型
- `--fallback-model` → 备用模型（过载时自动切换）
- Provider Profile → apiKey + baseUrl + model 持久化
- 其余参数（temperature, max_tokens 等）由内部根据任务自动选择
