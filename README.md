# DeepSeek Desktop 桌面版

「给自己做的桌面版」——一个由 DeepSeek API 驱动的 macOS 桌面 AI 助手。

## 已部署位置

- 安装包: `/Applications/DeepSeekDesktop.app`（双击即可启动）
- 工程源码: 本目录（`/Users/brian/DS-Workspace/ds-desktop`）

## 功能

- 🔄 **双模式（Chat / Work）**：侧栏顶部一键切换，对应新 ChatGPT 客户端中的 Chat 与 Codex Work——💬 Chat 纯对话（不注入工作区、不带工具、不访问本地）；🔧 Work 完整 agentic（工具/工作区/命令/审计）。会话创建时记录模式（侧栏 💬/🔧 徽标），发送按当前模式执行，Chat 模式下模型不会产生工具调用
- 🗂️ **工作区（Workspace）**：设置工作区目录（侧栏 📁 快速切换，原生目录选择器）；工作区内读操作自动授权免弹窗、命令默认在工作区执行、相对路径以工作区为基准，系统提示词会注入当前工作区
- 📋 **命令白名单**：设置中按前缀配置（如 `git status`），命中直接执行免弹窗；也可在授权弹窗勾选「记住此命令」
- 🔒 **只读模式**：开启后禁止执行任何命令（适合纯审计）
- 📊 **Token 用量**：每次回复完成后显示输入/输出 tokens
- ⌨️ **快捷键**：⌘N 新对话 / ⌘K 搜索会话 / ⌘, 设置 / ⌘L 聚焦输入 / ⌘P 窗口置顶 / ⌘O 选择工作区 / ⌘E 导出
- 🌗 **主题切换**：深色 / 浅色 / 跟随系统（代码高亮同步切换）
- 🔍 **会话管理**：侧栏搜索框过滤会话（含消息内容）、双击标题重命名、📌 固定置顶分组
- 🧩 **代码块增强**：语言标签 + 一键复制 + 语法高亮（highlight.js，已离线 vendor）
- 📎 **文件拖放**：把本地文件拖进输入框，内容作为附件上下文发送（≤2MB 文本）
- 🌐 **全局唤起**：任意应用按 `⌘⇧空格` 唤起窗口并聚焦输入框（Chat Bar 简化版）
- 📌 **窗口置顶**：侧栏「置顶」按钮或 ⌘P
- 🗂️ **Projects 项目空间**：侧栏项目选择器（全部/未分配/各项目）；新建项目（＋）后新对话自动归入；会话悬停 📁 一键分配到项目；按项目过滤会话
- 🗄️ **会话归档导出**：设置里「导出全部会话…」一键把所有会话（含项目归属、工具调用记录）导出为单一 Markdown
- ✏️ **Canvas 代码编辑**：任意代码块点「✏️ 编辑」在右侧画布打开，可修改、复制、保存到工作区（写入走授权弹窗，只读模式下禁用）
- 🎨 Codex 风格界面：深色极简 + 左侧会话列表（多会话管理，按今天/昨天/近 7 天分组，⌘N 新对话）
- 🔧 **Agentic 工具能力**：read_file / list_dir / grep / file_stat / run_command，模型可真实读取本地文件、搜索代码、执行命令（工具调用循环，最多 20 轮）
- 🔐 **权限弹窗**：访问信任目录外的路径、执行命令时弹出授权窗口（允许/拒绝/记住此目录，120 秒超时自动拒绝）；信任目录可在设置中管理，也可一键信任整个主目录
- 🐢 工具执行日志卡片：每条消息展示工具调用过程（图标、参数、结果摘要），不再"说了没反应"
- 💬 流式对话（打字机效果，100ms 节流渲染 + 原地 DOM 更新，长文不卡），Markdown 渲染
- 🧠 `deepseek-reasoner` 模型支持「思考过程」折叠展示
- 🔑 API 密钥自动读取 `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`，也可在设置中自定义；密钥不出本机
- ⚙️ 设置：系统提示词、温度、最大 tokens、模型切换、信任目录
- 📤 导出对话为 Markdown（含工具调用记录）
- 💾 多会话自动保存（localStorage，2s 节流），重启不丢失
- ⏹ 停止生成 / ↩️ 重试 / 📋 复制消息

## 开发

```bash
npm install        # 已配置 npmmirror 镜像 + 项目内缓存
npm start          # 开发模式启动
npm run smoke      # 端到端冒烟测试（真实调用 API 后退出）
npm run pack       # 打包成 .app 到 dist/
```

## 技术栈

- Electron 33（contextIsolation + sandbox，安全默认）
- 主进程: 密钥解析 + DeepSeek `chat/completions` SSE 流式转发
- 渲染层: 原生 HTML/CSS/JS + marked（已 vendor 到 `src/vendor/`，离线可用）
- 图标: DeepSeek 官方鲸鱼 logo（来源 `assets/ds-avatar-source.png`，GitHub 组织头像）→ `scripts/make_icon.py` 合成蓝底白鲸 → `assets/icon.icns`

## 说明

- 默认模型 `deepseek-chat`，设置里可切 `deepseek-reasoner`
- 冒烟测试用的 `--no-sandbox --disable-gpu` 仅限无图形受限环境；正常双击启动不需要
- 受限环境可用 `DS_DESKTOP_USER_DATA=<可写目录>` 指定用户数据目录（设置/信任持久化）；正常环境默认 `~/Library/Application Support/DeepSeek Desktop`
- 记住授权时若路径位于 git 仓库内，会自动记住**仓库根目录**（一次授权覆盖整个仓库）；非仓库目录则记住文件所在目录
- 工具调用循环上限 20 轮、工具结果单条限长 150KB、流式 60s 无数据自动超时
