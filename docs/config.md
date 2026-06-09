# OpenHorse 配置说明

## 配置文件位置

```
~/.openhorse/openhorse.json
```

## 配置原则

**用户只需配置 3 项**，其余参数由 Agent 智能控制。

## 用户配置项

| 字段 | 类型 | 环境变量 | 默认值 | 说明 |
|------|------|----------|--------|------|
| `apiKey` | string | `OPENHORSE_API_KEY` | `""` | LLM API Key |
| `apiBaseUrl` | string | `OPENHORSE_API_BASE_URL` | `(OpenAI 默认)` | API 地址 |
| `defaultModel` | string | `OPENHORSE_MODEL` | `gpt-4o` | 默认模型 |

## Agent 内部控制（用户无需关心）

以下参数由 Agent 根据任务自动选择，**不暴露给用户配置**：

| 参数 | Agent 自适应策略 |
|------|-----------------|
| `maxTokens` | 代码 8192 / 分析 4096 / 简短 512 |
| `temperature` | 代码 0.1（确定性）/ 分析 0.3 / 创意 0.7 |
| `maxRetries` | 指数退避，自动调整（529 最多 5 次） |
| `retryBaseDelay` | 500ms → 1s → 2s → 4s 指数退避 |

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
  "defaultModel": "glm-5"
}
```

### OpenAI

```json
{
  "apiKey": "sk-xxx",
  "defaultModel": "gpt-4o"
}
```

### 本地 Ollama

```json
{
  "apiBaseUrl": "http://localhost:11434/v1",
  "defaultModel": "qwen2.5-coder:latest"
}
```

### 带备用模型

```json
{
  "apiKey": "sk-xxx",
  "defaultModel": "glm-5",
  "fallbackModel": "qwen-plus"
}
```

## 配置加载优先级

```
命令行参数 > ~/.openhorse/openhorse.json > 环境变量 > Agent 内部默认值
```
