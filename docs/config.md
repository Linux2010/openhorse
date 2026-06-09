# OpenHorse 配置说明

## 配置文件位置

```
~/.openhorse/openhorse.json
```

首次运行时自动创建此目录。可通过 `OPENHORSE_CONFIG_DIR` 环境变量自定义路径。

## 配置加载优先级

```
命令行参数 > ~/.openhorse/openhorse.json > 环境变量 > 默认值
```

例如 API Key 的加载顺序：
1. 启动参数 `--apiKey xxx`
2. `~/.openhorse/openhorse.json` 中的 `apiKey`
3. 环境变量 `OPENHORSE_API_KEY`
4. 空字符串（未配置）

## 完整配置项

### LLM 配置

| 字段 | 类型 | 必填 | 环境变量 | 默认值 | 说明 |
|------|------|------|----------|--------|------|
| `apiKey` | string | 否 | `OPENHORSE_API_KEY` | `""` | LLM API Key |
| `apiBaseUrl` | string | 否 | `OPENHORSE_API_BASE_URL` | `(OpenAI 默认)` | API 地址 |
| `defaultModel` | string | 是 | `OPENHORSE_MODEL` | `gpt-4o` | 默认模型 |
| `fallbackModel` | string | 否 | `OPENHORSE_FALLBACK_MODEL` | `(无)` | 备用模型 |
| `maxTokens` | number | 否 | `OPENHORSE_MAX_TOKENS` | `4096` | 最大输出 token |
| `temperature` | number | 否 | `OPENHORSE_TEMPERATURE` | `0.7` | 温度 (0-2) |
| `maxRetries` | number | 否 | `OPENHORSE_MAX_RETRIES` | `3` | 最大重试次数 |
| `retryBaseDelay` | number | 否 | `OPENHORSE_RETRY_BASE_DELAY` | `500` | 重试基础延迟 (ms) |

### 预算配置

| 字段 | 类型 | 必填 | 环境变量 | 默认值 | 说明 |
|------|------|------|----------|--------|------|
| `budgetLimit` | number | 否 | `OPENHORSE_BUDGET` | `(无限制)` | 预算上限 (USD) |

### 统计信息（自动维护）

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalSessions` | number | 总会话数 |
| `totalTokens` | number | 累计 token 消耗 |
| `totalCost` | number | 累计费用 (USD) |

### 用户信息（自动生成）

| 字段 | 类型 | 说明 |
|------|------|------|
| `userId` | string | 用户唯一 ID（自动生成） |
| `firstStartTime` | string | 首次启动时间 (ISO 格式) |

### 项目配置（可选）

```json
{
  "projects": {
    "/path/to/project": {
      "allowedTools": ["read_file", "write_file", "exec_command"],
      "lastModel": "glm-5"
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowedTools` | string[] | 允许使用的工具列表 |
| `lastSessionId` | string | 最后会话 ID |
| `lastModel` | string | 最后使用的模型 |
| `hasTrustDialogAccepted` | boolean | 是否已接受信任对话框 |

## 常用场景配置

### 场景 1: OpenAI

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://api.openai.com/v1",
  "defaultModel": "gpt-4o"
}
```

### 场景 2: DashScope (通义千问 / GLM)

```json
{
  "apiKey": "sk-xxx",
  "apiBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "defaultModel": "glm-5"
}
```

### 场景 3: 本地 Ollama

```json
{
  "apiBaseUrl": "http://localhost:11434/v1",
  "defaultModel": "qwen2.5-coder:latest"
}
```

### 场景 4: 带预算限制

```json
{
  "apiKey": "sk-xxx",
  "defaultModel": "claude-sonnet-4-6",
  "maxTokens": 8192,
  "budgetLimit": 10.0
}
```

## 完整示例

```json
{
  "apiKey": "sk-sp-1f07658367b9409393e075f9f63490bf",
  "apiBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus",
  "maxTokens": 4096,
  "temperature": 0.7,
  "maxRetries": 3,
  "retryBaseDelay": 500,
  "budgetLimit": 5.0,
  "userId": "a1b2c3d4e5f6...",
  "firstStartTime": "2026-05-03T09:18:25.547Z",
  "totalSessions": 116,
  "totalTokens": 0,
  "totalCost": 0,
  "projects": {}
}
```

## 环境变量速查

| 环境变量 | 对应字段 | 示例值 |
|----------|----------|--------|
| `OPENHORSE_API_KEY` | `apiKey` | `sk-xxx` |
| `OPENHORSE_API_BASE_URL` | `apiBaseUrl` | `https://api.openai.com/v1` |
| `OPENHORSE_BASE_URL` | `apiBaseUrl` (备用) | `https://...` |
| `OPENHORSE_MODEL` | `defaultModel` | `gpt-4o` |
| `OPENHORSE_FALLBACK_MODEL` | `fallbackModel` | `claude-sonnet-4-6` |
| `OPENHORSE_MAX_TOKENS` | `maxTokens` | `4096` |
| `OPENHORSE_TEMPERATURE` | `temperature` | `0.7` |
| `OPENHORSE_MAX_RETRIES` | `maxRetries` | `3` |
| `OPENHORSE_RETRY_BASE_DELAY` | `retryBaseDelay` | `500` |
| `OPENHORSE_BUDGET` | `budgetLimit` | `10` |
| `OPENHORSE_NAME` | `name` | `openhorse` |
| `OPENHORSE_MODE` | `mode` | `development` |
| `OPENHORSE_LOG_LEVEL` | `logLevel` | `info` |
| `OPENHORSE_CONFIG_DIR` | 配置目录 | `~/.openhorse` |

## 命令行参数

通过 `npx tsx src/cli-ink.tsx` 启动时可传递参数覆盖配置（通过 `loadConfig(overrides)` 传入）。
