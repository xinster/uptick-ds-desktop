'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const main = read('src/main.js');
const renderer = read('src/renderer/renderer.js');
const pkg = JSON.parse(read('package.json'));

assert(main.includes("setWindowOpenHandler"), 'external window navigation must be denied');
assert(main.includes("webContents.on('will-navigate'"), 'same-window navigation must be intercepted');
assert(main.includes('isTrustedIpcEvent'), 'IPC calls must validate their sender');
assert(!/^ipcMain\.(handle|on)\(/m.test(main), 'all application IPC must use secure wrappers');
assert(main.includes("kind: 'mcp_start'"), 'MCP process launches must require permission');
assert(main.includes('safeStorage.encryptString'), 'API keys must use OS-backed encryption');
assert(main.includes('function publicSettings()'), 'renderer settings must be redacted');
assert(!main.includes('allowList.includes(cmdName)'), 'bare executable allowlisting is unsafe');
assert(main.includes('fs.constants.O_NOFOLLOW'), 'writes must reject final-component symlinks');
assert(renderer.includes("securityLevel: 'strict'"), 'Mermaid must run in strict mode');
assert(!renderer.includes("securityLevel: 'loose'"), 'Mermaid loose mode is forbidden');
assert(!fs.existsSync(path.join(root, 'src/main.js.bak')), 'obsolete source backups must not ship');

const electronMajor = Number(String(pkg.devDependencies.electron).match(/\d+/)?.[0]);
assert(electronMajor >= 43, 'Electron must remain on the patched major version');

console.log('security checks passed');
