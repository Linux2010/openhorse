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
  "toolConfirmation": "allow"
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
