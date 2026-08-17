'use strict';

/* ---------------- state ---------------- */
const state = {
  sessions: [],   // [{id, title, messages:[{id,role,text,reasoning,error,tools}], createdAt, updatedAt}]
  activeId: null,
  settings: {
    model: 'deepseek-chat', system: '', temperature: 0.7, maxTokens: 8192,
    trustHome: false, trustedRoots: [], workspace: null, readOnly: false, allowedCommands: [],
    theme: 'dark',
  },
  streaming: null, // { id, assistantMsg, model, startedAt }
  searchQuery: '',
  windowPinned: false,
  pendingAttachment: null, // { path, text, size }
  projects: [],            // [{id, name, workspace}]
  projectFilter: '',       // ''=全部 | '__none__'=未分配 | projectId
  mode: 'work',            // 'chat' | 'work'
  counter: 0,
};

const MODELS = [
  { id: 'deepseek-chat', label: 'deepseek-chat' },
  { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
];

/* 按历史公开定价估算成本（¥/百万 tokens）；仅供参考 */
const MODEL_COST = {
  'deepseek-chat': { p: 2, c: 8 },
  'deepseek-reasoner': { p: 4, c: 16 },
};

const MCP_TEMPLATES = [
  {
    label: '📁 filesystem',
    command: (ws) => `npx @modelcontextprotocol/server-filesystem ${ws || '<工作区路径>'}`,
    note: '本地文件操作：读/写/列目录/编辑',
  },
  {
    label: '🐙 GitHub',
    command: () => 'env GITHUB_PERSONAL_ACCESS_TOKEN=<你的token> npx @modelcontextprotocol/server-github',
    note: '仓库/issue/PR 操作',
  },
  {
    label: '🔎 Brave 搜索',
    command: () => 'env BRAVE_API_KEY=<你的key> npx @modelcontextprotocol/server-brave-search',
    note: '联网搜索',
  },
  {
    label: '🌐 Puppeteer',
    command: () => 'npx @modelcontextprotocol/server-puppeteer',
    note: '浏览器自动化、抓网页',
  },
];

const LS_USAGE = 'ds-usage';

/* 系统提示词模板 */
const PROMPT_TEMPLATES = [
  {
    name: '通用助手',
    text: '你是「DeepSeek Desktop」，一个由 DeepSeek 驱动的桌面 AI 助手。你中文流利、回答清晰有条理。回答适当使用 Markdown 排版，代码用代码块包裹。',
  },
  {
    name: '代码审查',
    text: '你是资深代码审查专家。请审查用户提供的代码：指出 bug、安全隐患、性能问题和可读性问题，按严重程度排序，并给出改进后的代码示例。使用中文回答。',
  },
  {
    name: '翻译',
    text: '你是专业翻译。将用户输入翻译为指定目标语言，保留原意和语气，术语准确。如果用户给了多种语言要求，分别输出并标注。',
  },
  {
    name: '写作助手',
    text: '你是专业写作者。根据用户需求创作或润色文案，结构清晰、语言生动。输出前先给大纲（可选）。',
  },
  {
    name: '数据分析',
    text: '你是数据分析专家。面对数据相关问题：先理解数据结构和业务背景，说明分析思路，给出结论和建议，必要时用代码示例。',
  },
];

const DEFAULT_SYSTEM =
  '你是「DeepSeek Desktop」，一个由 DeepSeek 驱动的桌面 AI 助手，部署在用户的 Mac 上。你中文流利、回答清晰有条理，主动解决问题。' +
  '你可以调用本地工具访问用户的电脑：读取文件、列出目录、搜索内容、执行命令。' +
  '规则：' +
  '1. 只有实际调用工具并拿到结果后，才能声称「正在读取/已经读取」；工具尚未返回时，不要假装完成。' +
  '2. 不要编造文件内容或命令输出；工具报错就如实说明。' +
  '3. 访问信任目录外的路径、执行命令时，系统会弹出授权窗口；在用户批准前视为未授权，不要谎称已完成。' +
  '4. 需要读取文件或执行操作时，直接调用对应工具，不要只说「让我读取」这类空话而不调用工具；如果工具不可用或失败，明确说明原因。' +
  '5. 同一轮可以并行调用多个工具（如同时读取多个文件），减少轮次；不要重复调用完全相同的工具。' +
  '6. 了解一个项目时，先 list_dir 看结构，再读关键文件（package.json / README 等）；读取大文件时用 max_bytes 限制。' +
  '7. 审计仓库时按模块推进：结构 → 配置 → 核心源码 → 测试，最后给出结构化的审计结论（优点、风险、建议）。' +
  '8. 需要生成/输出完整文件（HTML、代码、报告）时，用 write_file 工具写入工作区，不要在回复中粘贴超长文件内容（会被截断）。' +
  '9. 大文件必须分多次 write_file：每次 content ≤6000 字符，第一次写开头（不传 append），之后用 append:true 逐段追加，直到写完并确认文件完整。每写完一段就立即调用下一次，不要一次生成超长内容。' +
  '10. 工具失败时如实报告原因，不要反复重试完全相同的操作（最多 2 次）；任务完成就明确说完成，不要假装未完成。' +
  '11. 检查环境/目录状态时，优先用只读命令（ls、pwd、git status、python --version 等，工作区内免弹窗）或文件工具（list_dir、file_stat）；生成/写入文件必须用 write_file 工具，不要用命令脚本写文件。' +
  '回答适当使用 Markdown 排版，代码用代码块包裹。';

const QUICK_PROMPTS = {
  work: [
    '用一句话介绍你自己',
    '帮我规划一个学习 Python 的 4 周路线',
    '写一个用 Node.js 读取 CSV 文件的脚本',
    '审计一下当前工程目录的结构',
  ],
  chat: [
    '用一句话介绍你自己',
    '帮我规划一个学习 Python 的 4 周路线',
    '写一首关于秋天的短诗',
  ],
};

const $ = (id) => document.getElementById(id);
const LS_SESSIONS = 'ds-sessions';
const LS_ACTIVE = 'ds-active';
const LS_PROJECTS = 'ds-projects';

/* ---------------- markdown ---------------- */
if (window.marked) marked.setOptions({ gfm: true, breaks: true });

function sanitize(html) {
  // 白名单净化（DOMPurify），替代易绕过的黑名单正则
  if (window.DOMPurify) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
      FORBID_ATTR: ['style'],
    });
  }
  // 降级：基本转义（无 DOMPurify 时宁可损失格式也不放行 HTML）
  return html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(src) {
  try {
    mathPlaceholders.length = 0;
    const extracted = extractMath(src || '');
    const raw = marked.parse(extracted, { gfm: true, breaks: true });
    const withMath = restoreMath(raw);
    return sanitize(withMath);
  } catch {
    return `<p>${src.replace(/</g, '&lt;')}</p>`;
  }
}

/* KaTeX 数学公式：先提取 $...$ / $$...$$ 为占位符，marked 后再还原 */
const mathPlaceholders = [];
function extractMath(src) {
  return src.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, block, inline) => {
    const id = `\u0000MATH${mathPlaceholders.length}\u0000`;
    mathPlaceholders.push(block ? { block: true, tex: block } : { block: false, tex: inline });
    return id;
  });
}
function restoreMath(html) {
  return html.replace(/\u0000MATH(\d+)\u0000/g, (_, i) => {
    const m = mathPlaceholders[+i];
    if (!m) return '';
    try {
      return window.katex
        ? katex.renderToString(m.tex, { displayMode: m.block, throwOnError: false })
        : escapeHtml(m.tex);
    } catch {
      return escapeHtml(m.tex);
    }
  });
}

/* Mermaid 图初始化（懒初始化） */
let mermaidReady = false;
function ensureMermaid() {
  if (window.mermaid && !mermaidReady) {
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
      });
      mermaidReady = true;
    } catch {}
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------- 渲染层错误上报（写入 app.log） ---------------- */
(function hookErrors() {
  window.addEventListener('error', (e) => {
    try { window.ds.log('error', `uncaught: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`); } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { window.ds.log('error', `unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : String(e.reason)}`); } catch {}
  });
  const origErr = console.error.bind(console);
  console.error = (...args) => {
    origErr(...args);
    try { window.ds.log('error', args.map(String).join(' ').slice(0, 500)); } catch {}
  };
})();

/* ---------------- 主题 ---------------- */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(pref) {
  if (pref === 'light') return 'light';
  if (pref === 'system') return darkQuery.matches ? 'dark' : 'light';
  return 'dark';
}

function applyTheme() {
  const t = resolveTheme(state.settings.theme || 'dark');
  document.documentElement.dataset.theme = t;
  const darkCss = $('hljs-dark');
  const lightCss = $('hljs-light');
  if (darkCss && lightCss) {
    darkCss.disabled = t !== 'dark';
    lightCss.disabled = t !== 'light';
  }
}

/* ---------------- sessions ---------------- */
function activeSession() {
  return state.sessions.find((s) => s.id === state.activeId);
}
function msgs() {
  const s = activeSession();
  return s ? s.messages : [];
}
function touch(s) {
  s.updatedAt = Date.now();
}
function nextId() {
  state.counter += 1;
  return `m-${Date.now()}-${state.counter}`;
}

function newSession() {
  const s = {
    id: nextId(),
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectId: (state.projectFilter && state.projectFilter !== '__none__') ? state.projectFilter : undefined,
    mode: state.mode,
  };
  state.sessions.unshift(s);
  state.activeId = s.id;
  persistNow();
  renderSessionList();
  renderMessages();
  return s;
}

function selectSession(id) {
  if (state.streaming || !state.sessions.some((s) => s.id === id)) return;
  state.activeId = id;
  persistNow();
  renderSessionList();
  renderMessages();
  $('input').focus();
}

function deleteSession(id) {
  if (state.streaming) return;
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.messages.length && !confirm('删除这个对话？')) return;
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (state.activeId === id) {
    state.activeId = state.sessions.length
      ? state.sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).id
      : newSession().id;
  }
  persistNow();
  renderSessionList();
  renderMessages();
}

function togglePin(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  s.pinned = !s.pinned;
  touch(s);
  persistNow();
  renderSessionList();
}

function renameSession(id) {
  if (state.streaming) return;
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const name = prompt('重命名会话：', s.title || '');
  if (name === null) return;
  s.title = name.trim();
  touch(s);
  persistNow();
  renderSessionList();
}

async function toggleWindowPin() {
  state.windowPinned = !state.windowPinned;
  try {
    const res = await window.ds.windowPin(state.windowPinned);
    state.windowPinned = res.pinned;
    $('btn-pin-window').classList.toggle('active', state.windowPinned);
    setStatus(state.windowPinned ? '窗口已置顶' : '取消置顶');
  } catch (e) {
    state.windowPinned = false;
    setStatus('⚠ 置顶失败：' + e.message);
  }
}

/* 文件附件：读取文本后显示 chip，发送时并入用户消息 */
async function attachFile(filePath) {
  if (!filePath) return;
  setStatus(`读取 ${filePath.split('/').pop()}…`);
  try {
    const res = await window.ds.fileReadText(filePath);
    if (!res.ok) {
      setStatus('⚠ 附件失败：' + (res.error || '未知错误'));
      return;
    }
    state.pendingAttachment = { path: res.path, text: res.text, size: res.size };
    renderAttachmentChip();
    setStatus(`已附加 ${res.path.split('/').pop()}（${(res.size / 1024).toFixed(1)} KB）`);
  } catch (e) {
    setStatus('⚠ 附件失败：' + e.message);
  }
}

function renderAttachmentChip() {
  let chip = document.getElementById('attach-chip');
  if (!state.pendingAttachment) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    const wrap = $('composer-wrap');
    chip = document.createElement('div');
    chip.id = 'attach-chip';
    chip.className = 'attach-chip';
    chip.innerHTML = '<span class="ac-ico">📎</span><span class="ac-name"></span><button class="ac-close" title="移除">✕</button>';
    chip.querySelector('.ac-close').addEventListener('click', () => {
      state.pendingAttachment = null;
      renderAttachmentChip();
    });
    wrap.insertBefore(chip, wrap.firstChild);
  }
  chip.querySelector('.ac-name').textContent = state.pendingAttachment.path;
}

/* ---------------- 持久化（节流，修复卡顿） ---------------- */
let persistTimer = null;

function persist() {
  try {
    let data = JSON.stringify(state.sessions);
    // localStorage 上限保护：超限时降级截断（保留最近消息，截短长文本），避免静默丢数据
    if (data.length > 4_500_000) {
      const slim = state.sessions.map((s) => ({
        ...s,
        messages: s.messages.slice(-40).map((m) => ({
          ...m,
          text: (m.text || '').slice(0, 4000),
          reasoning: (m.reasoning || '').slice(0, 2000),
        })),
      }));
      data = JSON.stringify(slim);
    }
    localStorage.setItem(LS_SESSIONS, data);
    localStorage.setItem(LS_ACTIVE, state.activeId);
  } catch {}
}

function persistThrottled() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 2000);
}

function persistNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persist();
}

/* ---------------- 项目 ---------------- */
function saveProjects() {
  try { localStorage.setItem(LS_PROJECTS, JSON.stringify(state.projects)); } catch {}
}

function loadProjects() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]');
    if (Array.isArray(arr)) state.projects = arr;
  } catch {}
}

function projectName(id) {
  const p = state.projects.find((x) => x.id === id);
  return p ? p.name : '';
}

function renderProjectBar() {
  const sel = $('project-select');
  sel.innerHTML = '<option value="">全部会话</option><option value="__none__">未分配</option>';
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = state.projectFilter;
}

async function newProject() {
  const name = prompt('新项目名称：');
  if (!name || !name.trim()) return;
  const id = nextId();
  const workspace = state.settings.workspace || '';
  state.projects.push({ id, name: name.trim(), workspace, createdAt: Date.now() });
  saveProjects();
  state.projectFilter = id;
  renderProjectBar();
  renderSessionList();
  setStatus(`已创建项目「${name.trim()}」`);
}

function assignSessionToProject(sessionId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const options = state.projects.map((p) => p.name).join('、');
  const name = prompt(`分配到项目（输入项目名；留空取消分配）。现有项目：${options || '（无）'}`, projectName(s.projectId) || '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    s.projectId = undefined;
  } else {
    let p = state.projects.find((x) => x.name === trimmed);
    if (!p) {
      p = { id: nextId(), name: trimmed, workspace: state.settings.workspace || '', createdAt: Date.now() };
      state.projects.push(p);
      saveProjects();
    }
    s.projectId = p.id;
  }
  touch(s);
  persistNow();
  renderProjectBar();
  renderSessionList();
  setStatus(trimmed ? `已分配到「${trimmed}」` : '已取消分配');
}

/* 模式切换（Chat / Work） */
function renderModeSwitch() {
  $('mode-chat').classList.toggle('active', state.mode === 'chat');
  $('mode-work').classList.toggle('active', state.mode === 'work');
  // Work 专属的工作区按钮在 Chat 模式下隐藏
  $('btn-workspace').style.display = state.mode === 'work' ? 'flex' : 'none';
}

async function setMode(mode) {
  if (state.streaming) {
    setStatus('⚠ 正在生成中，无法切换模式');
    return;
  }
  if (mode === state.mode) return;
  state.mode = mode;
  renderModeSwitch();
  try {
    await window.ds.setSettings({ mode });
  } catch (e) {
    console.error('mode save failed', e);
  }
  // 模式-模型联动：Work → deepseek-reasoner（复杂任务更稳），Chat → deepseek-chat（轻快）
  // 自定义模型（非预设两个）保持不动，尊重手动选择
  const current = state.settings.model || 'deepseek-chat';
  let switched = false;
  if (mode === 'work' && current === 'deepseek-chat') {
    state.settings.model = 'deepseek-reasoner';
    try { await window.ds.setSettings({ model: 'deepseek-reasoner' }); } catch {}
    switched = true;
  } else if (mode === 'chat' && current === 'deepseek-reasoner') {
    state.settings.model = 'deepseek-chat';
    try { await window.ds.setSettings({ model: 'deepseek-chat' }); } catch {}
    switched = true;
  }
  if (switched) {
    buildModelSelect();
    setStatus(mode === 'work'
      ? 'Work 模式 → 已联动切换模型：deepseek-reasoner（复杂任务更稳定）'
      : 'Chat 模式 → 已联动切换模型：deepseek-chat（轻快）');
  } else {
    setStatus(mode === 'work' ? 'Work 模式：完整工具能力（文件/命令/工作区）' : 'Chat 模式：纯对话，不访问本地');
  }
  if (msgs().length === 0) renderEmptyState();
}

/* ---------------- 模型列表 ---------------- */
function allModels() {
  const customs = Array.isArray(state.settings.customModels) ? state.settings.customModels : [];
  return [...MODELS.map((m) => ({ id: m.id, label: m.label })), ...customs.map((m) => ({ id: m, label: m }))];
}

function buildModelSelect() {
  const sel = $('model-select');
  const models = allModels();
  const current = state.settings.model || 'deepseek-chat';
  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  // 以 state.settings.model 为权威（联动/手动选择都会更新它）
  sel.value = models.some((m) => m.id === current) ? current : (models[0] ? models[0].id : '');
  if (sel.value && sel.value !== state.settings.model) state.settings.model = sel.value;
}

/* ---------------- 用量统计 ---------------- */
function loadUsage() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_USAGE) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function recordUsage(usage, model) {
  if (!usage || !usage.total_tokens) return;
  const list = loadUsage();
  list.push({
    ts: Date.now(),
    model: model || state.settings.model,
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || 0,
  });
  // 保留最近 2000 条
  const slim = list.slice(-2000);
  try { localStorage.setItem(LS_USAGE, JSON.stringify(slim)); } catch {}
}

function estimateCost(rec) {
  const rate = MODEL_COST[rec.model] || MODEL_COST['deepseek-chat'];
  return (rec.prompt / 1e6) * rate.p + (rec.completion / 1e6) * rate.c;
}

function renderUsageStats() {
  const list = loadUsage();
  const el = $('usage-stats');
  if (list.length === 0) {
    el.textContent = '（暂无用量记录）';
    return;
  }
  const today = new Date().setHours(0, 0, 0, 0);
  let totalP = 0, totalC = 0, cost = 0, todayP = 0, todayC = 0, todayCost = 0, count = 0;
  const byModel = {};
  for (const r of list) {
    totalP += r.prompt; totalC += r.completion;
    const c = estimateCost(r);
    cost += c; count += 1;
    if (r.ts >= today) { todayP += r.prompt; todayC += r.completion; todayCost += c; }
    byModel[r.model] = (byModel[r.model] || 0) + r.total;
  }
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
  const fmtCost = (n) => '¥' + n.toFixed(2);
  const modelLines = Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([m, t]) => `  ${m}: ${fmt(t)} tokens`)
    .join('\n');
  el.innerHTML = `<b>共 ${count} 次请求</b> · 输入 ${fmt(totalP)} / 输出 ${fmt(totalC)} · 估算 ${fmtCost(cost)}
今日：输入 ${fmt(todayP)} / 输出 ${fmt(todayC)} · 估算 ${fmtCost(todayCost)}
按模型：
${modelLines}`;
}

/* ---------------- 会话列表 ---------------- */
function groupLabel(ts) {
  const now = new Date();
  const d = new Date(ts);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return '近 7 天';
  return '更早';
}

function renderSessionList() {
  const listEl = $('session-list');
  const q = (state.searchQuery || '').trim().toLowerCase();
  let sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  // 项目过滤
  if (state.projectFilter === '__none__') {
    sessions = sessions.filter((s) => !s.projectId);
  } else if (state.projectFilter) {
    sessions = sessions.filter((s) => s.projectId === state.projectFilter);
  }
  if (q) {
    sessions = sessions.filter((s) => {
      const title = (s.title || '').toLowerCase();
      const body = s.messages.map((m) => (m.text || '')).join(' ').toLowerCase();
      return title.includes(q) || body.includes(q);
    });
  }

  const groupHtml = (label, items, extraCls) => {
    let h = `<div class="session-group ${extraCls || ''}"><div class="session-group-label">${label}</div>`;
    for (const s of items) {
      const title = s.title || '新对话';
      h += `<div class="session-item${s.id === state.activeId ? ' active' : ''}${s.pinned ? ' pinned' : ''}" data-id="${s.id}" title="${escapeHtml(title)}">
        <button class="s-pin" data-pin="${s.id}" title="${s.pinned ? '取消固定' : '固定'}">
          <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M16 3l5 5-3.5 1-4 4-1 5L9 14l-5 5 1-5 5-1 4-4L15 6z" transform="rotate(45 12 12)"/></svg>
        </button>
        <span class="s-mode" title="${s.mode === 'chat' ? 'Chat 模式' : 'Work 模式'}">${s.mode === 'chat' ? '💬' : '🔧'}</span>
        <span class="s-title">${escapeHtml(title)}</span>
        <button class="s-proj" data-proj="${s.id}" title="分配到项目">📁</button>
        <button class="s-del" data-del="${s.id}" title="删除">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>
        </button>
      </div>`;
    }
    return h + '</div>';
  };

  const pinned = sessions.filter((s) => s.pinned);
  const rest = sessions.filter((s) => !s.pinned);
  const groups = new Map();
  for (const s of rest) {
    const g = groupLabel(s.updatedAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const order = ['今天', '昨天', '近 7 天', '更早'];

  let html = '';
  if (q && sessions.length === 0) {
    html = `<div class="session-group-label" style="padding:6px 8px;">无匹配会话</div>`;
  } else {
    if (pinned.length) html += groupHtml('已固定', pinned, 'pinned-group');
    for (const g of order) {
      if (groups.has(g)) html += groupHtml(g, groups.get(g));
    }
  }
  listEl.innerHTML = html;
}

function loadSessions() {
  let raw = null;
  try {
    raw = localStorage.getItem(LS_SESSIONS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) state.sessions = arr;
    }
    const active = localStorage.getItem(LS_ACTIVE);
    if (active && state.sessions.some((s) => s.id === active)) state.activeId = active;
  } catch (e) {
    // 解析失败：备份原始数据以便抢救，并记录原因
    console.error('sessions parse failed', e);
    try {
      window.ds.log('error', `sessions parse failed: ${e.message}, len=${raw ? raw.length : 0}, head=${raw ? raw.slice(0, 120) : 'null'}`);
    } catch {}
    try {
      if (raw) localStorage.setItem('ds-sessions-backup', raw);
    } catch {}
  }
  // 历史错误不持久化：加载时清除所有旧错误横幅（避免旧版本失败记录永久显示）
  let cleared = false;
  for (const s of state.sessions) {
    for (const m of s.messages || []) {
      if (m.error) { delete m.error; cleared = true; }
    }
  }
  if (cleared) {
    try { localStorage.setItem(LS_SESSIONS, JSON.stringify(state.sessions)); } catch {}
  }
  if (state.sessions.length === 0) {
    newSession();
  } else if (!activeSession()) {
    state.activeId = state.sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).id;
  }
}

/* ---------------- 渲染（原地更新 + 节流，修复卡顿） ---------------- */
const messagesEl = $('messages');
let renderTimer = null;

function toolItemHtml(t) {
  const spin = '<span class="t-spin"></span>';
  let resHtml;
  if (t.status === 'running') resHtml = spin;
  else if (t.status === 'error') resHtml = '✗ 失败';
  else resHtml = escapeHtml(t.res || '');
  return `<div class="tool-item ${t.status === 'running' ? 'running' : t.status === 'error' ? 'error' : 'done'}">
    <span class="t-ico">${t.icon || '🔧'}</span>
    <span class="t-name">${escapeHtml(t.name)}</span>
    <span class="t-args">${escapeHtml(t.args || '')}</span>
    <span class="t-res">${resHtml}</span>
  </div>`;
}

function msgHtml(m) {
  const isUser = m.role === 'user';
  const roleName = isUser ? '你' : 'DeepSeek';
  let body;
  if (isUser) {
    body = `<div class="msg-body">${escapeHtml(m.text || '')}</div>`;
  } else {
    const thinking = m.reasoning
      ? `<details class="thinking"><summary>思考过程</summary><div class="thinking-body">${escapeHtml(m.reasoning)}</div></details>`
      : '';
    const toolLog = m.tools && m.tools.length
      ? `<div class="tool-log">${m.tools.map(toolItemHtml).join('')}</div>`
      : '';
    const error = m.error
      ? `<div class="error-banner">⚠ ${escapeHtml(m.error)}</div>`
      : '';
    const streamingCls = m.streaming ? ' cursor' : '';
    body = `${thinking}${toolLog}<div class="msg-body${streamingCls}">${renderMarkdown(m.text)}</div>${error}`;
  }
  const actions = `<span class="msg-actions">
    ${isUser ? '' : `<button class="btn" data-act="speak" title="朗读">🔊</button><button class="btn" data-act="toharness" title="发送到 DSH Harness">↗</button>`}
    <button class="btn" data-act="copy" title="复制全文">复制</button>
    ${m.error ? '' : `<button class="btn" data-act="retry" title="重新生成">重试</button>`}
  </span>`;
  return `<div class="msg ${isUser ? 'user' : 'assistant'}" data-id="${m.id}">
    <div class="role-tag"><span class="role-tag-name">${roleName}</span>${actions}</div>
    ${body}
  </div>`;
}

function insertMessageDom(m) {
  messagesEl.insertAdjacentHTML('beforeend', msgHtml(m));
  const el = messagesEl.querySelector(`.msg[data-id="${m.id}"]`);
  enhanceCodeBlocks(el);
  return el;
}

/* 代码块增强：语言标签 + 复制 + 编辑(Canvas) + 语法高亮 + Mermaid 图 */
function enhanceCodeBlocks(root) {
  if (!root) return;
  root.querySelectorAll('pre code').forEach((code) => {
    if (code.dataset.enhanced) return;
    code.dataset.enhanced = '1';
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || '';

    // Mermaid 流程图：代码块替换为图
    if (lang === 'mermaid') {
      const pre = code.parentElement;
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      pre.replaceWith(div);
      ensureMermaid();
      if (mermaidReady) {
        mermaid.run({ nodes: [div] }).catch(() => {
          div.className = 'mermaid-error';
          div.textContent = '（Mermaid 渲染失败：' + div.textContent.slice(0, 120) + '…）';
        });
      } else {
        div.className = 'mermaid-error';
      }
      return;
    }

    const header = document.createElement('div');
    header.className = 'code-header';
    const btnCopy = document.createElement('button');
    btnCopy.className = 'ch-copy';
    btnCopy.textContent = '复制';
    btnCopy.addEventListener('click', () => copyText(code.textContent));
    const btnEdit = document.createElement('button');
    btnEdit.className = 'ch-copy';
    btnEdit.textContent = '✏️ 编辑';
    btnEdit.addEventListener('click', () => canvasOpen(code.textContent, lang));
    const langEl = document.createElement('span');
    langEl.className = 'ch-lang';
    langEl.textContent = lang || 'code';
    header.appendChild(langEl);
    header.appendChild(btnEdit);
    header.appendChild(btnCopy);
    code.parentElement.prepend(header);
    if (window.hljs && lang) {
      try { hljs.highlightElement(code); } catch {}
    }
  });
}

/* ---------------- Canvas 代码编辑 ---------------- */
const LANG_EXT = {
  javascript: '.js', js: '.js', typescript: '.ts', ts: '.ts', python: '.py', py: '.py',
  html: '.html', css: '.css', json: '.json', bash: '.sh', shell: '.sh', zsh: '.sh',
  sql: '.sql', markdown: '.md', md: '.md', yaml: '.yml', yml: '.yml', xml: '.xml',
  java: '.java', go: '.go', rust: '.rs', c: '.c', cpp: '.cpp', ruby: '.rb', php: '.php',
};

function canvasOpen(code, lang) {
  state.canvas = { lang: lang || '', dirty: false };
  $('cv-editor').value = code;
  $('cv-path').textContent = `${lang || 'text'} · ${code.length.toLocaleString()} 字符${state.canvas.dirty ? ' · 未保存' : ''}`;
  $('canvas-panel').hidden = false;
  $('cv-editor').focus();
}

function canvasClose() {
  $('canvas-panel').hidden = true;
  state.canvas = null;
}

async function canvasSave() {
  if (!state.canvas) return;
  const ext = LANG_EXT[state.canvas.lang] || '.txt';
  const defaultName = `canvas-${new Date().toISOString().slice(0, 10)}${ext}`;
  const name = prompt('保存为（相对于工作区目录）：', defaultName);
  if (name === null) return;
  const res = await window.ds.fileWriteText({ path: name.trim(), content: $('cv-editor').value });
  if (res.ok) {
    state.canvas.dirty = false;
    $('cv-path').textContent = `已保存 ${res.path}`;
    setStatus(`已保存到 ${res.path}`);
  } else {
    setStatus('⚠ 保存失败：' + (res.error || '未知错误'));
  }
}

/* 原地更新消息 DOM（不重建整条消息，避免逐帧全量重渲染） */
function updateMessageDom(m) {
  const el = messagesEl.querySelector(`.msg[data-id="${m.id}"]`);
  if (!el) return;

  if (m.role === 'assistant') {
    // 思考过程（插在工具日志之前、正文之前）
    let thinkBody = el.querySelector('.thinking .thinking-body');
    if (m.reasoning) {
      if (!thinkBody) {
        const anchor = el.querySelector('.tool-log') || el.querySelector('.msg-body');
        if (anchor) {
          anchor.insertAdjacentHTML('beforebegin', `<details class="thinking"><summary>思考过程</summary><div class="thinking-body"></div></details>`);
        }
        thinkBody = el.querySelector('.thinking .thinking-body');
      }
      if (thinkBody) thinkBody.textContent = m.reasoning;
    } else if (thinkBody) {
      const det = el.querySelector('.thinking');
      if (det) det.remove();
    }

    // 工具日志
    const logEl = el.querySelector('.tool-log');
    if (m.tools && m.tools.length) {
      if (!logEl) {
        const anchor = el.querySelector('.msg-body');
        if (anchor) anchor.insertAdjacentHTML('beforebegin', '<div class="tool-log"></div>');
      }
      const log = el.querySelector('.tool-log');
      if (log) log.innerHTML = m.tools.map(toolItemHtml).join('');
    } else if (logEl) {
      logEl.remove();
    }

    // 正文（缓存比对，避免重复解析）
    const body = el.querySelector('.msg-body');
    if (body) {
      body.classList.toggle('cursor', !!m.streaming);
      const html = renderMarkdown(m.text);
      if (body._lastHtml !== html) {
        body.innerHTML = html;
        body._lastHtml = html;
        enhanceCodeBlocks(body);
      }
    }
  } else {
    const body = el.querySelector('.msg-body');
    if (body) body.textContent = m.text || '';
  }
}

function renderMessage(m, scroll) {
  insertMessageDom(m);
  if (scroll !== false) scrollToBottom();
}

function renderMessages() {
  messagesEl.innerHTML = '';
  const list = msgs();
  if (list.length === 0) {
    renderEmptyState();
    return;
  }
  for (const m of list) {
    insertMessageDom({ ...m, streaming: false });
  }
  scrollToBottom();
}

function renderEmptyState() {
  const work = state.mode === 'work';
  const prompts = (work ? QUICK_PROMPTS.work : QUICK_PROMPTS.chat);
  messagesEl.innerHTML = `
    <div class="empty-state">
      <div class="big">◆</div>
      <h1>${work ? '今天想构建点什么？' : '想聊点什么？'}</h1>
      <p>${work
        ? 'Work 模式 · 可以读取本地文件、搜索代码、执行命令（需要授权时会有弹窗）。'
        : 'Chat 模式 · 纯对话，不访问本地文件。切换侧栏的 Work 模式可获得完整工具能力。'}</p>
      <div class="chips">
        ${prompts.map((p) => `<button class="chip" data-prompt="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}
      </div>
    </div>`;
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text) {
  $('status-line').textContent = text || '';
}

/* 侧栏工作区显示 */
function renderWorkspaceBar() {
  const ws = state.settings.workspace;
  const nameEl = $('ws-name');
  if (ws) {
    const base = ws.split('/').filter(Boolean).pop() || ws;
    nameEl.textContent = (state.settings.readOnly ? '🔒 ' : '') + base;
    nameEl.parentElement.title = ws + (state.settings.readOnly ? '\n只读模式开启' : '');
  } else {
    nameEl.textContent = '未设置工作区';
    nameEl.parentElement.title = '点击选择工作区目录';
  }
}

/* 节流渲染：流式期间最多约 10fps，且只更新脏消息 */
function scheduleRender(m) {
  m.dirty = true;
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const wasNearBottom = isNearBottom();
    for (const msg of msgs()) {
      if (msg.dirty) {
        updateMessageDom(msg);
        msg.dirty = false;
      }
    }
    if (wasNearBottom) scrollToBottom();
    persistThrottled();
  }, 100);
}

function renderNow() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  const wasNearBottom = isNearBottom();
  for (const msg of msgs()) {
    if (msg.dirty) {
      updateMessageDom(msg);
      msg.dirty = false;
    }
  }
  if (wasNearBottom) scrollToBottom();
}

/* ---------------- 工具事件 ---------------- */
function summarizeArgs(args) {
  if (!args) return '';
  if (args.path) return args.path;
  if (args.command) return args.command;
  if (args.pattern) return `${args.pattern} @ ${args.path || ''}`;
  try { return JSON.stringify(args).slice(0, 80); } catch { return ''; }
}

function handleToolEvent(m, delta) {
  m.tools = m.tools || [];
  if (delta.status === 'start') {
    m.tools.push({ icon: delta.icon, name: delta.tool, args: summarizeArgs(delta.args), status: 'running', res: '' });
  } else {
    const last = m.tools.filter((t) => t.name === delta.tool && t.status === 'running').pop() || m.tools[m.tools.length - 1];
    if (last) {
      last.status = delta.status === 'error' ? 'error' : 'done';
      last.res = delta.summary || '';
    }
  }
  // 显示并行执行中的工具数量
  const running = m.tools.filter((t) => t.status === 'running').length;
  setStatus(running > 0 ? `正在并行执行 ${running} 个工具…` : '');
}

/* ---------------- 流式 ---------------- */
function updateStatusForStreaming() {
  if (!state.streaming) return;
  const secs = Math.max(1, Math.round((Date.now() - state.streaming.startedAt) / 1000));
  setStatus(`${state.streaming.model === 'deepseek-reasoner' ? '推理中' : '生成中'}… ${secs}s`);
}

let statusTimer = null;
function startStatusTimer() {
  stopStatusTimer();
  statusTimer = setInterval(updateStatusForStreaming, 1000);
}
function stopStatusTimer() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

async function send() {
  if (state.streaming) return;
  const sess = activeSession();
  if (!sess) return;
  let text = $('input').value.trim();
  if (state.pendingAttachment && text) {
    const att = state.pendingAttachment;
    // 附件内容限长（50KB），防止请求体过大被 API 拒绝
    const body = att.text.length > 50000 ? att.text.slice(0, 50000) + '\n…（附件过长已截断）' : att.text;
    text = `[附加文件 ${att.path}]\n\`\`\`\n${body}\n\`\`\`\n\n${text}`;
  } else if (state.pendingAttachment) {
    const att = state.pendingAttachment;
    const body = att.text.length > 50000 ? att.text.slice(0, 50000) + '\n…（附件过长已截断）' : att.text;
    text = `[附加文件 ${att.path}]\n\`\`\`\n${body}\n\`\`\``;
  }
  if (!text) return;

  rememberInput(text);

  const userMsg = { id: nextId(), role: 'user', text };
  const reqId = nextId();
  const assistantMsg = {
    id: reqId, role: 'assistant', text: '', reasoning: '',
    tools: [], streaming: true, dirty: true,
  };

  if (!sess.title) sess.title = text.slice(0, 24);
  sess.messages.push(userMsg, assistantMsg);
  touch(sess);
  state.streaming = { id: reqId, assistantMsg, model: state.settings.model, startedAt: Date.now() };

  $('input').value = '';
  autoResize();
  state.pendingAttachment = null;
  renderAttachmentChip();
  persistNow();
  renderSessionList();
  renderMessage(userMsg);
  insertMessageDom(assistantMsg);
  scrollToBottom();

  setStatus('连接中…');
  startStatusTimer();
  $('btn-send').hidden = true;
  $('btn-stop').hidden = false;

  const history = sess.messages
    .filter((m) => !m.streaming && !m.error && m.id !== reqId)
    .map((m) => ({ role: m.role, text: m.text }));

  try {
    await window.ds.startChat({
      id: reqId,
      mode: state.mode,
      model: state.settings.model,
      system: state.settings.system || DEFAULT_SYSTEM,
      temperature: state.settings.temperature,
      maxTokens: state.settings.maxTokens,
      messages: history,
    });
  } catch (e) {
    finishStreaming(assistantMsg, `启动请求失败：${e.message}`);
  }
}

function finishStreaming(assistantMsg, err, usage) {
  if (state.streaming && state.streaming.id === assistantMsg.id) {
    state.streaming = null;
  }
  assistantMsg.streaming = false;
  if (err) assistantMsg.error = err;
  assistantMsg.dirty = true;
  renderNow();
  stopStatusTimer();
  if (statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null; }
  if (err) {
    setStatus('');
  } else if (usage && usage.total_tokens) {
    setStatus(`完成 · 输入 ${usage.prompt_tokens || 0} / 输出 ${usage.completion_tokens || 0} tokens`);
    // 仅当期间没有新的流式开始时才清空（避免误清新状态）
    const mark = (state.streaming ? state.streaming.id : null);
    statusClearTimer = setTimeout(() => {
      if (!state.streaming) setStatus('');
    }, 6000);
  } else {
    setStatus('');
  }
  $('btn-send').hidden = false;
  $('btn-stop').hidden = true;
  persistNow();
}
let statusClearTimer = null;

/* ---------------- 朗读 ---------------- */
let speakingId = null;

async function toggleSpeak(m) {
  if (speakingId === m.id) {
    await window.ds.speechStop();
    speakingId = null;
    setStatus('');
    return;
  }
  if (!m.text || !m.text.trim()) return;
  const res = await window.ds.speechSpeak({ text: m.text });
  if (res && res.ok) {
    speakingId = m.id;
    setStatus('🔊 正在朗读…（再次点击停止）');
  } else {
    setStatus('⚠ 朗读失败：' + ((res && res.error) || '未知错误'));
  }
}

/* 发送到 DSH Harness：带上前文，复制 + 打开 3080 */
async function sendToHarness(m) {
  const sess = activeSession();
  const idx = sess ? sess.messages.findIndex((x) => x.id === m.id) : -1;
  const ctx = [];
  if (sess) {
    const start = Math.max(0, idx - 6);
    for (const x of sess.messages.slice(start, idx + 1)) {
      if (x.role === 'user') ctx.push(`🙋 用户：${x.text}`);
      else if (x.role === 'assistant') ctx.push(`◆ DeepSeek：${x.text}`);
    }
  }
  const header = sess && sess.title ? `# ${sess.title}\n\n` : '';
  const text = `${header}（来自 DeepSeek Desktop，可粘贴到 Harness 继续深入）\n\n${ctx.join('\n\n')}`;
  const res = await window.ds.toHarness({ text });
  if (res && res.ok) {
    setStatus(res.harnessOpened
      ? '✓ 已复制并打开 DSH Harness（粘贴即可继续）'
      : '✓ 已复制到剪贴板（未检测到 3080 服务，可先启动 Harness 壳）');
  } else {
    setStatus('⚠ 发送失败：' + ((res && res.error) || '未知错误'));
  }
}

/* ---------------- 输入历史（↑/↓） ---------------- */
const inputHistory = [];
let historyIndex = -1;

function rememberInput(text) {
  const t = text.trim();
  if (!t) return;
  if (inputHistory[inputHistory.length - 1] === t) return;
  inputHistory.push(t);
  if (inputHistory.length > 50) inputHistory.shift();
  historyIndex = inputHistory.length;
}

function historyNav(direction) {
  const input = $('input');
  if (direction < 0) {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
  } else {
    if (historyIndex >= inputHistory.length - 1) {
      historyIndex = inputHistory.length;
      input.value = '';
      autoResize();
      return;
    }
    historyIndex += 1;
  }
  input.value = inputHistory[historyIndex] || '';
  autoResize();
  input.setSelectionRange(input.value.length, input.value.length);
}

/* ---------------- 工作区文件树 ---------------- */
const fileExpanded = new Set(); // 已展开的目录路径
const fileLoading = new Set();  // 加载中的目录（防重复展开）
let filePanelOpen = false;
let previewPath = null;

function renderFilePanel() {
  const tree = $('file-tree');
  const ws = state.settings.workspace;
  $('file-arrow').textContent = filePanelOpen ? '▾' : '▸';
  tree.hidden = !filePanelOpen;
  if (!filePanelOpen) return;
  if (!ws) {
    tree.innerHTML = '<div class="ft-empty">未设置工作区</div>';
    return;
  }
  tree.innerHTML = '';
  const rootRow = document.createElement('div');
  rootRow.className = 'ft-item ft-dir open';
  rootRow.innerHTML = `<span class="ft-icon">📁</span><span class="ft-name">${escapeHtml(ws.split('/').filter(Boolean).pop() || ws)}</span>`;
  rootRow.dataset.dir = ws;
  tree.appendChild(rootRow);
  fileExpanded.add(ws);
  expandDir(ws, rootRow);
}

async function expandDir(dirPath, rowEl) {
  if (fileLoading.has(dirPath)) return; // 防重复展开竞态
  fileLoading.add(dirPath);
  try {
    const res = await window.ds.fsListDir(dirPath);
    const ul = document.createElement('ul');
    ul.className = 'ft-children';
    if (!res.ok) {
      ul.innerHTML = `<li class="ft-empty">${escapeHtml(res.error || '读取失败')}</li>`;
    } else {
      for (const e of res.entries) {
        const li = document.createElement('li');
        li.className = 'ft-item ' + (e.type === 'dir' ? 'ft-dir' : 'ft-file');
        li.innerHTML = `<span class="ft-icon">${e.type === 'dir' ? '📁' : '📄'}</span><span class="ft-name">${escapeHtml(e.name)}</span>`;
        if (e.type === 'dir') {
          li.dataset.dir = dirPath + '/' + e.name;
          li.classList.add('closed');
        } else {
          li.dataset.file = dirPath + '/' + e.name;
        }
        ul.appendChild(li);
      }
    }
    // 移除旧子列表再插入
    const old = rowEl.parentElement.querySelector(':scope > .ft-children');
    if (old) old.remove();
    rowEl.parentElement.insertBefore(ul, rowEl.nextSibling);
    rowEl.classList.remove('closed');
  } finally {
    fileLoading.delete(dirPath);
  }
}

function collapseDir(rowEl) {
  const ul = rowEl.parentElement.querySelector(':scope > .ft-children');
  if (ul) ul.remove();
  rowEl.classList.add('closed');
}

async function onFileTreeClick(e) {
  const dirRow = e.target.closest('[data-dir]');
  if (dirRow) {
    const p = dirRow.dataset.dir;
    if (fileExpanded.has(p)) {
      fileExpanded.delete(p);
      collapseDir(dirRow);
    } else {
      fileExpanded.add(p);
      expandDir(p, dirRow);
    }
    return;
  }
  const fileRow = e.target.closest('[data-file]');
  if (fileRow) {
    openPreview(fileRow.dataset.file);
  }
}

async function openPreview(p) {
  previewPath = p;
  const res = await window.ds.fsPreview(p);
  $('pv-path').textContent = p;
  if (res.ok) {
    const sizeStr = res.size >= 1024 * 1024 ? (res.size / 1024 / 1024).toFixed(1) + ' MB' : (res.size / 1024).toFixed(1) + ' KB';
    $('pv-path').textContent = `${p} · ${sizeStr}${res.truncated ? ' · 已截断' : ''}`;
    $('pv-body').textContent = res.text || '（空文件）';
  } else {
    $('pv-body').textContent = '读取失败：' + (res.error || '');
  }
  $('preview-panel').hidden = false;
}

function closePreview() {
  $('preview-panel').hidden = true;
  previewPath = null;
}

/* ---------------- 事件 ---------------- */
let pendingPerm = null;

function bindEvents() {
  const input = $('input');

  // ===== 关键事件优先绑定（即使后续元素绑定失败，权限弹窗与流式也一定生效）=====
  window.ds.onPermissionAsk((p) => {
    pendingPerm = p;
    try { window.ds.log('info', `perm received: ${p.kind} ${p.path || p.command || (p.mcpTool || '')}`); } catch {}
    setStatus('⚠ 等待你授权…');
    const wrap = $('perm-remember-wrap');
    $('perm-remember').checked = false;
    if (p.kind === 'command') {
      $('perm-icon').textContent = '💻';
      $('perm-desc').textContent = 'DeepSeek Desktop 想在你的电脑上执行命令（每次都需要确认）：';
      $('perm-target').textContent = `${p.cwd || '~'}$ ${p.command}`;
      wrap.style.display = 'flex';
      $('perm-remember-label').textContent = '记住此命令（以后直接执行，不再询问）';
    } else if (p.kind === 'write') {
      $('perm-icon').textContent = '✏️';
      $('perm-desc').textContent = 'DeepSeek Desktop 想写入文件（写入操作每次都需要确认）：';
      $('perm-target').textContent = p.path;
      wrap.style.display = 'none';
    } else if (p.kind === 'mcp') {
      $('perm-icon').textContent = '🔌';
      $('perm-desc').textContent = `DeepSeek Desktop 想调用 MCP 服务器「${p.mcpServer}」的工具：`;
      $('perm-target').textContent = `${p.mcpTool}\n${p.argsSummary || ''}`;
      wrap.style.display = 'flex';
      $('perm-remember-label').textContent = '信任此 MCP 服务器（以后调用不再询问）';
    } else {
      $('perm-icon').textContent = '📄';
      $('perm-desc').textContent = 'DeepSeek Desktop 想访问以下路径（超出信任范围，需要确认）：';
      $('perm-target').textContent = p.path;
      wrap.style.display = 'flex';
      const target = p.rememberTarget || '';
      $('perm-remember-label').textContent = p.gitRoot
        ? `记住整个仓库：${target}（git 仓库根目录，含全部子目录）`
        : `记住此目录：${target}（含子目录）`;
    }
    $('perm-mask').hidden = false;
  });

  window.ds.onDelta(({ id, delta }) => {
    const m = msgs().find((x) => x.id === id);
    if (!m) return;
    if (delta.type === 'text') {
      m.text += delta.text;
      m.dirty = true;
      scheduleRender(m);
    } else if (delta.type === 'reasoning') {
      m.reasoning += delta.text;
      m.dirty = true;
      scheduleRender(m);
    } else if (delta.type === 'tool_pending') {
      setStatus('正在生成工具参数…（大内容会稍慢）');
    } else if (delta.type === 'tool') {
      handleToolEvent(m, delta);
      m.dirty = true;
      scheduleRender(m);
    }
  });

  window.ds.onDone(({ id, ok, usage }) => {
    const m = msgs().find((x) => x.id === id);
    if (m) {
      finishStreaming(m, null, usage);
      recordUsage(usage, state.settings.model);
    }
  });

  window.ds.onError(({ id, message }) => {
    const m = msgs().find((x) => x.id === id);
    if (m) finishStreaming(m, message);
  });

  // ===== 其余 UI 事件 =====

  input.addEventListener('input', autoResize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && !e.shiftKey && (input.selectionStart === 0 || input.value === '')) {
      e.preventDefault();
      historyNav(-1);
    } else if (e.key === 'ArrowDown' && input.value === '') {
      e.preventDefault();
      historyNav(1);
    }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'n') { e.preventDefault(); newSession(); }
    else if (mod && k === 'k') { e.preventDefault(); $('session-search').focus(); $('session-search').select(); }
    else if (mod && k === 'l') { e.preventDefault(); $('input').focus(); }
    else if (mod && k === ',') { e.preventDefault(); openSettings(); }
    else if (mod && k === 'p') { e.preventDefault(); toggleWindowPin(); }
    else if (mod && k === 'o') { e.preventDefault(); pickWorkspace(); }
    else if (mod && k === 'e') { e.preventDefault(); exportConversation(); }
    else if (mod && (k === '?' || k === '/')) { e.preventDefault(); toggleShortcuts(); }

    if (e.key === 'Escape' && !$('perm-mask').hidden) {
      if (pendingPerm) {
        window.ds.permissionRespond({ permId: pendingPerm.permId, allow: false, remember: false });
        pendingPerm = null;
      }
      $('perm-mask').hidden = true;
    }
  });

  $('btn-send').addEventListener('click', send);
  $('btn-stop').addEventListener('click', () => {
    if (state.streaming) window.ds.cancelChat(state.streaming.id);
  });
  $('btn-new').addEventListener('click', newSession);
  $('btn-export').addEventListener('click', exportConversation);
  $('btn-export-all').addEventListener('click', exportAllSessions);
  $('btn-settings').addEventListener('click', openSettings);
  $('hint-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-clear-trust').addEventListener('click', clearTrust);
  $('btn-mcp-add').addEventListener('click', mcpAdd);
  $('btn-mcp-test').addEventListener('click', mcpTest);
  $('btn-clear-usage').addEventListener('click', clearUsage);
  $('btn-close-shortcuts').addEventListener('click', () => $('shortcuts-mask').hidden = true);
  $('shortcuts-mask').addEventListener('click', (e) => {
    if (e.target === $('shortcuts-mask')) $('shortcuts-mask').hidden = true;
  });
  $('file-head').addEventListener('click', () => {
    filePanelOpen = !filePanelOpen;
    renderFilePanel();
  });
  $('file-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    fileExpanded.clear();
    renderFilePanel();
  });
  $('file-tree').addEventListener('click', onFileTreeClick);
  $('pv-close').addEventListener('click', closePreview);
  $('pv-attach').addEventListener('click', async () => {
    if (!previewPath) return;
    await attachFile(previewPath);
    closePreview();
  });
  $('cv-save').addEventListener('click', canvasSave);
  $('cv-copy').addEventListener('click', () => {
    copyText($('cv-editor').value);
    setStatus('Canvas 内容已复制');
  });
  $('cv-close').addEventListener('click', canvasClose);
  $('cv-editor').addEventListener('input', () => {
    if (state.canvas) {
      state.canvas.dirty = true;
      $('cv-path').textContent = `${state.canvas.lang || 'text'} · 未保存修改`;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('canvas-panel').hidden && $('perm-mask').hidden && $('modal-mask').hidden) {
      canvasClose();
    }
  });
  $('btn-workspace').addEventListener('click', pickWorkspace);
  $('btn-pick-workspace').addEventListener('click', pickWorkspace);
  $('btn-pin-window').addEventListener('click', toggleWindowPin);
  $('set-temp').addEventListener('input', () => {
    $('temp-val').textContent = $('set-temp').value;
  });

  // 文件拖放附件（ChatGPT/Codex 式）
  const composerWrap = $('composer-wrap');
  composerWrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    composerWrap.classList.add('dragover');
  });
  composerWrap.addEventListener('dragleave', () => composerWrap.classList.remove('dragover'));
  composerWrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    composerWrap.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    await attachFile(file.path || file.name);
  });

  window.ds.onFocusInput(() => {
    $('input').focus();
    autoResize();
  });

  $('model-select').addEventListener('change', async (e) => {
    state.settings.model = e.target.value;
    await window.ds.setSettings({ model: state.settings.model });
    setStatus(`已切换到 ${e.target.value}`);
  });

  $('session-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      deleteSession(del.dataset.del);
      return;
    }
    const pin = e.target.closest('[data-pin]');
    if (pin) {
      e.stopPropagation();
      togglePin(pin.dataset.pin);
      return;
    }
    const proj = e.target.closest('[data-proj]');
    if (proj) {
      e.stopPropagation();
      assignSessionToProject(proj.dataset.proj);
      return;
    }
    const item = e.target.closest('.session-item');
    if (item) selectSession(item.dataset.id);
  });

  $('project-select').addEventListener('change', async (e) => {
    const val = e.target.value;
    state.projectFilter = val;
    // 项目绑定工作区：切到项目时自动切换其工作区；没有则绑定当前工作区
    if (val && val !== '__none__') {
      const proj = state.projects.find((p) => p.id === val);
      if (proj) {
        try {
          if (proj.workspace && proj.workspace !== state.settings.workspace) {
            state.settings.workspace = proj.workspace;
            await window.ds.setSettings({ workspace: proj.workspace });
            renderWorkspaceBar();
            setStatus(`已切换到项目「${proj.name}」的工作区：${proj.workspace}`);
          } else if (!proj.workspace && state.settings.workspace) {
            proj.workspace = state.settings.workspace;
            saveProjects();
            setStatus(`已将当前工作区绑定到项目「${proj.name}」`);
          }
        } catch (err) {
          console.error('workspace switch failed', err);
        }
      }
    }
    renderSessionList();
  });
  $('btn-new-project').addEventListener('click', newProject);
  $('mode-chat').addEventListener('click', () => setMode('chat'));
  $('mode-work').addEventListener('click', () => setMode('work'));

  $('session-list').addEventListener('dblclick', (e) => {
    const item = e.target.closest('.session-item');
    if (!item || e.target.closest('[data-del]') || e.target.closest('[data-pin]')) return;
    renameSession(item.dataset.id);
  });

  $('session-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderSessionList();
  });

  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const msgEl = e.target.closest('.msg');
    const m = msgs().find((x) => x.id === msgEl.dataset.id);
    if (!m) return;
    if (btn.dataset.act === 'copy') copyText(m.text || '');
    if (btn.dataset.act === 'retry') retryMessage(m);
    if (btn.dataset.act === 'speak') toggleSpeak(m);
    if (btn.dataset.act === 'toharness') sendToHarness(m);
  });

  messagesEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-prompt]');
    if (chip) {
      $('input').value = chip.dataset.prompt;
      autoResize();
      $('input').focus();
    }
  });

  $('modal-mask').addEventListener('click', (e) => {
    if (e.target === $('modal-mask')) closeSettings();
  });

  /* 权限弹窗按钮 */
  $('btn-perm-allow').addEventListener('click', () => {
    if (pendingPerm) {
      try { window.ds.log('info', `perm click: allow ${pendingPerm.permId}`); } catch {}
      window.ds.permissionRespond({ permId: pendingPerm.permId, allow: true, remember: $('perm-remember').checked });
      pendingPerm = null;
    }
    $('perm-mask').hidden = true;
    setStatus('');
  });
  $('btn-perm-deny').addEventListener('click', () => {
    if (pendingPerm) {
      try { window.ds.log('info', `perm click: deny ${pendingPerm.permId}`); } catch {}
      window.ds.permissionRespond({ permId: pendingPerm.permId, allow: false, remember: false });
      pendingPerm = null;
    }
    $('perm-mask').hidden = true;
    setStatus('');
  });
}

function retryMessage(m) {
  if (state.streaming) return;
  const sess = activeSession();
  if (!sess) return;
  const idx = sess.messages.indexOf(m);
  if (idx < 0) return;
  sess.messages = sess.messages.slice(0, idx);
  touch(sess);
  const lastUser = [...sess.messages].reverse().find((x) => x.role === 'user');
  if (lastUser) {
    const ui = sess.messages.indexOf(lastUser);
    sess.messages = sess.messages.slice(0, ui);
    $('input').value = lastUser.text;
    autoResize();
  }
  renderMessages();
  persistNow();
  $('input').focus();
}

/* ---------------- 辅助 ---------------- */
function autoResize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

function copyText(text) {
  const done = () => setStatus('已复制到剪贴板');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch {}
  ta.remove();
}

async function exportConversation() {
  const sess = activeSession();
  if (!sess || sess.messages.length === 0) return;
  const lines = ['# 对话导出', '', `> 模型: ${state.settings.model} · 导出时间: ${new Date().toLocaleString('zh-CN')}`, ''];
  for (const m of sess.messages) {
    const toolLog = m.tools && m.tools.length
      ? `\n\n（工具调用：${m.tools.map((t) => `${t.name}(${t.args || ''})${t.res ? ' → ' + t.res : ''}`).join('；')}）`
      : '';
    lines.push(`## ${m.role === 'user' ? '🙋 用户' : '◆ DeepSeek'}`, '', `${m.text || ''}${toolLog}`, '');
  }
  const defaultName = `${sess.title || '对话'}_${new Date().toISOString().slice(0, 10)}.md`;
  const res = await window.ds.exportSave({ defaultName, content: lines.join('\n') });
  if (res.saved) setStatus(`已导出到 ${res.filePath}`);
}

/* 导出全部会话为单一 Markdown 归档 */
async function exportAllSessions() {
  if (state.sessions.length === 0) {
    setStatus('没有可导出的会话');
    return;
  }
  const lines = [
    '# DeepSeek Desktop · 全部会话归档', '',
    `> 导出时间: ${new Date().toLocaleString('zh-CN')} · 共 ${state.sessions.length} 个会话`, '',
  ];
  const sorted = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    lines.push(`---`, '', `## ${s.title || '未命名会话'}`, '',
      `> ${new Date(s.updatedAt).toLocaleString('zh-CN')}${s.projectId ? ` · 项目: ${projectName(s.projectId)}` : ''}${s.pinned ? ' · 📌' : ''}`, '');
    for (const m of s.messages) {
      const toolLog = m.tools && m.tools.length
        ? `\n\n（工具调用：${m.tools.map((t) => `${t.name}(${t.args || ''})${t.res ? ' → ' + t.res : ''}`).join('；')}）`
        : '';
      lines.push(`### ${m.role === 'user' ? '🙋 用户' : '◆ DeepSeek'}`, '', `${m.text || ''}${toolLog}`, '');
    }
  }
  const defaultName = `全部会话归档_${new Date().toISOString().slice(0, 10)}.md`;
  const res = await window.ds.exportSave({ defaultName, content: lines.join('\n') });
  if (res.saved) setStatus(`已导出 ${state.sessions.length} 个会话到 ${res.filePath}`);
}

/* ---------------- MCP 服务器管理 ---------------- */
async function refreshMcpList() {
  try {
    const list = await window.ds.mcpList();
    const el = $('mcp-list');
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="trust-list">（未配置 MCP 服务器）</div>';
      return;
    }
    el.innerHTML = list.map((s) => `
      <div class="mcp-item">
        <span class="mcp-dot ${s.connected ? 'on' : 'off'}"></span>
        <span class="mcp-name">${escapeHtml(s.name)}</span>
        <span class="mcp-meta">${s.connected ? `${s.toolsCount} 个工具${s.trusted ? ' · 已信任' : ''}` : `未连接${s.error ? ' · ' + escapeHtml(String(s.error).slice(0, 40)) : ''}`}</span>
        <button class="mcp-del" data-mcp-del="${escapeHtml(s.name)}" title="移除">✕</button>
      </div>
      ${s.connected && s.tools && s.tools.length ? `<details class="mcp-tools"><summary>工具级信任（${s.trusted ? '服务器已全信任，可忽略' : '点击开关单个工具'}）</summary><div class="mcp-tool-chips">${s.tools.map((t) => {
        const on = s.trustedTools.includes(t);
        return `<button class="mcp-tool-chip ${on ? 'on' : ''}" data-mcp-tool="${escapeHtml(s.name)}::${escapeHtml(t)}" title="${on ? '已信任（免询问）' : '未信任（调用时询问）'}">${on ? '🔓' : '🔒'} ${escapeHtml(t)}</button>`;
      }).join('')}</div></details>` : ''}`).join('');
    el.querySelectorAll('[data-mcp-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await window.ds.mcpRemove(btn.dataset.mcpDel);
        refreshMcpList();
        setStatus(`已移除 MCP 服务器 ${btn.dataset.mcpDel}`);
      });
    });
    el.querySelectorAll('[data-mcp-tool]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [name, tool] = btn.dataset.mcpTool.split('::');
        const turningOn = !btn.classList.contains('on');
        const res = await window.ds.mcpSetToolTrust({ name, tool, trusted: turningOn });
        if (res.ok) {
          btn.classList.toggle('on', turningOn);
          btn.textContent = `${turningOn ? '🔓' : '🔒'} ${tool}`;
          btn.title = turningOn ? '已信任（免询问）' : '未信任（调用时询问）';
        } else {
          setStatus('⚠ ' + (res.error || '操作失败'));
        }
      });
    });
  } catch (e) {
    console.error('mcp list failed', e);
  }
}

function mcpForm() {
  return {
    name: $('mcp-name').value.trim(),
    command: $('mcp-command').value.trim(),
    args: $('mcp-args').value.trim().split(/\s+/).filter(Boolean),
  };
}

function renderMcpTemplates() {
  const el = $('mcp-templates');
  el.innerHTML = MCP_TEMPLATES.map((t) => `<button class="mcp-tpl-btn" data-tpl="${t.label}" title="${t.note}">${t.label}</button>`).join('');
  el.querySelectorAll('[data-tpl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = MCP_TEMPLATES.find((x) => x.label === btn.dataset.tpl);
      if (!t) return;
      const cmd = t.command(state.settings.workspace || '');
      $('mcp-command').value = cmd;
      $('mcp-name').value = cmd.split(/\s+/).find((w) => w.includes('server-')) ? cmd.match(/server-([\w-]+)/)[1] : '';
      mcpMsg(`模板「${t.label}」已填入：${t.note}。${cmd.includes('<') ? '请把 <> 中的占位符替换为实际值。' : '直接测试连接即可。'}`);
    });
  });
}

async function clearUsage() {
  localStorage.removeItem(LS_USAGE);
  renderUsageStats();
  setStatus('已清空用量统计');
}

function toggleShortcuts() {
  $('shortcuts-mask').hidden = !$('shortcuts-mask').hidden;
}

/* 系统提示词模板 */
function renderPromptTemplates() {
  const el = $('prompt-templates');
  el.innerHTML = PROMPT_TEMPLATES.map((t) => `<button class="mcp-tpl-btn" data-pt="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`).join('');
  el.querySelectorAll('[data-pt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = PROMPT_TEMPLATES.find((x) => x.name === btn.dataset.pt);
      if (t) {
        $('set-system').value = t.text;
        setStatus(`已套用模板「${t.name}」（可继续编辑）`);
      }
    });
  });
}

function mcpMsg(text, kind) {
  const el = $('mcp-msg');
  el.hidden = false;
  el.className = 'mcp-msg ' + (kind || 'busy');
  el.textContent = text;
}

async function mcpAdd() {
  const cfg = mcpForm();
  if (!cfg.name || !cfg.command) {
    mcpMsg('⚠ 请填写名称和启动命令', 'err');
    return;
  }
  const btn = $('btn-mcp-add');
  btn.disabled = true;
  mcpMsg(`正在连接 ${cfg.name}…（npx 首次可能需要下载，请稍候）`);
  try {
    const res = await window.ds.mcpAdd(cfg);
    if (res.ok) {
      mcpMsg(`✓ 服务器 ${cfg.name} 已连接（${res.toolsCount} 个工具）`, 'ok');
      $('mcp-name').value = '';
      $('mcp-command').value = '';
      $('mcp-args').value = '';
      refreshMcpList();
    } else {
      mcpMsg('⚠ 连接失败：' + (res.error || '未知错误'), 'err');
    }
  } catch (e) {
    mcpMsg('⚠ 连接异常：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function mcpTest() {
  const cfg = mcpForm();
  if (!cfg.command) {
    mcpMsg('⚠ 请填写启动命令', 'err');
    return;
  }
  const btn = $('btn-mcp-test');
  btn.disabled = true;
  mcpMsg('测试连接…（首次可能需下载，最长 60 秒）');
  try {
    const res = await window.ds.mcpTest(cfg);
    if (res.ok) {
      mcpMsg(`✓ 连接成功：${res.toolsCount} 个工具（如 ${(res.tools || []).slice(0, 3).join(', ')}）`, 'ok');
    } else {
      mcpMsg('⚠ 测试失败：' + (res.error || '未知错误'), 'err');
    }
  } catch (e) {
    mcpMsg('⚠ 测试异常：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 设置 ---------------- */
function openSettings() {
  $('set-key').value = state.settings.apiKey || '';
  $('set-system').value = state.settings.system || DEFAULT_SYSTEM;
  $('set-apibase').value = state.settings.apiBase || '';
  $('set-models').value = (state.settings.customModels || []).join('\n');
  $('set-temp').value = String(state.settings.temperature ?? 0.7);
  $('temp-val').textContent = $('set-temp').value;
  $('set-max').value = String(state.settings.maxTokens ?? 8192);
  $('set-workspace').value = state.settings.workspace || '';
  $('set-readonly').checked = !!state.settings.readOnly;
  $('set-trust-home').checked = !!state.settings.trustHome;
  $('set-cmds').value = (state.settings.allowedCommands || []).join('\n');
  $('set-theme').value = state.settings.theme || 'dark';
  renderTrustList();
  const src = state.settings.apiKeySource || (state.settings.apiKeyConfigured ? 'unknown' : 'none');
  const srcLabels = {
    env: '环境变量 DEEPSEEK_API_KEY（优先级最高）',
    settings: '本应用设置（会覆盖 ~/.dsh 默认密钥）',
    dsh: '~/.dsh/.credentials.yaml',
    unknown: '未标注来源',
    none: '未检测到',
  };
  $('key-status').textContent = state.settings.apiKeyConfigured
    ? `✓ 已配置 · 当前生效：${srcLabels[src] || src}`
    : '✗ 未检测到密钥：可在此填写（保存后立即生效），或确认 ~/.dsh/.credentials.yaml 存在';
  $('modal-mask').hidden = false;
  $('set-key').focus();
  refreshMcpList();
  renderUsageStats();
}

function renderTrustList() {
  const list = Array.isArray(state.settings.trustedRoots) ? state.settings.trustedRoots : [];
  $('set-trust-list').textContent = list.join('\n');
}

function closeSettings() {
  $('modal-mask').hidden = true;
}

async function clearTrust() {
  state.settings.trustedRoots = [];
  await window.ds.setSettings({ trustedRoots: [] });
  renderTrustList();
  setStatus('已清除所有记住的信任目录');
}

async function saveSettings() {
  const patch = {};
  const key = $('set-key').value.trim();
  const system = $('set-system').value.trim();
  if (key) patch.apiKey = key;
  if (!key && state.settings.apiKey) patch.apiKey = '';
  patch.system = system;
  patch.temperature = parseFloat($('set-temp').value);
  patch.maxTokens = parseInt($('set-max').value, 10) || 4096;
  patch.trustHome = $('set-trust-home').checked;
  patch.readOnly = $('set-readonly').checked;
  patch.theme = $('set-theme').value || 'dark';
  patch.apiBase = $('set-apibase').value.trim() || undefined;
  patch.customModels = $('set-models').value; // 原始文本，主进程负责拆分
  const ws = $('set-workspace').value.trim();
  patch.workspace = ws || undefined;
  patch.allowedCommands = $('set-cmds').value.split('\n').map((l) => l.trim()).filter(Boolean);

  state.settings = { ...state.settings, ...patch };
  try {
    const saved = await window.ds.setSettings(patch);
    state.settings.apiKeyConfigured = saved.apiKeyConfigured;
  } catch (e) {
    console.error('save settings failed:', e);
    setStatus('⚠ 设置保存失败：' + e.message);
  }
  renderWorkspaceBar();
  applyTheme();
  buildModelSelect();
  closeSettings();
  setStatus('设置已保存');
}

async function pickWorkspace() {
  try {
    const res = await window.ds.workspacePick();
    if (res.picked) {
      state.settings.workspace = res.workspace;
      $('set-workspace').value = res.workspace;
      renderWorkspaceBar();
      setStatus(`工作区已设为 ${res.workspace}`);
    }
  } catch (e) {
    setStatus('⚠ 选择工作区失败：' + e.message);
  }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  try {
    const [appInfo, settings] = await Promise.all([window.ds.appInfo(), window.ds.getSettings()]);
    state.settings = { ...state.settings, ...settings };
    state.settings.apiKeyConfigured = settings.apiKeyConfigured ?? appInfo.apiKeyConfigured;
    state.mode = settings.mode === 'chat' ? 'chat' : 'work';
  } catch (e) {
    console.error('init error', e);
  }

  bindEvents();
  loadSessions();
  loadProjects();
  buildModelSelect();
  renderModeSwitch();
  renderMcpTemplates();
  renderPromptTemplates();
  renderSessionList();
  renderProjectBar();
  renderMessages();
  renderWorkspaceBar();
  applyTheme();
  darkQuery.addEventListener('change', () => applyTheme());
  // Work 模式 + deepseek-chat：提醒（复杂任务建议 reasoner）
  if (state.mode === 'work' && (state.settings.model || 'deepseek-chat') === 'deepseek-chat') {
    setStatus('提示：Work 模式复杂任务建议用 deepseek-reasoner（侧栏模型下拉可切换）');
  } else {
    setStatus(state.settings.apiKeyConfigured ? '' : '⚠ 未找到 API Key，点击左下角设置');
  }
}

init();
