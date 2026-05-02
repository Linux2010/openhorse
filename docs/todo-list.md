# OpenHorse Todo List

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

- [x] 查看openclaude如何实现 切换模型的 /model 是如何做的，以及其他的/ 命令行，使用它的方案完成自己的能力

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