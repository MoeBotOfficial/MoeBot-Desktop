import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The console source is a sibling checkout of the webui repo by default; point
// MOEBOT_WEBUI_DIR at its public/ folder (or at the repo root) to build elsewhere.
const webuiDir = process.env.MOEBOT_WEBUI_DIR
  ? resolve(process.env.MOEBOT_WEBUI_DIR)
  : resolve(here, '../../qq-bot-webui-main/public');
const source = webuiDir.endsWith('public') ? webuiDir : resolve(webuiDir, 'public');
const output = resolve(here, '../dist');

const textReplacements = [
  ['连接你的机器人', '我的机器人'],
  ['Token 仅由浏览器保存，管理请求会将它发送到你填写的后端。', 'Token 仅保存在本机，管理请求会将它发送到你填写的后端。'],
  ['在此浏览器记住 Token', '在本机记住 Token'],
  ['静态前端 · 凭据保留在浏览器 · 配置保存在 Cloudflare', '桌面端 · 凭据仅保存在本机 · 配置保存在 Cloudflare'],
  ['浏览器禁止持久存储，Token 仅保留在当前页面内存。', '本机禁止持久存储，Token 仅保留在当前页面内存。'],
  ['浏览器正在校验、计算哈希并上传静态发布产物。', '本机正在校验、计算哈希并上传静态发布产物。'],
  ['上传的插件不会在浏览器中执行。', '上传的插件不会在本机执行。'],
  ['不写入程序包或浏览器持久存储。', '不写入程序包或本地持久存储。'],
  ['浏览器无法保存本地草稿。', '本机无法保存本地草稿。'],
];

const patchedFiles = ['index.html', 'app.js', 'deploy.js', 'mcp/manager.js', 'plugin-system/manager.js'];

const exposureMarker = 'window.__moebot =';

const exposure = [
  '',
  '/* desktop build only: hand the shell a handle on the app internals so the bot',
  '   switcher can read pending edits and re-render without patching upstream code. */',
  `${exposureMarker} {`,
  '  state, api, notice, normalizeBackend,',
  '  renderSnapshot, renderFields, updatePending, selectGroup, navigation,',
  '  clearEdits, busy, setEdit,',
  '  editors, plugins, mcp, onboarding, dataManager, logs,',
  '  stored, saveStored, removeStored,',
  '  STORAGE_KEY, DEPLOY_KEY,',
  '};',
  '',
].join('\n');

const retireServiceWorker = [
  '// desktop build: the service worker is retired.',
  '// This file is byte-different from the upstream worker, which forces the',
  '// browser to install it, clear every cache and unregister itself. That breaks',
  '// the deadlock where an old worker kept serving stale cached assets forever.',
  "self.addEventListener('install', () => {",
  '  self.skipWaiting();',
  '});',
  '',
  "self.addEventListener('activate', (event) => {",
  '  event.waitUntil((async () => {',
  '    try {',
  '      const keys = await caches.keys();',
  '      await Promise.all(keys.map((key) => caches.delete(key)));',
  '    } catch (error) {}',
  '    try {',
  '      await self.registration.unregister();',
  '    } catch (error) {}',
  '    try {',
  "      const clients = await self.clients.matchAll({ type: 'window' });",
  '      await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => {})));',
  '    } catch (error) {}',
  '  })());',
  '});',
  '',
].join('\n');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const applied = new Set();
for (const relative of patchedFiles) {
  const file = resolve(output, relative);
  let text = await readFile(file, 'utf8');
  for (const [from, to] of textReplacements) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
      applied.add(from);
    }
  }
  await writeFile(file, text);
}

const appFile = resolve(output, 'app.js');
let app = await readFile(appFile, 'utf8');
if (!app.includes(exposureMarker)) {
  app = `${app.replace(/\s*$/, '')}\n${exposure}`;
  await writeFile(appFile, app);
}

const pwaFile = resolve(output, 'pwa.js');
let pwa = await readFile(pwaFile, 'utf8');
const serviceWorkerGuard = "if ('serviceWorker' in navigator && window.isSecureContext) {";
if (pwa.includes(serviceWorkerGuard)) {
  pwa = pwa.replace(serviceWorkerGuard, 'if (false) {');
  await writeFile(pwaFile, pwa);
}

const cssFile = resolve(output, 'styles.css');
await writeFile(cssFile, `${await readFile(cssFile, 'utf8')}${await readFile(resolve(here, 'desktop-overrides.css'), 'utf8')}`);

await writeFile(resolve(output, 'sw.js'), retireServiceWorker);
await writeFile(resolve(output, 'desktop-shell.js'), await readFile(resolve(here, 'desktop-shell.js'), 'utf8'));
await writeFile(resolve(output, 'desktop-fetch.js'), await readFile(resolve(here, 'desktop-fetch.js'), 'utf8'));

const htmlFile = resolve(output, 'index.html');
let html = await readFile(htmlFile, 'utf8');
const shellScript = '<script src="./desktop-shell.js" defer></script>';
if (!html.includes(shellScript)) {
  html = html.replace('</body>', `  ${shellScript}\n</body>`);
}
// must run before the app.js module, so it goes in <head> without defer
const fetchScript = '<script src="./desktop-fetch.js"></script>';
if (!html.includes(fetchScript)) {
  html = html.replace('<head>', `<head>\n  ${fetchScript}`);
}
await writeFile(htmlFile, html);

const missed = textReplacements.filter(([from]) => !applied.has(from));
if (missed.length > 0) {
  console.warn('以下文案在源文件中未找到，可能已被上游修改：');
  for (const [from] of missed) console.warn(`  - ${from}`);
}

console.log(`desktop frontend written to ${output}`);
