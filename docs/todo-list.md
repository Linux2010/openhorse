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