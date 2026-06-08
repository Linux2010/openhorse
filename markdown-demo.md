# Markdown 渲染效果演示

## 一、标题层级

### 三级标题
#### 四级标题
##### 五级标题
###### 六级标题

---

## 二、文本样式

这是**粗体文本**，这是*斜体文本*，这是***粗斜体文本***。

这是~~删除线~~文本，这是`行内代码`。

---

## 三、列表

### 无序列表
- 第一项
- 第二项
  - 嵌套项 A
  - 嵌套项 B
- 第三项

### 有序列表
1. 步骤一
2. 步骤二
   1. 子步骤 2.1
   2. 子步骤 2.2
3. 步骤三

### 任务列表
- [x] 已完成任务
- [ ] 未完成任务
- [ ] 另一个未完成任务

---

## 四、代码块

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

const user: User = { id: 1, name: "Hope", email: "hope@example.com" };
console.log(greet(user));
```

```python
def fibonacci(n: int) -> list[int]:
    """Generate Fibonacci sequence up to n terms."""
    if n <= 0:
        return []
    elif n == 1:
        return [0]
    
    sequence = [0, 1]
    while len(sequence) < n:
        sequence.append(sequence[-1] + sequence[-2])
    return sequence

print(fibonacci(10))
```

---

## 五、引用

> 这是一段引用文本。
> 
> 可以包含多行内容。
>
> — 作者名

---

## 六、表格

| 功能 | 描述 | 状态 |
|------|------|------|
| 用户认证 | 支持多种登录方式 | ✅ 已完成 |
| 数据导出 | 导出为 CSV/JSON | 🚧 开发中 |
| 实时通知 | WebSocket 推送 | 📋 计划中 |

---

## 七、链接与图片

这是一个 [链接示例](https://github.com)。

![Markdown Logo](https://markdown-here.com/img/icon256.png)

---

## 八、分割线

上面是一条分割线

---

下面也是一条分割线

***

---

## 九、数学公式（如果支持）

行内公式：$E = mc^2$

块级公式：

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

---

## 十、脚注

这是一个脚注示例[^1]。

[^1]: 这是脚注的内容。

---

## 十一、HTML 元素

<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px; color: white; text-align: center;">
  <strong>渐变背景卡片</strong>
  <p>支持内联 HTML 样式</p>
</div>

---

## 十二、Emoji 表情

🎉 🚀 💡 ✨ 🔥 📝 👍 🎯

---

## 总结

这个文件展示了 Markdown 的主要渲染效果，包括：
- 多级标题
- 文本样式（粗体、斜体、删除线、代码）
- 有序/无序/任务列表
- 代码块（带语法高亮）
- 引用块
- 表格
- 链接和图片
- 分割线
- 数学公式
- 脚注
- HTML 元素
- Emoji 表情