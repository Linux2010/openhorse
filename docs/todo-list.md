# OpenHorse Todo List

## Phase 3 - 高级 Agent

### 成本追踪 ✅ 已完成

- [x] CostTracker 类 - 记录 token 使用和估算成本
- [x] 模型定价表 - 支持 OpenAI/Claude/Qwen/Gemini/DeepSeek/GLM
- [x] 统计维度 - 按 Agent/任务/模型/时间
- [x] 预算检查 - setBudget/checkBudget
- [x] /cost 命令 - 显示会话用量和成本

**提交**: [668171d](https://github.com/Linux2010/openhorse/commit/668171d)

**新增文件**:
- `src/core/cost-tracker.ts` - CostTracker 类
- `tests/cost-tracker.test.ts` - 20 个测试用例

**修改文件**:
- `src/framework/store.ts` - 添加 costTracker 字段
- `src/framework/query.ts` - 执行后记录 usage
- `src/commands/index.ts` - 添加 /cost 命令

**测试**: 154 passed ✅

---

### 待完成

- [ ] Task 链 - 基础抽象
- [ ] Coordinator - 核心编排

---

## Phase 2 - 工具系统 ✅ 已完成

- [x] 添加 Edit 工具 - 实现精确字符串替换（类似 OpenClaude 的 Edit tool）
- [x] 添加 Glob/Grep 工具 - 文件和内容搜索
- [x] 完善 Harness 边界检查 - 工具执行前的权限验证

### 完成详情

**提交**: [60413df](https://github.com/Linux2010/openhorse/commit/60413df)

**工具总数**: 7
- `read_file` - 读取文件内容
- `write_file` - 写入文件
- `list_files` - 列出目录
- `exec_command` - 执行 shell 命令
- `edit_file` - 精确字符串替换
- `glob` - 文件模式搜索
- `grep` - 内容正则搜索

**权限系统**:
- 破坏性操作需用户确认（default mode）
- 危险命令被拦截（rm -rf /, mkfs, fork bombs）
- acceptEdits/auto mode 自动允许

**测试**: 134 passed ✅

---

## Slash 命令系统改进 ✅ 已完成

- [x] 查看 openclaude 如何实现 切换模型的 /model 是如何做的，以及其他的 / 命令行

### 完成详情

**提交**: [550318a](https://github.com/Linux2010/openhorse/commit/550318a)

**增强命令**:
- `/model` - 模型别名(opus/sonnet/haiku/gpt4o/qwen/glm)、列表显示(list)、帮助(help)
- `/cost` - 显示会话 token 用量
- `/usage` (alias `/stats`) - 详细用量统计
- `/clear-history` (alias `/reset`) - 清空对话历史

**模型别名映射**:
| Alias | Model |
|-------|-------|
| opus | claude-opus-4-7 |
| sonnet | claude-sonnet-4-6 |
| haiku | claude-haiku-4-5 |
| gpt4o | gpt-4o |
| qwen | qwen3.5-plus |
| glm | glm-5 |

**测试**: 134 passed ✅