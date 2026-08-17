# DeepSeek Desktop

本地 agentic AI 桌面客户端：模型直接操作你的电脑（读写文件、搜索代码、执行命令、调用 MCP 工具），每一步都有明确的权限边界。Codex 风格界面，双模式（Chat / Work），由 DeepSeek API 驱动。

## 核心特性

- 🔄 **双模式（Chat / Work）**：侧栏顶部一键切换，并**与模型联动**——Work 自动用 `deepseek-reasoner`（复杂任务更稳），Chat 自动用 `deepseek-chat`（轻快）
- 🔧 **Agentic 工具链**：`read_file` / `list_dir` / `grep` / `file_stat` / `run_command` / `write_file`，工具调用循环（20 轮上限、同轮并行、防重复空转、90s 超时）
- 🔐 **权限安全模型**：工作区/信任目录内读写免弹窗，之外每次授权；命令白名单（含默认只读命令）；只读模式；权限弹窗排队 + 系统通知
- 🗂️ **工作区（Workspace）**：目录选择、相对路径基准、自动信任；侧栏文件树 + 预览 + 附加到对话
- 🔌 **MCP 支持**：连接任意 MCP 服务器（filesystem/GitHub/Brave/Puppeteer…），工具自动合并，支持工具级信任开关
- 🖌️ **Canvas**：代码块一键进画布编辑、保存到工作区
- 🗃️ **Projects**：项目空间、会话按项目分组、项目绑定工作区
- 📊 **用量统计**：每次回复的 token 消耗 + 成本估算
- 🌐 **全局唤起**：任意应用按 `⌘⇧空格` 唤起并聚焦输入框
- 🧩 **Markdown 增强**：代码高亮、KaTeX 公式、Mermaid 流程图、代码块复制/编辑
- 🔊 朗读回复、输入历史、主题切换、会话搜索/固定/重命名、归档导出、与 DSH Harness 互通

## 快速开始

```bash
npm install
npm start            # 开发模式
npm run smoke        # 全量冒烟测试（UI/工具/并行/write_file/双模式/MCP/网络）
npm run pack         # 打包到 dist/
```

首次使用：设置 → 选择工作区 →（可选）添加 MCP 服务器 → 开聊。

## 架构

```
src/
├── main.js          # 主进程：工具系统、权限闸门、流式网络层（原生 http）、MCP 客户端、IPC
├── preload.js       # contextBridge 安全桥（仅暴露白名单 API）
└── renderer/
    ├── index.html   # 界面结构
    ├── styles.css   # 主题（深/浅/跟随系统）
    └── renderer.js  # 状态、渲染、事件、持久化、MCP/文件树/Canvas 等
vendor/              # 离线资源：marked / DOMPurify / highlight.js / KaTeX / Mermaid
scripts/make_icon.py # 图标生成（橙色鲸鱼）
```

### 安全设计要点

- **模型输出不可信**：Markdown 渲染经 DOMPurify 白名单净化（无 XSS）
- **命令执行**：execFile 命令/参数分离，无 shell 注入面；白名单精确匹配
- **文件访问**：工作区/信任目录内免弹窗，之外弹窗授权（写操作权限与读一致）
- **设置白名单**：IPC 只接受预定义键 + 类型校验
- **密钥不出本机**：API Key 仅用于本地请求头；支持环境变量/设置/~/.dsh 三级来源

## 配置

设置面板覆盖：API Key / API Base（支持 Ollama、OpenAI 兼容端点）/ 自定义模型 / 系统提示词模板 / 温度 / 工作区 / 只读模式 / 信任目录 / 命令白名单 / MCP 服务器 / 主题 / 用量统计。

userData 默认位于 `~/Library/Application Support/DeepSeek Desktop`；全部错误写入 `app.log`（版本/工具/参数/权限全链路埋点，便于排查）。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `⌘N` / `⌘K` / `⌘L` / `⌘,` / `⌘P` / `⌘O` / `⌘E` | 新对话 / 搜索会话 / 聚焦输入 / 设置 / 窗口置顶 / 工作区 / 导出 |
| `⌘⇧空格` | 任意应用唤起窗口 |
| `↑` / `↓` | 输入历史 |
| `⌘?` | 快捷键面板 |

## 故障排查

- 任何异常先看 `userData/app.log`（含 `[chat]`、`[tool]`、`[perm]`、`[renderer]` 全链路日志）
- 网络失败：应用强制直连（不依赖系统代理）；错误带原因码（DNS/连接拒绝等）
- 大文件写入：模型自动分段（write_file ≤6000 字符 + append），若仍卡住看工具卡片错误原文

## License

MIT © 2026 Brian <brian@starrycoffee.com>
