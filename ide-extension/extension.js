'use strict';
/**
 * Jev AnityG-Mode - Model Manager (IDE extension).
 *
 * Bridges the gap the new Antigravity IDE 2.5.x packaging created: the mod is an
 * external proxy, so its add-model UI (the dashboard at /dashboard) never shows up
 * inside the IDE. This extension puts a launcher where the user already looks:
 *   - status bar button "Jev AnityG-Mode Models"
 *   - command palette: "Jev AnityG-Mode: Add / Manage Custom Models (Dashboard)"
 *   - keybinding Ctrl+Alt+M
 * and keeps the proxy alive by starting it on IDE launch when it's not running.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DATA_DIR = path.join(HOME, '.gemini', 'antigravity');
const PORT_FILE = path.join(DATA_DIR, 'active_port');
const DEFAULT_PORT = '50999';

/** Absolute path of the mod folder, written by deploy-ide.ps1 / installer. */
function modDir() {
  const marker = path.join(__dirname, 'moddir.txt');
  try {
    const v = fs.readFileSync(marker, 'utf8').trim();
    return v && fs.existsSync(path.join(v, 'proxy-standalone.js')) ? v : null;
  } catch {
    return null;
  }
}

function readPort() {
  try {
    const v = fs.readFileSync(PORT_FILE, 'utf8').trim();
    return /^\d+$/.test(v) ? v : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** The proxy's base URL (port can change if 50999 is busy). */
function baseUrl() {
  return 'http://127.0.0.1:' + readPort();
}

function reachable(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url + '/api/models', { timeout: timeoutMs || 1500 }, (res) => {
      res.resume();
      resolve(!!res.statusCode && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function proxyUp() {
  const candidates = new Set([readPort(), DEFAULT_PORT]);
  for (const p of candidates) {
    if (await reachable('http://127.0.0.1:' + p)) return true;
  }
  return false;
}

/** Spawn the standalone proxy detached, logging where deploy-ide.ps1 logs. */
function startProxyProcess() {
  const dir = modDir();
  if (!dir) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(path.join(DATA_DIR, 'proxy.log'), 'a');
    const err = fs.openSync(path.join(DATA_DIR, 'proxy.err.log'), 'a');
    const child = spawn('node', ['proxy-standalone.js'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Wait until the proxy answers /api/models (re-reading active_port). */
async function waitUntilUp(ms) {
  const deadline = Date.now() + (ms || 20000);
  while (Date.now() < deadline) {
    if (await proxyUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Self-heal for the "stuck at Authenticating" problem: the IDE's
 * `jetski.cloudCodeUrl` snapshots one proxy port at deploy time, but a later
 * proxy restart can land on a different port, leaving the IDE talking to a
 * dead endpoint. Point the setting at the actually-listening proxy.
 * Only touches loopback values or a missing value - never a remote URL.
 */
async function syncCloudCodeUrl() {
  try {
    const live = baseUrl();
    if (!(await reachable(live))) return;
    const cfg = vscode.workspace.getConfiguration('jetski');
    const current = cfg.get('cloudCodeUrl');
    if (current === live) return;
    if (current && !/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?)$/i.test(String(current).trim())) return;
    await cfg.update('cloudCodeUrl', live, vscode.ConfigurationTarget.Global);
  } catch {
    /* settings section unavailable on this build - leave untouched */
  }
}

let panel = null;

function dashboardHtml(url) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               frame-src ${url} https://*.vscode-cdn.net;
               style-src ${url} https://*.vscode-cdn.net 'unsafe-inline';
               script-src https://*.vscode-cdn.net 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background, #1e1e1e); display: flex; flex-direction: column; }
  .bar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 4px 8px; box-sizing: border-box;
         background: var(--vscode-panel-background, #181818); border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .bar .url { margin-right: auto; font-family: var(--vscode-font-family); font-size: 11px; color: var(--vscode-descriptionForeground, #9ca3af);
              user-select: all; }
  .bar button { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none;
                padding: 3px 10px; cursor: pointer; font-family: var(--vscode-font-family); font-size: 12px; border-radius: 2px; }
  .bar button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  iframe { border: 0; width: 100%; flex: 1; }
</style>
</head>
<body>
  <div class="bar">
    <span class="url">${url}/dashboard</span>
    <button id="ext">Open in browser &#8599;</button>
    <button id="reload">Reload</button>
  </div>
  <iframe id="frame" src="${url}/dashboard"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"></iframe>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('ext').addEventListener('click', () => vscode.postMessage({ cmd: 'openExternal' }));
    document.getElementById('reload').addEventListener('click', () => {
      document.getElementById('frame').src = document.getElementById('frame').src;
      vscode.postMessage({ cmd: 'refresh' });
    });
  </script>
</body>
</html>`;
}

async function openDashboard() {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  let up = await waitUntilUp(2000);
  if (!up && startProxyProcess()) {
    up = await waitUntilUp(20000);
  }
  const url = baseUrl();
  if (!up) {
    const pick = await vscode.window.showErrorMessage(
      `Jev AnityG-Mode proxy is not reachable at ${url}. Run install.bat in the mod folder (or "node proxy-standalone.js" by hand), then try again.`,
      'Open in Browser Anyway'
    );
    if (pick === 'Open in Browser Anyway') {
      vscode.env.openExternal(vscode.Uri.parse(url + '/dashboard'));
    }
    refreshStatus();
    return;
  }
  // asExternalUri resolves port mapping under remote/wsl; local desktop is a no-op.
  let target = vscode.Uri.parse(url);
  try {
    target = await vscode.env.asExternalUri(target);
  } catch {
    /* keep plain url */
  }
  panel = vscode.window.createWebviewPanel(
    'jevModelsDashboard',
    'Jev AnityG-Mode: Add / Manage Models',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = dashboardHtml(target.toString().replace(/\/$/, ''));
  panel.webview.onDidReceiveMessage((m) => {
    if (m && m.cmd === 'openExternal') {
      vscode.env.openExternal(vscode.Uri.parse(url + '/dashboard'));
    }
  });
  panel.onDidDispose(() => {
    panel = null;
  });
  refreshStatus();
}

let statusItem = null;
let routeItem = null;

function setStatus(icon, tooltip, running) {
  if (!statusItem) return;
  statusItem.text = `${icon} Jev AnityG-Mode Models`;
  statusItem.tooltip = tooltip;
  statusItem.command = 'jevModels.openDashboard';
  statusItem.backgroundColor = running
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

async function refreshStatus() {
  const up = await proxyUp();
  setStatus(
    up ? '$(plug)' : '$(debug-disconnect)',
    up
      ? 'Jev AnityG-Mode proxy running. Click to add / manage custom models (Ctrl+Alt+M)'
      : 'Jev AnityG-Mode proxy is NOT running. Click to try starting it and open the dashboard',
    up
  );
}

// ── Routing status: which model ACTUALLY answered the last request ──────────
// The IDE picker keeps showing what the user selected, so the extension
// polls the proxy's routing log and surfaces the final answerer here - in
// the status bar, never inside the conversation, so the agent never sees it.

function fetchJson(urlPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl() + urlPath, { timeout: timeoutMs || 2500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function hhmmss(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Model-list change detection: offer a picker refresh ─────────────────────
// The IDE caches the model list inside its language server, so models added /
// disabled / deleted in the dashboard keep showing in the picker until the LS
// restarts and re-fetches. Force-killing the LS reads as "server crashed
// unexpectedly" to the IDE and can leave AI features down, so the refresh is
// a clean WINDOW RELOAD instead - the IDE restarts its own server properly.
// Never automatic: it would interrupt a running agent.
let lastModelsVersion = null;

function checkModelsChanged(version) {
  if (typeof version !== 'number') return;
  if (lastModelsVersion === null) {
    lastModelsVersion = version; // first poll: just baseline, no prompt
    return;
  }
  if (version === lastModelsVersion) return;
  lastModelsVersion = version;
  vscode.window
    .showInformationMessage(
      'Jev AnityG-Mode: your model list changed (add / disable / delete). Reload this window so the model picker matches? The window will reload immediately.',
      'Reload Window',
      'Later',
    )
    .then((pick) => {
      if (pick !== 'Reload Window') return;
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
}

async function refreshRouteStatus() {
  if (!routeItem) return;
  let events;
  let modelsVersion;
  try {
    const data = await fetchJson('/api/routing/recent');
    events = data.events || [];
    modelsVersion = data.modelsVersion;
  } catch {
    routeItem.hide(); // proxy briefly down - the Models item shows that
    return;
  }
  checkModelsChanged(modelsVersion);
  if (!events.length) {
    routeItem.hide();
    return;
  }
  const e = events[0];
  if (e.final === '(all failed)') {
    routeItem.text = `$(error) no model answered`;
    routeItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    routeItem.text = `$(arrow-right) ${e.final}${e.attempts.length ? ` (${e.attempts.length} sw)` : ''}`;
    routeItem.backgroundColor = undefined;
  }
  const lines = [`Last routing at ${hhmmss(e.ts)}`, `asked:    ${e.requested}`, `answered: ${e.final} (${e.isStream ? 'stream' : 'non-stream'}, ${(e.durationMs / 1000).toFixed(1)}s)`];
  if (e.attempts.length) {
    lines.push('switches:');
    for (const a of e.attempts.slice(0, 6)) lines.push(`  ${a.model}: ${a.reason}`);
    if (e.attempts.length > 6) lines.push(`  …+${e.attempts.length - 6} more`);
  }
  if (e.jev) lines.push(`JEV compaction: ~${e.jev.tokensBefore} -> ~${e.jev.tokensAfter} tokens (judge: ${e.jev.judge})`);
  lines.push('', 'Click to open the Routing Activity dashboard');
  routeItem.tooltip = lines.join('\n');
  routeItem.command = 'jevModels.openDashboard';
  routeItem.show();
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Jev AnityG-Mode Models';
  setStatus('$(sync~spin)', 'Jev AnityG-Mode: checking proxy…', true);
  statusItem.show();

  routeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  routeItem.name = 'Jev AntyG Last Routing';
  routeItem.text = '$(sync~spin) routing…';
  routeItem.command = 'jevModels.openDashboard';

  context.subscriptions.push(
    statusItem,
    routeItem,
    vscode.commands.registerCommand('jevModels.openDashboard', openDashboard),
    vscode.commands.registerCommand('jevModels.startProxy', async () => {
      if (await proxyUp()) {
        vscode.window.showInformationMessage('Jev AnityG-Mode proxy is already running at ' + baseUrl());
        return;
      }
      if (!startProxyProcess()) {
        vscode.window.showErrorMessage(
          'Could not start the Jev AnityG-Mode proxy: mod folder not found (re-run install.bat).'
        );
        return;
      }
      const up = await waitUntilUp(20000);
      if (up) vscode.window.showInformationMessage('Jev AnityG-Mode proxy started at ' + baseUrl());
      else vscode.window.showErrorMessage('Jev AnityG-Mode proxy failed to start. Check proxy.err.log in %USERPROFILE%\\.gemini\\antigravity');
      await syncCloudCodeUrl();
      refreshStatus();
    })
  );

  // Auto-start the proxy on IDE launch (survives reboots without install.bat),
  // then keep the status icons in sync and the routing info fresh.
  (async () => {
    const up = await proxyUp();
    if (!up && modDir()) {
      startProxyProcess();
      await waitUntilUp(20000);
    }
    await syncCloudCodeUrl();
    refreshStatus();
    refreshRouteStatus();
    const timer = setInterval(refreshStatus, 30000);
    const routeTimer = setInterval(refreshRouteStatus, 3000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    context.subscriptions.push({ dispose: () => clearInterval(routeTimer) });
  })();
}

module.exports = { activate };
