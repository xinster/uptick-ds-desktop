'use strict';

const { app, BrowserWindow, ipcMain, dialog, globalShortcut, safeStorage, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFile, exec, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { clipboard } = require('electron');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const DEEPSEEK_BASE = process.env.DS_DESKTOP_API_BASE || 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const MAX_TOOL_ROUNDS = 40;  // 工具调用循环上限（长审计任务需要更多轮次）
const MAX_TOOL_CALLS = 8;    // 单轮工具调用数上限
const SMOKE_TEST = process.argv.includes('--smoke-test');
const WORKSPACE = '/Users/brian/DS-Workspace';

/* 默认只读命令白名单（精确匹配整条命令）：仅在工作区/信任目录内运行时免弹窗 */
const DEFAULT_SAFE_COMMANDS = [
  'ls', 'pwd', 'echo', 'date', 'whoami', 'uname',
  'git status', 'git diff', 'git log --oneline -10', 'git branch', 'git remote -v',
  'python --version', 'python3 --version', 'node --version', 'npm --version', 'pnpm --version',
];

// 全局单实例：所有启动方式统一使用 macOS 标准 userData（~/Library/Application Support/DeepSeek Desktop）
// env 覆盖仅用于冒烟测试（受限环境），正常运行不生效，保证单实例锁与配置统一
if (SMOKE_TEST && process.env.DS_DESKTOP_USER_DATA) {
  try { app.setPath('userData', process.env.DS_DESKTOP_USER_DATA); } catch {}
}

let mainWindow = null;
let settings = null;
const activeRequests = new Map();        // requestId -> AbortController（单轮流式）
const chatMasters = new Map();           // requestId -> AbortController（贯穿整个对话，含工具执行）
const pendingPermissions = new Map();    // permId -> { resolve, timer }

/* ================= settings ================= */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function decryptStoredApiKey(source) {
  if (!source) return '';
  if (source.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(source.apiKeyEncrypted, 'base64')).trim();
    } catch (e) {
      console.error('[settings] API key decrypt failed:', e.message);
    }
  }
  return typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
}

function storeApiKey(next, value) {
  const key = String(value || '').trim();
  delete next.apiKey;
  delete next.apiKeyEncrypted;
  if (!key) return;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储当前不可用，API Key 未保存');
  }
  next.apiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(settingsFile(), 0o600);
  } catch (e) {
    console.error('[settings] save failed:', e.message);
  }
  return settings;
}

function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const stored = decryptStoredApiKey(settings);
  if (stored) return stored;
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/^DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)/m);
    if (m && m[1]) return m[1].trim();
  } catch {}
  return '';
}

/* 当前密钥生效来源：env > settings > dsh */
function apiKeySource() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) return 'env';
  if (decryptStoredApiKey(settings)) return 'settings';
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(p, 'utf8');
    if (/^DEEPSEEK_API_KEY\s*:\s*["']?[^"'\r\n]+/m.test(txt)) return 'dsh';
  } catch {}
  return 'none';
}

/* ================= 工具与权限 ================= */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地文件的文本内容（UTF-8）。如果路径是目录会报错，请先用 list_dir。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要读取的文件的绝对路径' },
          max_bytes: { type: 'integer', description: '最多读取的字节数，默认 200000' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录中的内容：名称、类型、大小、修改时间。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录的绝对路径' },
          depth: { type: 'integer', description: '递归深度，0 表示仅当前目录（默认 0）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在指定目录或文件中按正则表达式搜索文本，返回匹配的文件与行。自动跳过 .git、node_modules 等目录。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '要搜索的目录或文件的绝对路径' },
          max_matches: { type: 'integer', description: '最多返回的匹配数，默认 100' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_stat',
      description: '获取文件或目录的元信息（类型、大小、修改时间、权限）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '绝对路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在本地终端执行命令（默认需要用户授权，白名单中的命令直接执行）。用于 git、构建、运行测试等。注意：execFile 语义，不支持 > 重定向、管道、heredoc 等 shell 语法；需要写入文件请用 write_file 工具。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令（单一命令，不含 shell 运算符）' },
          cwd: { type: 'string', description: '工作目录，默认用户主目录' },
          timeout_ms: { type: 'integer', description: '超时毫秒数，默认 30000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把内容写入本地文件（覆盖或追加）。路径相对于工作区或为绝对路径。重要：单次 content 上限 6000 字符（受单轮输出长度限制）；更大的文件必须分多次调用：第一次写开头（不传 append），后续每次用 append:true 追加下一段，直到写完。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径或相对于工作区，如 report.html）' },
          content: { type: 'string', description: '要写入的文本内容（上限 6000 字符；大文件分多次写入并用 append 追加）' },
          append: { type: 'boolean', description: 'true 时追加到文件末尾（默认 false 覆盖写入）' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function trustedRoots() {
  const list = [];
  const add = (r) => {
    if (r && r !== '/' && r !== path.parse(r).root && !list.includes(r)) list.push(r);
  };
  // 工作区始终可信（读操作免授权）
  if (settings && settings.workspace) add(safeRealpath(settings.workspace));
  if (settings && settings.trustHome) add(os.homedir());
  if (Array.isArray(settings && settings.trustedRoots)) {
    for (const p of settings.trustedRoots) add(safeRealpath(p));
  }
  return list;
}

/* 工具路径解析：相对路径以工作区为基准；~ 展开 */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveToolPath(p) {
  const base = (settings && settings.workspace) || os.homedir();
  const p2 = expandHome(String(p || ''));
  return path.isAbsolute(p2) ? path.normalize(p2) : path.resolve(base, p2);
}

function isTrusted(p) {
  const real = safeRealpath(p);
  if (!real) return false;
  return trustedRoots().some((r) => real === r || real.startsWith(r + path.sep));
}

function nearestExistingRealpath(p) {
  let current = path.resolve(p);
  while (current !== path.dirname(current)) {
    const real = safeRealpath(current);
    if (real) return real;
    current = path.dirname(current);
  }
  return null;
}

function isTrustedWriteTarget(p) {
  const existingReal = safeRealpath(p);
  const real = existingReal || nearestExistingRealpath(path.dirname(p));
  if (!real) return false;
  return trustedRoots().some((r) => real === r || real.startsWith(r + path.sep));
}

function writeTextNoFollow(p, content, append = false) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW
    | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC);
  const fd = fs.openSync(p, flags, 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function rememberPath(p) {
  const real = safeRealpath(p);
  if (!real) return;
  const list = (settings && Array.isArray(settings.trustedRoots)) ? [...settings.trustedRoots] : [];
  if (!list.includes(real)) {
    list.push(real);
    saveSettings({ trustedRoots: list });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const APP_PAGE_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

function isTrustedIpcEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const frame = event.senderFrame;
  return event.sender === mainWindow.webContents
    && frame === event.sender.mainFrame
    && frame.url === APP_PAGE_URL;
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event)) throw new Error('拒绝来自非应用页面的 IPC 请求');
    return handler(event, ...args);
  });
}

function secureOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event)) return;
    handler(event, ...args);
  });
}

/* 权限弹窗排队：并行工具调用时一次只弹一个授权窗口 */
let permissionChain = Promise.resolve();

function askPermission(descriptor) {
  const run = permissionChain.then(() => doAskPermission(descriptor));
  permissionChain = run.then(() => {}, () => {});
  return run;
}

async function doAskPermission(descriptor) {
  // 冒烟测试：工作区内的路径视为用户已批准，其余一律拒绝
  if (SMOKE_TEST) {
    const ok = descriptor.path ? descriptor.path.startsWith(WORKSPACE) : false;
    console.log(`[smoke] permission ${ok ? 'ALLOW' : 'DENY'}: ${descriptor.action} ${descriptor.path || descriptor.command}`);
    return { allow: ok, remember: false };
  }
  if (!mainWindow) {
    logApp('warn', `[perm] 无法弹窗（mainWindow 为空）：${descriptor.action} ${descriptor.path || descriptor.command || ''}`);
    return { allow: false, remember: false };
  }
  return new Promise((resolve) => {
    const permId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      pendingPermissions.delete(permId);
      logApp('warn', `[perm] 超时拒绝：${permId} ${descriptor.action}`);
      resolve({ allow: false, remember: false }); // 超时默认拒绝
    }, 60000);
    pendingPermissions.set(permId, { resolve, timer });
    send('permission:ask', { permId, ...descriptor });
    logApp('info', `[perm] ask 已发送: ${descriptor.action} ${descriptor.path || descriptor.command || (descriptor.mcpTool ? descriptor.mcpServer + '/' + descriptor.mcpTool : '')}`);
    // 弹窗弹出时把窗口带到前台，确保用户一定能看到授权请求
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    // 系统通知兜底（窗口可能被其他应用遮挡）
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        new Notification({
          title: '🔐 DeepSeek Desktop 需要授权',
          body: `${descriptor.action}：${descriptor.path || descriptor.command || (descriptor.mcpTool ? descriptor.mcpServer + '/' + descriptor.mcpTool : '')}`,
        }).show();
      }
    } catch {}
  });
}

/* 向上找 git 仓库根目录（.git 所在目录） */
function findGitRoot(p) {
  let dir = p;
  try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch {}
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    try {
      if (fs.statSync(path.join(cur, '.git')).isDirectory()) return cur;
    } catch {}
    cur = path.dirname(cur);
  }
  return null;
}

secureHandle('permission:respond', (_e, { permId, allow, remember }) => {
  const p = pendingPermissions.get(permId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingPermissions.delete(permId);
  logApp('info', `[perm] respond: ${permId} allow=${allow} remember=${remember}`);
  p.resolve({ allow: Boolean(allow), remember: Boolean(remember) });
});

/* ---------- 工具实现 ---------- */

const TOOL_ICONS = { read_file: '📄', list_dir: '📂', grep: '🔍', file_stat: 'ℹ️', run_command: '💻' };

function toolIcon(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith('mcp__')) return '🔌';
  return '🔧';
}

async function ensureReadPermission(p) {
  if (isTrusted(p)) return { allow: true };
  // 记住目标：git 仓库根（审计场景一次授权覆盖整个仓库），否则为文件所在目录/路径本身
  let stat = null;
  try { stat = await fsp.stat(p); } catch {}
  const rememberTarget = findGitRoot(p) || (stat && stat.isDirectory() ? p : path.dirname(p));
  const r = await askPermission({
    kind: 'file', action: '读取', path: p,
    rememberTarget,
    gitRoot: rememberTarget === findGitRoot(p),
  });
  if (!r.allow) return { allow: false };
  if (r.remember) rememberPath(rememberTarget);
  return { allow: true };
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* 写入授权：工作区/信任目录内免弹窗（与读取一致），之外每次弹窗 */
async function ensureWritePermission(p) {
  if (isTrustedWriteTarget(p)) return { allow: true };
  const r = await askPermission({ kind: 'write', action: '写入文件', path: p });
  if (!r.allow) return { allow: false };
  return { allow: true };
}

async function executeTool(name, args, masterSignal) {
  // 参数解析失败（单轮输出被截断）：统一友好报错，避免模型反复"换参数格式"
  if (args && args._parseError) {
    return { error: '工具参数解析失败（可能是单轮输出被截断）。请减小单次生成的内容，或分多次调用（大文件用 write_file 分次 + append）。' };
  }
  // MCP 工具（前缀 mcp__server__tool）走 MCP 客户端
  if (name.startsWith('mcp__')) return callMcpTool(name, args);
  switch (name) {
    case 'read_file': {
      const requested = resolveToolPath(String(args.path || ''));
      const p = safeRealpath(requested) || requested;
      if (!(await ensureReadPermission(p)).allow) return { error: '用户拒绝了文件访问权限（或授权超时）' };
      let stat;
      try { stat = await fsp.stat(p); } catch (e) { return { error: `无法访问 ${p}: ${e.message}` }; }
      if (stat.isDirectory()) return { error: `${p} 是目录，请用 list_dir 列出内容` };
      const maxBytes = Math.min(parseInt(args.max_bytes, 10) || 200000, 1000000);
      const handle = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
        return { path: p, bytes: bytesRead, truncated: bytesRead === maxBytes, content: buf.toString('utf8', 0, bytesRead) };
      } finally {
        await handle.close().catch(() => {});
      }
    }
    case 'list_dir': {
      const requested = resolveToolPath(String(args.path || ''));
      const p = safeRealpath(requested) || requested;
      if (!(await ensureReadPermission(p)).allow) return { error: '用户拒绝了文件访问权限（或授权超时）' };
      let stat;
      try { stat = await fsp.stat(p); } catch (e) { return { error: `无法访问 ${p}: ${e.message}` }; }
      if (!stat.isDirectory()) return { error: `${p} 不是目录` };
      const depth = Math.min(Math.max(parseInt(args.depth, 10) || 0, 0), 2);
      const entries = [];
      const MAX_ENTRIES = 300;
      const walk = async (dir, d) => {
        if (d > depth || entries.length >= MAX_ENTRIES) return;
        let items = [];
        try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        const stats = await Promise.all(items.map((it) => fsp.stat(path.join(dir, it.name)).catch(() => null)));
        for (let i = 0; i < items.length && entries.length < MAX_ENTRIES; i++) {
          const it = items[i];
          if (it.name.startsWith('.')) continue;
          const s = stats[i];
          entries.push({
            name: it.name,
            type: it.isDirectory() ? 'dir' : 'file',
            size: s ? s.size : 0,
            modified: s ? s.mtime.toISOString() : '',
          });
          if (it.isDirectory()) await walk(path.join(dir, it.name), d + 1);
          if (entries.length >= MAX_ENTRIES) return;
        }
      };
      await walk(p, 0);
      return { path: p, count: entries.length, truncated: entries.length >= MAX_ENTRIES, entries };
    }
    case 'grep': {
      const requested = resolveToolPath(String(args.path || ''));
      const p = safeRealpath(requested) || requested;
      if (!(await ensureReadPermission(p)).allow) return { error: '用户拒绝了文件访问权限（或授权超时）' };
      let re;
      const patternStr = String(args.pattern || '');
      // 防 ReDoS：限制长度与嵌套重复量词
      if (patternStr.length > 128) return { error: '正则过长（最多 128 字符）' };
      if (/\([^)]*[+*{][^)]*\)[+*{]/.test(patternStr)) {
        return { error: '正则包含嵌套重复量词（可能导致灾难性回溯），已拒绝' };
      }
      try { re = new RegExp(patternStr, 'i'); } catch (e) { return { error: `正则无效: ${e.message}` }; }
      const maxMatches = Math.min(parseInt(args.max_matches, 10) || 50, 200);
      const results = [];
      const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.DS_Store', '.venv']);
      let visitedFiles = 0;
      const visit = async (target) => {
        let stat;
        try { stat = await fsp.stat(target); } catch { return; }
        if (stat.isDirectory()) {
          let items = [];
          try { items = await fsp.readdir(target); } catch { return; }
          for (const it of items) {
            if (SKIP.has(it) || results.length >= maxMatches || visitedFiles >= 5000) return;
            await visit(path.join(target, it));
          }
        } else if (stat.size <= 2 * 1024 * 1024) {
          visitedFiles += 1;
          try {
            const text = await fsp.readFile(target, 'utf8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
              if (re.test(lines[i])) {
                results.push({ file: target, line: i + 1, text: lines[i].slice(0, 200) });
              }
            }
          } catch {}
        }
      };
      await visit(p);
      return { path: p, count: results.length, truncated: results.length >= maxMatches, matches: results };
    }
    case 'file_stat': {
      const requested = resolveToolPath(String(args.path || ''));
      const p = safeRealpath(requested) || requested;
      if (!(await ensureReadPermission(p)).allow) return { error: '用户拒绝了文件访问权限（或授权超时）' };
      try {
        const s = await fsp.stat(p);
        return {
          path: p,
          type: s.isDirectory() ? 'directory' : 'file',
          size: s.size,
          modified: s.mtime.toISOString(),
          created: s.birthtime.toISOString(),
          mode: s.mode.toString(8),
        };
      } catch (e) { return { error: `无法访问 ${p}: ${e.message}` }; }
    }
    case 'run_command': {
      const command = String(args.command || '').trim();
      if (!command) return { error: '命令为空' };
      // 只读模式：禁止执行命令
      if (settings && settings.readOnly) return { error: '只读模式已开启，禁止执行命令（可在设置中关闭）' };
      const cwd = path.resolve(String(args.cwd || '') || (settings && settings.workspace) || os.homedir());
      // 含 shell 运算符 → 需要用户授权后用 shell 执行；否则 execFile 命令/参数分离
      const SHELL_META = /[;&|`\n]|\$\s*\(|\$\{/;
      const hasMeta = SHELL_META.test(command);
      const argv = hasMeta ? [] : command.split(/\s+/).filter(Boolean);
      const cmdName = argv[0] || command.split(/\s+/)[0];
      const cmdArgs = argv.slice(1);
      // 白名单仅对无 shell 运算符的简单命令生效；复合命令一律弹窗授权
      const allowList = Array.isArray(settings && settings.allowedCommands) ? settings.allowedCommands : [];
      // 白名单仅对无 shell 运算符的简单命令生效；仅允许完整命令精确匹配（命令名级授权会让任意参数绕过确认）
      const whitelisted = !hasMeta && allowList.includes(command);
      // 默认只读命令白名单：仅当在工作区/信任目录内运行时免弹窗（检查环境不卡住）
      const inTrustedCwd = isTrusted(cwd);
      const safeDefault = !hasMeta && inTrustedCwd && DEFAULT_SAFE_COMMANDS.includes(command);
      if (!whitelisted && !safeDefault) {
        const r = await askPermission({ kind: 'command', action: '执行命令', command, cwd, shell: hasMeta });
        if (!r.allow) return { error: '用户拒绝了命令执行权限（或授权超时）' };
        if (r.remember && !hasMeta) {
          if (!allowList.includes(command)) saveSettings({ allowedCommands: [...allowList, command] });
        }
      }
      const opts = {
        cwd,
        timeout: Math.min(parseInt(args.timeout_ms, 10) || 30000, 60000),
        maxBuffer: 2 * 1024 * 1024,
        signal: masterSignal || undefined,
        env: enrichedEnv(),
      };
      return new Promise((res) => {
        const cb = (err, stdout, stderr) => {
          if (err) {
            res({
              exit_code: typeof err.code === 'number' ? err.code : -1,
              stdout: (stdout || '').slice(0, 100000),
              stderr: (stderr || '').slice(0, 100000),
              error: err.message,
            });
          } else {
            res({ exit_code: 0, stdout: (stdout || '').slice(0, 100000), stderr: (stderr || '').slice(0, 100000) });
          }
        };
        if (hasMeta) exec(command, opts, cb);
        else execFile(cmdName, cmdArgs, opts, cb);
      });
    }
    case 'write_file': {
      const p = resolveToolPath(String(args.path || ''));
      if (!p || p === '/') return { error: '路径无效' };
      if (args._parseError) {
        return { error: '工具参数不完整（可能是单轮输出长度截断所致）。请缩小单次写入内容（≤8000 字符），或分多次调用并用 append:true 追加。' };
      }
      // 只读模式：禁止写入
      if (settings && settings.readOnly) return { error: '只读模式已开启，禁止写入文件（可在设置中关闭）' };
      const content = String(args.content ?? '');
      if (content.length > 6000) {
        return { error: `ERROR: content too long (${content.length} chars > 6000 limit). Split into multiple write_file calls: each content <= 6000 chars; first call without append, subsequent calls with append:true. 内容过长，请分段：每次 content ≤6000 字符，第一次不传 append，之后每次 append:true 追加。` };
      }
      const append = Boolean(args.append);
      // 工作区/信任目录内免弹窗，之外每次授权
      const perm = await ensureWritePermission(p);
      if (!perm.allow) return { error: '用户拒绝了写入权限（或授权超时）' };
      console.log(`[tool] write_file ${append ? 'append' : 'write'} -> ${p} (${content.length} chars)`);
      logApp('info', `[tool] write_file ${append ? 'append' : 'write'} -> ${p} (${content.length} chars)`);
      try {
        writeTextNoFollow(p, content, append);
        return { path: p, bytes: Buffer.byteLength(content, 'utf8'), ok: true, append };
      } catch (e) {
        return { error: `写入失败: ${e.message}` };
      }
    }
    default:
      return { error: `未知工具: ${name}` };
  }
}

function summarizeToolResult(name, result) {
  if (result.error) return `失败: ${result.error}`;
  if (name.startsWith('mcp__')) {
    const s = String(result.content || '');
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
  switch (name) {
    case 'read_file': return fmtSize(result.bytes) + (result.truncated ? '（已截断）' : '');
    case 'list_dir': return `${result.count} 项`;
    case 'grep': return `${result.count} 处匹配`;
    case 'file_stat': return `${result.type} · ${fmtSize(result.size)}`;
    case 'run_command': return `exit ${result.exit_code}`;
    case 'write_file': return result.ok ? `已写入 ${fmtSize(result.bytes)}` : `失败: ${result.error}`;
    default: return '完成';
  }
}

/* ================= DeepSeek 流式（含工具） ================= */

function buildMessages(req) {
  const msgs = [];
  if (req.system && req.system.trim()) msgs.push({ role: 'system', content: req.system.trim() });
  if (settings && settings.workspace && req.mode !== 'chat') {
    msgs.push({
      role: 'system',
      content: `当前工作区目录：${settings.workspace}。工具调用中的相对路径以此目录为基准。`,
    });
  }
  const tail = (req.messages || []).slice(-60);
  for (const m of tail) {
    if (m.role === 'user' || m.role === 'assistant') {
      const content = String(m.text || m.content || '');
      // 单条消息限长（附件/超长内容截断，防止请求体过大被 API 拒绝）
      msgs.push({ role: m.role, content: content.length > 100000 ? content.slice(0, 100000) + '\n…（内容过长已截断）' : content });
    }
  }
  if (msgs.length === 0) msgs.push({ role: 'user', content: '你好' });
  return msgs;
}

async function streamChat(req, onDelta) {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error('未找到 DEEPSEEK_API_KEY（可在设置中填写）');

  let timedOut = false; // 供看门狗与错误分支使用

  const controller = new AbortController();
  activeRequests.set(req.id, controller);

  // master 取消（用户点停止）时，联动中止本轮流式
  let onMasterAbort = null;
  if (req.masterSignal) {
    onMasterAbort = () => controller.abort();
    if (req.masterSignal.aborted) controller.abort();
    else req.masterSignal.addEventListener('abort', onMasterAbort);
  }

  const toolsEnabled = req.mode !== 'chat'; // Chat 模式不带工具
  const configuredBase = (settings && settings.apiBase && String(settings.apiBase).trim()) || DEEPSEEK_BASE;
  const parsedBase = new URL(configuredBase);
  const localHttp = parsedBase.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsedBase.hostname);
  if (parsedBase.protocol !== 'https:' && !localHttp) {
    throw new Error('API Base 必须使用 HTTPS；只有本机 localhost 地址可使用 HTTP');
  }
  const base = parsedBase.href.replace(/\/$/, '');
  const body = {
    model: req.model || DEFAULT_MODEL,
    messages: req.messages,
    stream: true,
    temperature: typeof req.temperature === 'number' ? req.temperature : 0.7,
    max_tokens: req.maxTokens || 4096,
    stream_options: { include_usage: true },
  };
  if (toolsEnabled) body.tools = buildToolsDefinitions();

  // 原生 http/https POST（不依赖 Electron fetch / Chromium 网络栈，行为一致且可控）
  function apiPost(bodyStr, withUsage, signal) {
    return new Promise((resolve, reject) => {
      const b = { ...body };
      if (!withUsage) delete b.stream_options;
      const bodyJson = bodyStr ?? JSON.stringify(b);
      const u = new URL(`${base}/chat/completions`);
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(bodyJson),
        },
      }, (res) => {
        settled = true;
        resolve(res);
      });
      req.on('error', (e) => {
        if (settled) return;
        const err = new Error(e.message);
        err.cause = e;
        reject(err);
      });
      if (signal) {
        if (signal.aborted) { req.destroy(); reject(Object.assign(new Error('已取消'), { name: 'AbortError' })); return; }
        signal.addEventListener('abort', () => {
          if (!settled) reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
          req.destroy();
        }, { once: true });
      }
      req.write(bodyJson);
      req.end();
    });
  }

  // 网络层重试（瞬时抖动可自愈）
  async function doFetchWithRetry(withUsage, attempts = 3) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await apiPost(null, withUsage, controller.signal);
      } catch (e) {
        lastErr = e;
        if (e.name === 'AbortError') throw e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, (i + 1) * 1000));
      }
    }
    throw lastErr;
  }

  function readBody(stream) {
    return new Promise((resolve, reject) => {
      let s = '';
      stream.on('data', (d) => { s += d; });
      stream.on('end', () => resolve(s));
      stream.on('error', reject);
    });
  }

  let res;
  let lastErrorDetail = '';
  // 连接阶段也纳入看门狗（fetch 建立连接可能卡死）
  let watchdog = null;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120000);
  };
  armWatchdog();
  try {
    res = await doFetchWithRetry(true);
    if (res.statusCode === 400) {
      // 检查是否为 stream_options 不被支持；同时缓存 body 供错误信息使用
      const txt = await readBody(res);
      lastErrorDetail = txt.slice(0, 500);
      if (/stream_options|include_usage/i.test(txt)) {
        res = await doFetchWithRetry(false);
        lastErrorDetail = '';
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(timedOut ? '请求超时，已停止' : '已取消');
    const causeCode = e.cause && e.cause.code ? ` (${e.cause.code})` : '';
    const hint = /ENOTFOUND|EAI_AGAIN/.test(causeCode)
      ? '，DNS 解析失败'
      : /ECONNREFUSED|ECONNRESET/.test(causeCode)
        ? '，连接被拒绝'
        : '';
    throw new Error(`网络请求失败: ${e.message}${causeCode}${hint}。若开启了系统代理/VPN，请检查其状态后重试`);
  } finally {
    activeRequests.delete(req.id);
    clearTimeout(watchdog);
  }

  if (res.statusCode !== 200) {
    let detail = lastErrorDetail;
    if (!detail) {
      try {
        detail = (await readBody(res)).slice(0, 500);
      } catch {}
    }
    throw new Error(`API 错误 ${res.statusCode}: ${detail || res.statusMessage}`);
  }

  // 原生流读取（IncomingMessage 支持异步迭代）
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let toolPendingNotified = false;
  const toolCalls = new Map(); // index -> {index, id, name, args}

  // 读取阶段重新计时（watchdog 已在 fetch 前 arm）
  armWatchdog();

  // 增量去抖：40ms 批量发送，降低 IPC 频率（卡顿修复之一）
  const deltaQueue = [];
  let flushTimer = null;
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (deltaQueue.length) {
      const batch = deltaQueue.splice(0);
      for (const d of batch) onDelta(d);
    }
  };
  const queue = (d) => {
    deltaQueue.push(d);
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const j = JSON.parse(data);
      const choice = j.choices && j.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        queue({ type: 'reasoning', text: delta.reasoning_content });
      }
      if (delta.content) {
        text += delta.content;
        queue({ type: 'text', text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        if (!toolPendingNotified) {
          toolPendingNotified = true;
          queue({ type: 'tool_pending' });
        }
        for (const tc of delta.tool_calls) {
          const cur = toolCalls.get(tc.index) || { index: tc.index, id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name = tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
          toolCalls.set(tc.index, cur);
        }
      }
      if (j.usage && j.usage.total_tokens) usage = j.usage;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    } catch {}
  };

  try {
    for await (const chunk of res) {
      armWatchdog();
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) handleLine(l);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(timedOut ? '请求超时，已停止' : '已取消');
    throw e;
  } finally {
    clearTimeout(watchdog);
    if (onMasterAbort && req.masterSignal) {
      req.masterSignal.removeEventListener('abort', onMasterAbort);
    }
  }
  if (buf.trim()) handleLine(buf);
  flush();
  onDelta({ type: 'end' });

  // 空回复检测：流正常结束但无任何内容 → 明确报错（防止"没反应"）
  if (!text && !reasoning && toolCalls.size === 0) {
    logApp('error', `[chat] 空回复（finish=${finishReason || 'unknown'}）`);
    throw new Error('模型未返回任何内容（可能是服务异常或输出被截断）。请重试。');
  }

  return {
    text,
    reasoning,
    usage,
    finishReason,
    toolCalls: [...toolCalls.values()]
      .filter((t) => t.id || t.name)
      .map((t) => {
        let parsed = null;
        let parseFailed = false;
        try {
          parsed = JSON.parse(t.args || '{}');
          if (typeof parsed !== 'object' || parsed === null) { parseFailed = true; parsed = { _parseError: true }; }
        } catch (e) {
          parseFailed = true;
          console.warn(`[tool] args parse failed: len=${t.args.length}, err=${e.message}, head=${JSON.stringify(t.args.slice(0, 80))}`);
          logApp('error', `[tool] args parse failed: len=${t.args.length}, err=${e.message}, head=${JSON.stringify(t.args.slice(0, 80))}`);
          // 不把原始大串回传模型（避免模型误以为参数格式问题）；仅标记解析失败
          parsed = { _parseError: true };
        }
        return { id: t.id, name: t.name, arguments: parsed, parseFailed };
      }),
  };
}

/* ================= 工具调用循环 ================= */

/* 工具执行超时包装：防止工具挂起导致整个对话卡死 */
const TOOL_TIMEOUT_MS = 90000;
function withToolTimeout(promise, masterSignal, toolName) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`工具 ${toolName} 执行超时（90 秒），已中止`)), TOOL_TIMEOUT_MS);
      if (masterSignal) {
        masterSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('已取消'));
        }, { once: true });
      }
      if (promise.finally) {
        promise.finally(() => clearTimeout(timer)).catch(() => {});
      }
    }),
  ]);
}

async function agenticChat(req, onDelta) {
  const msgs = buildMessages(req);
  let toolsExecuted = 0;
  let totalUsage = null;
  const masterSignal = req.masterSignal || null;
  const callFingerprints = new Map(); // 防重复工具空转
  const addUsage = (u) => {
    if (!u) return;
    if (!totalUsage) totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    totalUsage.prompt_tokens += u.prompt_tokens || 0;
    totalUsage.completion_tokens += u.completion_tokens || 0;
    totalUsage.total_tokens += u.total_tokens || 0;
  };
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    if (masterSignal && masterSignal.aborted) throw new Error('已取消');
    // 输出预算按模型分级：reasoner 32K / chat 16K（实测 API 上限，大幅降低截断）
    const modelName = req.model || DEFAULT_MODEL;
    const maxTokens = modelName === 'deepseek-reasoner' ? 32768 : 16384;
    const res = await streamChat({ ...req, id: req.id, messages: msgs, maxTokens }, onDelta);
    addUsage(res.usage);

    const calls = res.toolCalls || [];
    if (calls.length === 0) return { toolsExecuted, rounds: round, usage: totalUsage, finishReason: res.finishReason }; // 本轮即最终回答

    if (calls.length > MAX_TOOL_CALLS) throw new Error('工具调用数量过多');
    if (masterSignal && masterSignal.aborted) throw new Error('已取消');

    // 防重复空转：同一指纹（工具+参数）累计 3 次即停止
    for (const tc of calls) {
      let fp;
      try { fp = tc.name + '|' + JSON.stringify(tc.arguments || {}); } catch { fp = tc.name; }
      const n = (callFingerprints.get(fp) || 0) + 1;
      callFingerprints.set(fp, n);
      if (n >= 3) {
        throw new Error(`检测到重复工具调用（${tc.name} 已连续 3 次相同），已停止以避免空转。可以换一种方式或告诉我具体要做什么。`);
      }
    }

    // 把本轮的工具调用作为 assistant 消息提交给模型
    msgs.push({
      role: 'assistant',
      content: res.text || null,
      tool_calls: calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      })),
    });

    // 本轮所有工具调用并行执行（权限弹窗由队列串行处理）
    for (const tc of calls) {
      onDelta({
        type: 'tool', tool: tc.name, args: tc.arguments, status: 'start',
        icon: toolIcon(tc.name),
      });
    }
    const outcomes = await Promise.all(calls.map(async (tc) => {
      toolsExecuted += 1;
      try {
        const result = await withToolTimeout(executeTool(tc.name, tc.arguments || {}, masterSignal), masterSignal, tc.name);
        if (result && result.error) {
          logApp('error', `[tool] ${tc.name} error: ${String(result.error).slice(0, 300)}`);
        } else {
          logApp('info', `[tool] ${tc.name} done: ${summarizeToolResult(tc.name, result).slice(0, 120)}`);
        }
        onDelta({
          type: 'tool', tool: tc.name, status: 'done',
          summary: summarizeToolResult(tc.name, result), icon: toolIcon(tc.name),
        });
        return { tc, result };
      } catch (e) {
        logApp('error', `[tool] ${tc.name} threw: ${e.message}`);
        onDelta({ type: 'tool', tool: tc.name, status: 'error', summary: e.message, icon: toolIcon(tc.name) });
        return { tc, result: { error: e.message } };
      }
    }));
    if (masterSignal && masterSignal.aborted) throw new Error('已取消');
    // 按工具调用顺序把结果回填给模型
    for (const { tc, result } of outcomes) {
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: truncateToolResult(result) });
    }
  }
  throw new Error('工具调用轮次超过上限（' + MAX_TOOL_ROUNDS + '）。可以回复「继续」让我接着完成审计。');
}

/* 工具结果限长，防止撑爆模型上下文 */
function truncateToolResult(result) {
  let json;
  try {
    json = JSON.stringify(result);
  } catch {
    return JSON.stringify({ error: '工具结果无法序列化' });
  }
  const MAX = 150000;
  if (json.length <= MAX) return json;
  return JSON.stringify({
    _truncated: true,
    _note: `结果过大已截断（原 ${json.length} 字符）`,
    _data: json.slice(0, 120000),
  });
}

/* ================= MCP 客户端管理器 ================= */

/* 补全 PATH：GUI 启动的应用 PATH 精简，找不到 npx/node 等常见命令 */
function enrichedEnv() {
  const extra = [];
  const home = os.homedir();
  extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  // 常见 Node 版本管理器安装路径
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmDir)) extra.push(path.join(nvmDir, v, 'bin'));
  } catch {}
  try {
    const wbDir = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
    for (const v of fs.readdirSync(wbDir)) extra.push(path.join(wbDir, v, 'bin'));
  } catch {}
  try { extra.push(path.join(home, '.volta', 'bin')); } catch {}
  try { extra.push(path.join(home, '.fnm')); } catch {}
  if (process.env.PATH) extra.unshift(process.env.PATH);
  return { ...process.env, PATH: extra.filter(Boolean).join(':') };
}

/* 引号感知的命令拆分：把「npx xxx /path」拆成 [npx, xxx, /path] */
function splitCommand(cmd) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/* 从补全后的 PATH 解析命令绝对路径（用于更明确的报错） */
function resolveInPath(command) {
  const cmd = splitCommand(command)[0] || command;
  if (cmd.includes('/')) {
    return fs.existsSync(cmd) ? cmd : null;
  }
  for (const dir of enrichedEnv().PATH.split(':')) {
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

const mcpClients = new Map(); // serverName -> { client, transport, tools: Map, trusted, cfg, error }

function mcpServerList() {
  return Array.isArray(settings && settings.mcpServers) ? settings.mcpServers : [];
}

async function connectMcpServer(cfg) {
  const name = String(cfg.name || '').trim();
  const command = String(cfg.command || '').trim();
  if (!name || !command) return { ok: false, error: '服务器名称与命令不能为空' };
  if (!/^[a-zA-Z0-9-]+$/.test(name) || name.includes('__')) return { ok: false, error: '名称仅允许字母、数字、连字符（且不含 __）' };

  let client = null;
  let transport = null;
  try {
    await disconnectMcpServer(name);

    // 用户可能把整条命令行填入 command，需拆分为「命令名 + 参数」
    const tokens = splitCommand(command);
    const cmd = tokens[0] || command;
    const cmdArgs = [...tokens.slice(1), ...(Array.isArray(cfg.args) ? cfg.args : [])];

    client = new Client({ name: 'deepseek-desktop', version: app.getVersion() });
    transport = new StdioClientTransport({
      command: cmd,
      args: cmdArgs,
      env: enrichedEnv(),
    });
    const pending = {
      client, transport, tools: new Map(),
      trusted: Boolean(cfg.trusted),
      trustedTools: new Set(Array.isArray(cfg.trustedTools) ? cfg.trustedTools : []),
      cfg: { ...cfg, name, command }, error: null,
    };
    mcpClients.set(name, pending);
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const tools = new Map();
    for (const t of (toolsResult.tools || [])) tools.set(t.name, t);
    pending.tools = tools;
    console.log(`[mcp] connected "${name}": ${tools.size} tools`);
    return { ok: true, toolsCount: tools.size, tools: [...tools.keys()] };
  } catch (e) {
    console.error(`[mcp] connect "${name}" failed: ${e.message}`);
    let msg = e.message;
    if (/ENOENT/.test(e.message)) {
      const cmd = splitCommand(command)[0] || command;
      const found = resolveInPath(command);
      msg = found
        ? `无法启动命令（${cmd} 解析到 ${found} 但执行失败）`
        : `找不到命令「${cmd}」。请确认已安装 Node.js，或在设置里使用完整路径（如 /opt/homebrew/bin/npx @modelcontextprotocol/server-filesystem /path）`;
    }
    const current = mcpClients.get(name);
    if (current && current.transport === transport) {
      try { if (client) await client.close(); } catch {}
      mcpClients.set(name, { client: null, transport: null, tools: new Map(), trusted: false, trustedTools: new Set(), cfg: { ...cfg, name, command }, error: msg });
    }
    return { ok: false, error: msg };
  }
}

async function disconnectMcpServer(name) {
  const c = mcpClients.get(name);
  if (c && c.client) {
    try { await c.client.close(); } catch {}
  }
  mcpClients.delete(name);
}

async function disconnectAllMcp() {
  for (const name of [...mcpClients.keys()]) {
    await disconnectMcpServer(name);
  }
}

async function initMcpServers() {
  const list = mcpServerList();
  if (list.length === 0) return;
  await Promise.all(list.map((cfg) => connectMcpServer(cfg).catch(() => {})));
  console.log(`[mcp] initialized ${mcpClients.size}/${list.length} servers`);
}

/* 动态工具定义：内置 + 全部已连接 MCP 服务器 */
function buildToolsDefinitions() {
  const defs = TOOL_DEFINITIONS.slice();
  for (const [serverName, c] of mcpClients) {
    for (const [toolName, t] of c.tools) {
      defs.push({
        type: 'function',
        function: {
          name: `mcp__${serverName}__${toolName}`,
          description: `[MCP ${serverName}] ${t.description || toolName}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return defs;
}

function summarizeMcpArgs(args) {
  try {
    return JSON.stringify(args || {}).slice(0, 200);
  } catch {
    return '';
  }
}

/* 调用 MCP 工具（fullName = mcp__server__tool），未信任的服务器走权限弹窗 */
async function callMcpTool(fullName, args) {
  const m = fullName.match(/^mcp__(.+)__(.+)$/);
  if (!m) return { error: '无效的 MCP 工具名' };
  const [, serverName, toolName] = m;
  const c = mcpClients.get(serverName);
  if (!c || !c.client) return { error: `MCP 服务器 ${serverName} 未连接（${c ? c.error || '已断开' : '未配置'}）` };

  if (!c.trusted && !c.trustedTools.has(toolName)) {
    const r = await askPermission({
      kind: 'mcp', action: '调用 MCP 工具',
      mcpServer: serverName, mcpTool: toolName,
      argsSummary: summarizeMcpArgs(args),
    });
    if (!r.allow) return { error: '用户拒绝了 MCP 工具调用（或授权超时）' };
    if (r.remember) {
      c.trusted = true;
      c.cfg.trusted = true;
      const list = mcpServerList().map((s) => (s.name === serverName ? { ...s, trusted: true } : s));
      saveSettings({ mcpServers: list });
    }
  }

  try {
    const res = await c.client.callTool({ name: toolName, arguments: args || {} });
    if (res && Array.isArray(res.content)) {
      const text = res.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
      return text ? { content: text } : { content: JSON.stringify(res) };
    }
    return { content: JSON.stringify(res) };
  } catch (e) {
    return { error: `MCP 工具执行失败: ${e.message}` };
  }
}

/* ---------- MCP 设置 IPC ---------- */

secureHandle('mcp:list', () => {
  return mcpServerList().map((cfg) => {
    const c = mcpClients.get(cfg.name);
    return {
      name: cfg.name,
      command: cfg.command,
      args: cfg.args || [],
      connected: Boolean(c && c.client),
      tools: c ? [...c.tools.keys()] : [],
      toolsCount: c ? c.tools.size : 0,
      trusted: Boolean(c && c.trusted),
      trustedTools: c ? [...c.trustedTools] : [],
      error: c ? c.error : null,
    };
  });
});

/* 工具级信任开关 */
secureHandle('mcp:setToolTrust', (_e, { name, tool, trusted }) => {
  const c = mcpClients.get(String(name || ''));
  if (!c) return { ok: false, error: '服务器未连接' };
  const toolName = String(tool || '');
  if (trusted) c.trustedTools.add(toolName);
  else c.trustedTools.delete(toolName);
  c.cfg.trustedTools = [...c.trustedTools];
  const list = mcpServerList().map((s) => (s.name === name ? { ...s, trustedTools: [...c.trustedTools] } : s));
  saveSettings({ mcpServers: list });
  return { ok: true, trustedTools: [...c.trustedTools] };
});

/* 连接 MCP 服务器带超时（npx 首次拉包可能很慢） */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000} 秒）`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

secureHandle('mcp:add', async (_e, { name, command, args }) => {
  const cfg = {
    name: String(name || '').trim(),
    command: String(command || '').trim(),
    args: Array.isArray(args) ? args.map(String) : [],
  };
  if (!cfg.name || !cfg.command) return { ok: false, error: '名称与命令不能为空' };
  if (!/^[a-zA-Z0-9-]+$/.test(cfg.name) || cfg.name.includes('__')) return { ok: false, error: '名称仅允许字母、数字、连字符（且不含 __）' };
  try {
    const permission = await askPermission({
      kind: 'mcp_start', action: '启动 MCP 服务器', command: cfg.command,
      argsSummary: JSON.stringify(cfg.args).slice(0, 300),
    });
    if (!permission.allow) return { ok: false, error: '用户拒绝启动 MCP 服务器（或授权超时）' };
    // 先测试连接（带 60s 超时）
    const test = await withTimeout(connectMcpServer(cfg), 60000, '连接');
    if (!test.ok) return { ok: false, error: test.error };
    // 成功则保存
    const list = mcpServerList().filter((s) => s.name !== cfg.name);
    list.push(cfg);
    saveSettings({ mcpServers: list });
    return { ok: true, toolsCount: test.toolsCount };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

secureHandle('mcp:remove', async (_e, name) => {
  await disconnectMcpServer(String(name || ''));
  const list = mcpServerList().filter((s) => s.name !== name);
  saveSettings({ mcpServers: list });
  return { ok: true };
});

secureHandle('mcp:test', async (_e, { name, command, args }) => {
  const testName = `test-${Date.now()}`;
  const testCommand = String(command || '').trim();
  try {
    const permission = await askPermission({
      kind: 'mcp_start', action: '测试 MCP 服务器', command: testCommand,
      argsSummary: JSON.stringify(Array.isArray(args) ? args : []).slice(0, 300),
    });
    if (!permission.allow) return { ok: false, error: '用户拒绝启动测试进程（或授权超时）' };
    const result = await withTimeout(connectMcpServer({
      name: testName,
      command: testCommand,
      args: Array.isArray(args) ? args.map(String) : [],
    }), 60000, '连接');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await disconnectMcpServer(testName);
  }
});

/* 工作区文件树（仅限工作区内，免授权） */
const FT_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.DS_Store', '.venv', '__pycache__']);

function workspaceReal() {
  const ws = settings && settings.workspace;
  if (!ws) return null;
  return safeRealpath(expandHome(ws));
}

function withinWorkspace(p) {
  const root = workspaceReal();
  const real = safeRealpath(p);
  if (!root || !real) return false;
  return real === root || real.startsWith(root + path.sep);
}

function resolveInWorkspace(p) {
  const root = workspaceReal();
  const base = root || os.homedir();
  const full = path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
  if (!withinWorkspace(full)) return null;
  return safeRealpath(full);
}

secureHandle('fs:listDir', async (_e, dirPath) => {
  const root = workspaceReal();
  if (!root) return { ok: false, error: '未设置工作区' };
  const dir = resolveInWorkspace(dirPath || root);
  if (!dir) return { ok: false, error: '路径不在工作区内' };
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    const entries = items
      .filter((it) => !it.name.startsWith('.') && !FT_SKIP.has(it.name))
      .map((it) => ({ name: it.name, type: it.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, path: dir, entries };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

secureHandle('fs:preview', async (_e, filePath) => {
  const full = resolveInWorkspace(String(filePath || ''));
  if (!full) return { ok: false, error: '路径不在工作区内' };
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) return { ok: false, error: '这是目录' };
    const MAX = 8000;
    const handle = await fsp.open(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return {
        ok: true,
        path: full,
        size: stat.size,
        truncated: stat.size > MAX,
        text: buf.toString('utf8', 0, bytesRead),
      };
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ================= IPC ================= */

secureHandle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  apiBase: (settings && settings.apiBase) || DEEPSEEK_BASE,
  apiKeyConfigured: Boolean(resolveApiKey()),
  model: (settings && settings.model) || DEFAULT_MODEL,
  workspace: (settings && settings.workspace) || null,
  readOnly: Boolean(settings && settings.readOnly),
}));

function publicSettings() {
  const { apiKey: _plain, apiKeyEncrypted: _encrypted, ...safe } = settings || {};
  return { ...safe, apiKeyConfigured: Boolean(resolveApiKey()), apiKeySource: apiKeySource() };
}

secureHandle('settings:get', () => publicSettings());

/* 允许持久化的设置键（白名单 + 类型校验，防止任意字段注入） */
const SETTING_KEYS = ['model', 'system', 'temperature', 'maxTokens', 'trustHome', 'trustedRoots', 'workspace', 'readOnly', 'allowedCommands', 'theme', 'mode', 'apiKey', 'apiBase', 'customModels'];

secureHandle('settings:set', (_e, patch) => {
  const next = {};
  if (patch && typeof patch === 'object') {
    for (const k of Object.keys(patch)) {
      if (!SETTING_KEYS.includes(k)) continue;
      const v = patch[k];
      switch (k) {
        case 'trustHome':
        case 'readOnly':
          next[k] = Boolean(v);
          break;
        case 'temperature':
          if (typeof v === 'number' && v >= 0 && v <= 2) next[k] = v;
          break;
        case 'maxTokens':
          if (typeof v === 'number' && v >= 256 && v <= 16384) next[k] = Math.floor(v);
          break;
        case 'trustedRoots':
        case 'allowedCommands':
          if (Array.isArray(v)) {
            next[k] = v.map((x) => String(x).trim()).filter((x) => x && x !== '/');
          }
          break;
        case 'apiBase':
          if (typeof v === 'string' && v.trim().length <= 200) {
            try {
              const u = new URL(v.trim());
              const localHttp = u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
              if (u.protocol === 'https:' || localHttp) next.apiBase = u.href.replace(/\/$/, '');
            } catch {}
          }
          break;
        case 'customModels':
          if (typeof v === 'string' && v.length <= 2000) {
            next.customModels = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
          }
          break;
        case 'workspace': {
          const w = expandHome(String(v ?? '').trim());
          if (w === '') next.workspace = null;      // 显式清空
          else if (w !== '/') next.workspace = w;
          break;
        }
        case 'system':
        case 'theme':
        case 'mode':
          if (typeof v === 'string' && v.length <= 10000) next[k] = v;
          break;
        case 'model':
          if (typeof v === 'string' && v.length <= 500) next[k] = v;
          break;
        case 'apiKey':
          if (typeof v === 'string' && v.length <= 500) next.apiKeyUpdate = v;
          break;
        default:
          break;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(next, 'apiKeyUpdate')) {
    storeApiKey(settings, next.apiKeyUpdate);
    delete next.apiKeyUpdate;
  }
  const saved = saveSettings(next);
  return publicSettings(saved);
});

/* 选择工作区目录（原生目录对话框） */
secureHandle('workspace:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作区目录',
    defaultPath: (settings && settings.workspace) || os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths || !filePaths[0]) return { picked: false };
  const ws = filePaths[0];
  saveSettings({ workspace: ws });
  return { picked: true, workspace: ws };
});

/* 窗口置顶切换 */
secureHandle('window:pin', (_e, pin) => {
  if (!mainWindow) return { pinned: false };
  mainWindow.setAlwaysOnTop(Boolean(pin));
  return { pinned: Boolean(pin) };
});

/* 统一错误日志：任何实例（双击/部署）都会写入 userData/app.log，便于排查 */
function logApp(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), line + '\n');
  } catch {}
  if (level === 'error') console.error(line);
  else console.log(line);
}

secureOn('app:log', (_e, { level, msg }) => {
  logApp(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', `[renderer] ${msg}`);
});

/* 读取文本文件（拖放附件用），限 2MB；与工具一致走权限检查 */
secureHandle('file:readText', async (_e, filePath) => {
  try {
    const real = fs.realpathSync(String(filePath));
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      return { ok: false, error: stat.size > 2 * 1024 * 1024 ? '文件超过 2MB 限制' : '不是文件' };
    }
    if (!(await ensureReadPermission(real)).allow) {
      return { ok: false, error: '用户拒绝了文件访问权限' };
    }
    const text = fs.readFileSync(real, 'utf8');
    return { ok: true, path: real, size: stat.size, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* 写入文本文件（Canvas 保存用）：工作区内免弹窗，之外弹窗；只读检查 */
secureHandle('file:writeText', async (_e, { path: filePath, content }) => {
  try {
    if (settings && settings.readOnly) return { ok: false, error: '只读模式已开启，禁止写入文件' };
    const p = resolveToolPath(String(filePath || ''));
    if (!p || p === '/') return { ok: false, error: '路径无效' };
    if (typeof content !== 'string' || content.length > 10 * 1024 * 1024) {
      return { ok: false, error: '内容为空或超过 10MB 限制' };
    }
    const perm = await ensureWritePermission(p);
    if (!perm.allow) return { ok: false, error: '用户拒绝写入（或授权超时）' };
    writeTextNoFollow(p, content, false);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* 全局快捷键：从任意应用唤起（Chat Bar 简化版） */
function registerGlobalShortcut() {
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+Space', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('app:focus-input');
    });
    if (ok) console.log('[shortcut] global Cmd+Shift+Space registered');
  } catch (e) {
    console.error('[shortcut] global registration failed:', e.message);
  }
}

secureHandle('chat:start', async (_e, req) => {
  const id = req.id || String(Date.now());
  // 并发保护：同一 id 已有对话进行中则拒绝（防止 UI 状态机之外的重复请求）
  if (chatMasters.has(id)) return { started: false, error: '已有对话进行中' };
  const master = new AbortController();
  chatMasters.set(id, master);
  try {
    if (req.mode === 'chat') {
      // Chat 模式：单轮纯对话，无工具（必须经过 buildMessages 把 text 映射为 content）
      const msgs = buildMessages(req);
      const res = await streamChat({ ...req, id, messages: msgs, masterSignal: master.signal }, (delta) => send('chat:delta', { id, delta }));
      send('chat:done', { id, ok: true, tools: 0, usage: res.usage || null, finishReason: res.finishReason });
    } else {
      const meta = await agenticChat({ ...req, id, masterSignal: master.signal }, (delta) => send('chat:delta', { id, delta }));
      send('chat:done', { id, ok: true, tools: meta.toolsExecuted, usage: meta.usage || null, finishReason: meta.finishReason });
    }
  } catch (err) {
    logApp('error', `[chat] ${err.message}`);
    console.error('[chat] error:', err.message);
    send('chat:error', { id, message: err.message });
  } finally {
    chatMasters.delete(id);
  }
  return { started: true };
});

secureOn('chat:cancel', (_e, id) => {
  const m = chatMasters.get(id);
  if (m) m.abort();
});

secureHandle('export:save', async (_e, { defaultName, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出对话',
    defaultPath: defaultName || '对话.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { saved: true, filePath };
});

/* 朗读回复（macOS say，数组参数无 shell 注入面） */
let speakProc = null;
secureHandle('speech:speak', (_e, { text }) => {
  try {
    const t = String(text || '').trim().slice(0, 8000);
    if (!t) return { ok: false, error: '无内容' };
    if (speakProc) { try { speakProc.kill('SIGTERM'); } catch {} speakProc = null; }
    speakProc = spawn('say', ['-v', 'Tingting', t]);
    speakProc.on('error', (err) => { console.error('[speech]', err.message); speakProc = null; });
    speakProc.on('exit', () => { speakProc = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
secureHandle('speech:stop', () => {
  if (speakProc) { try { speakProc.kill('SIGTERM'); } catch {} speakProc = null; }
  return { ok: true };
});

/* 互通：把内容复制到剪贴板并尝试打开 DSH Harness 界面（127.0.0.1:3080） */
secureHandle('dsh:toHarness', async (_e, { text }) => {
  try {
    clipboard.writeText(String(text || ''));
    const opened = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: 3080, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        shell.openExternal('http://127.0.0.1:3080');
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    return { ok: true, copied: true, harnessOpened: opened };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ================= 冒烟测试 ================= */

async function runSmokeTest(win) {
  console.log('[smoke] window loaded, running checks...');
  try {
    await runSmokeChecks(win);
    console.log('SMOKE_RESULT_OK');
    app.exit(0);
  } catch (e) {
    console.error('[smoke] FAILED:', e.stack || e.message);
    console.log('SMOKE_RESULT_FAIL');
    app.exit(1);
  }
}

async function runSmokeChecks(win) {

  // 1. UI 回归检查
  try {
    const ui = await win.webContents.executeJavaScript(`(() => {
      const m = document.getElementById('modal-mask');
      const p = document.getElementById('perm-mask');
      const sidebar = document.getElementById('session-list');
      return {
        hidden: m.hidden, display: getComputedStyle(m).display,
        permHidden: p.hidden, sidebar: Boolean(sidebar),
        sessions: sidebar ? sidebar.children.length : 0,
      };
    })()`);
    if (ui.hidden !== true || ui.display !== 'none' || !ui.sidebar || ui.permHidden !== true) {
      throw new Error(`UI 检查失败: ${JSON.stringify(ui)}`);
    }
    console.log(`[smoke] UI check OK (modal hidden, perm hidden, sidebar ${ui.sidebar}, ${ui.sessions} sessions)`);
    // 检查关键元素存在性（bindEvents 若因元素缺失中断，权限弹窗会失效）
    const missing = await win.webContents.executeJavaScript(`(() => {
      const ids = ['perm-mask','btn-perm-allow','btn-perm-deny','perm-remember','modal-mask','session-list','input','btn-send','btn-stop','status-line','file-head','file-tree','preview-panel','canvas-panel','cv-save','shortcuts-mask','btn-close-shortcuts','project-select','mcp-list','mcp-msg','usage-stats','prompt-templates'];
      return ids.filter((id) => !document.getElementById(id));
    })()`);
    if (missing.length > 0) throw new Error(`关键元素缺失: ${missing.join(', ')}`);
    console.log(`[smoke] DOM check OK (all ${missing.length === 0 ? 'elements present' : 'missing: ' + missing.join(',')})`);
  } catch (e) {
    throw new Error(`UI 检查失败: ${e.message}`);
  }

  // 2. 普通对话测试（直接调用 streamChat，消息需为 API 格式：content）
  {
    const started = Date.now();
    const req = {
      id: 'smoke-chat',
      model: (settings && settings.model) || DEFAULT_MODEL,
      system: '你是测试助手。',
      messages: [
        { role: 'system', content: '你是测试助手。' },
        { role: 'user', content: '用一句中文自我介绍，不要超过 30 个字。' },
      ],
      temperature: 0.3,
      maxTokens: 128,
    };
    let got = '';
    await streamChat(req, (delta) => { if (delta.type === 'text') got += delta.text; });
    if (!got) throw new Error('普通对话无输出');
    console.log(`[smoke] chat OK in ${Date.now() - started}ms: ${JSON.stringify(got.slice(0, 60))}`);
  }

  // 3. 工具调用链路测试（审计场景：读取仓库文件，真实执行工具）
  {
    const started = Date.now();
    const req = {
      id: 'smoke-tools',
      model: (settings && settings.model) || DEFAULT_MODEL,
      system: '你是测试助手。你可以调用工具读取本地文件。',
      messages: [{
        role: 'user',
        text: '请使用工具读取文件 /Users/brian/DS-Workspace/ds-desktop/package.json，并告诉我其中的 name 字段值。',
      }],
      temperature: 0.2,
      maxTokens: 512,
    };
    const events = [];
    let finalText = '';
    const meta = await agenticChat(req, (delta) => {
      if (delta.type === 'tool') events.push(delta);
      if (delta.type === 'text') finalText += delta.text;
    });
    const doneTools = events.filter((d) => d.status === 'done').length;
    const okTools = events.filter((d) => d.status !== 'error').length;
    console.log(`[smoke] agentic: rounds=${meta.rounds}, tools=${meta.toolsExecuted} (${doneTools} done), final=${JSON.stringify(finalText.slice(0, 80))}`);
    if (meta.toolsExecuted < 1) throw new Error('工具调用链路失败：模型未调用工具');
    if (okTools < 1) throw new Error('工具调用链路失败：工具执行未成功');
    console.log(`[smoke] tool loop OK in ${Date.now() - started}ms`);
  }

  // 3b. 并行多工具测试：一次读取多个文件（同一轮多个工具调用应并行执行）
  {
    const started = Date.now();
    const req = {
      id: 'smoke-parallel',
      model: (settings && settings.model) || DEFAULT_MODEL,
      system: '你是测试助手。你可以调用工具读取本地文件。',
      messages: [{
        role: 'user',
        text: '请一次性并行读取以下 3 个文件：/Users/brian/DS-Workspace/ds-desktop/package.json、/Users/brian/DS-Workspace/ds-desktop/README.md、/Users/brian/DS-Workspace/ds-desktop/src/main.js。全部读取后分别告诉我每个文件的字节数。',
      }],
      temperature: 0.2,
      maxTokens: 512,
    };
    const events = [];
    await agenticChat(req, (delta) => { if (delta.type === 'tool') events.push(delta); });
    const starts = events.filter((d) => d.status === 'start').length;
    const dones = events.filter((d) => d.status === 'done').length;
    const errors = events.filter((d) => d.status === 'error').length;
    console.log(`[smoke] parallel: starts=${starts}, done=${dones}, errors=${errors}`);
    if (starts < 2 || dones < 2) throw new Error('并行工具测试失败：期望至少 2 个工具调用');
    if (errors > 0) throw new Error(`并行工具测试失败：${errors} 个工具出错`);
    console.log(`[smoke] parallel tool loop OK in ${Date.now() - started}ms`);
  }

  // 3c. write_file 工具测试：模型生成文件内容并写入工作区
  {
    const started = Date.now();
    const req = {
      id: 'smoke-write',
      model: (settings && settings.model) || DEFAULT_MODEL,
      system: '你是测试助手。你可以调用工具写入文件。',
      messages: [{
        role: 'user',
        text: '请使用 write_file 工具，把内容「smoke-write-ok」写入文件 /Users/brian/DS-Workspace/ds-desktop/.smoke-write.txt',
      }],
      temperature: 0.2,
      maxTokens: 512,
    };
    const events = [];
    await agenticChat(req, (delta) => { if (delta.type === 'tool') events.push(delta); });
    const ok = events.some((d) => d.status === 'done' && d.tool === 'write_file');
    const text = fs.existsSync('/Users/brian/DS-Workspace/ds-desktop/.smoke-write.txt')
      ? fs.readFileSync('/Users/brian/DS-Workspace/ds-desktop/.smoke-write.txt', 'utf8')
      : '';
    if (!ok || !text.includes('smoke-write-ok')) {
      throw new Error(`write_file 测试失败: events=${events.length}, file=${JSON.stringify(text)}`);
    }
    console.log(`[smoke] write_file OK in ${Date.now() - started}ms, file=${JSON.stringify(text.slice(0, 30))}`);
  }

  // 3d. run_command 安全白名单：工作区内只读命令免弹窗直接执行
  {
    const started = Date.now();
    const oldWs = settings && settings.workspace;
    saveSettings({ workspace: WORKSPACE });
    const result = await executeTool('run_command', { command: 'pwd', cwd: WORKSPACE });
    // 应直接执行成功（无需权限弹窗——smoke 的 askPermission 对 command 一律拒绝）
    if (!result || result.exit_code !== 0 || !String(result.stdout).includes('DS-Workspace')) {
      throw new Error(`run_command 安全白名单失败: ${JSON.stringify(result)}`);
    }
    // 危险命令（不在白名单）在 smoke 下应被拒绝
    const denied = await executeTool('run_command', { command: 'rm -rf /tmp/x', cwd: WORKSPACE });
    if (!denied || !denied.error) {
      throw new Error(`危险命令未被拦截: ${JSON.stringify(denied)}`);
    }
    saveSettings({ workspace: oldWs || undefined });
    console.log(`[smoke] safe-command OK in ${Date.now() - started}ms (pwd 免弹窗执行, 危险命令被拒)`);
  }

  // 4. Chat 模式：不得产生工具调用，且有正常输出（用渲染层真实格式 {role, text} 历史，防回归）
  {
    const req = {
      id: 'smoke-chat-mode',
      mode: 'chat',
      model: (settings && settings.model) || DEFAULT_MODEL,
      system: '你是测试助手。',
      messages: [
        { role: 'user', text: '用两个字回答：收到' },
      ],
      temperature: 0.2,
      maxTokens: 64,
    };
    const events = [];
    let got = '';
    const res = await streamChat({ ...req, messages: buildMessages(req) }, (delta) => {
      if (delta.type === 'tool') events.push(delta);
      if (delta.type === 'text') got += delta.text;
    });
    if (events.length > 0) throw new Error('Chat 模式不应产生工具调用');
    if (!got) throw new Error('Chat 模式无输出');
    console.log(`[smoke] chat-mode OK: no tools, reply=${JSON.stringify(got.slice(0, 40))}, usage=${res.usage ? res.usage.total_tokens : '-'}`);
  }

  // 5. MCP 管理器链路测试（注入内存工具，验证命名空间/合并/调用转发）
  {
    const fakeClient = {
      callTool: async ({ name, arguments: a }) => ({ content: [{ type: 'text', text: `echo:${JSON.stringify(a)}` }] }),
    };
    mcpClients.set('smoke-mem', {
      client: fakeClient,
      transport: null,
      tools: new Map([['echo', {
        name: 'echo',
        description: 'Echo 测试工具',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      }]]),
      trusted: true,
      cfg: {},
      error: null,
    });
    const defs = buildToolsDefinitions();
    const mcpDef = defs.find((d) => d.function.name === 'mcp__smoke-mem__echo');
    if (!mcpDef) throw new Error('MCP 工具未合并进工具定义');
    const res = await callMcpTool('mcp__smoke-mem__echo', { message: 'hello' });
    if (!res.content || !String(res.content).includes('hello')) {
      throw new Error(`MCP 调用转发失败: ${JSON.stringify(res)}`);
    }
    console.log(`[smoke] mcp-manager OK: merged=${mcpDef.function.name}, call=${JSON.stringify(res.content).slice(0, 50)}`);
    mcpClients.delete('smoke-mem');
  }

  // 7. 会话数据诊断（排查会话列表丢失）
  {
    const diag = await win.webContents.executeJavaScript(`(() => {
      const raw = localStorage.getItem('ds-sessions');
      if (raw === null) return { found: false, reason: 'key missing' };
      if (raw === '') return { found: false, reason: 'empty string' };
      try {
        const arr = JSON.parse(raw);
        return { found: true, ok: true, count: arr.length, titles: arr.slice(0, 6).map(s => (s.title || '(untitled)').slice(0, 24)) };
      } catch (e) {
        return { found: true, ok: false, err: e.message, len: raw.length, head: raw.slice(0, 150) };
      }
    })()`);
    console.log(`[smoke] sessions-diag: ${JSON.stringify(diag)}`);
  }

  // 6. MCP 按钮链路：模拟点击「测试连接」（命令故意不存在，应快速失败并给出弹窗内反馈）
  {
    const npxResolved = resolveInPath('npx');
    console.log(`[smoke] PATH-check: npx=${npxResolved || 'NOT FOUND'}`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('mcp-name').value = 'fail-test';
      document.getElementById('mcp-command').value = 'node /definitely/not/exist-mcp-server.js';
      document.getElementById('btn-mcp-test').click();
      await new Promise((r) => setTimeout(r, 5000));
      const msg = document.getElementById('mcp-msg');
      return { msg: msg.hidden ? '' : msg.textContent, cls: msg.className };
    })()`);
    if (!result || !result.msg || !String(result.msg).includes('失败')) {
      throw new Error(`MCP 按钮链路无弹窗反馈: ${JSON.stringify(result)}`);
    }
    console.log(`[smoke] mcp-button OK: ${JSON.stringify(result.msg.slice(0, 60))}`);
  }
}

/* ================= 窗口 ================= */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    title: 'DeepSeek Desktop',
    backgroundColor: '#0d0d0d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const openExternalHttps = (rawUrl) => {
    try {
      const u = new URL(rawUrl);
      if (u.protocol === 'https:') shell.openExternal(u.href);
    } catch {}
  };
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl === APP_PAGE_URL) return;
    event.preventDefault();
    openExternalHttps(targetUrl);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

app.whenReady().then(() => {
  settings = loadSettings();
  let settingsMigrated = false;
  if (typeof settings.apiKey === 'string') {
    const legacyKey = settings.apiKey;
    storeApiKey(settings, legacyKey);
    settingsMigrated = true;
  }
  if (Array.isArray(settings.allowedCommands)) {
    const exactOnly = settings.allowedCommands.filter((cmd) => /\s/.test(String(cmd).trim()));
    if (exactOnly.length !== settings.allowedCommands.length) {
      settings.allowedCommands = exactOnly;
      settingsMigrated = true;
    }
  }
  if (settingsMigrated) saveSettings({});
  logApp('info', `started v${app.getVersion()} userData=${app.getPath('userData')} net=native-http`);
  // 强制直连：系统代理可能指向未运行的代理进程（如 clash 关闭），会导致 API 请求全部失败
  try {
    const { session } = require('electron');
    session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[net] proxy set to direct');
  } catch (e) {
    console.error('[net] setProxy failed:', e.message);
  }
  const win = createWindow();
  registerGlobalShortcut();
  initMcpServers();
  if (SMOKE_TEST) {
    win.webContents.once('did-finish-load', () => runSmokeTest(win));
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  disconnectAllMcp();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
