// Jev AnityG-Mode standalone proxy launcher (new "Antigravity IDE" 2.5.x, no Electron).
// The new IDE reads its Cloud Code endpoint from the `jetski.cloudCodeUrl`
// setting and passes it to the language server via --cloud_code_endpoint,
// so no binary patch / asar repack is needed: point the setting at this
// proxy and it intercepts v1internal:* like the old in-app proxy did.
//
// dist/proxy.js imports 'electron' (app.getPath) and 'electron-log'.
// Under plain Node we shim both via Module._load before requiring it.
//
// Lifecycle: the proxy runs only while the Antigravity IDE runs. A watchdog
// polls for an IDE process every few seconds and stops the proxy when the IDE
// closes (or never appears). The IDE extension auto-starts the proxy on IDE
// launch. Set JEV_STANDALONE=1 to disable the watchdog (manual debugging).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const home = os.homedir();

// Optional file logging: deploy-ide.ps1 sets JEV_PROXY_LOG. The proxy is
// started with its own hidden console (no -RedirectStandard* flags, which
// would tie it to the installer terminal and kill it when that window closes),
// so log lines are appended to the file from inside node instead.
const logFile = process.env.JEV_PROXY_LOG;
if (logFile) {
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      try {
        fs.appendFileSync(
          logFile,
          a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
        );
      } catch {
        /* log file not writable - keep console output */
      }
      orig(...a);
    };
  }
}

const electronStub = {
  app: {
    isPackaged: true,
    getPath: (name) => {
      if (name === 'home') return home;
      if (name === 'userData') return path.join(home, '.gemini', 'antigravity');
      if (name === 'logs') return path.join(home, '.gemini', 'antigravity', 'logs');
      return home;
    },
  },
  // cryptoStore only uses safeStorage; report unavailable -> base64 fallback.
  safeStorage: { isEncryptionAvailable: () => false },
};
const logStub = {
  info: (...a) => console.log('[proxy]', ...a),
  warn: (...a) => console.warn('[proxy]', ...a),
  error: (...a) => console.error('[proxy]', ...a),
  debug: (...a) => console.debug('[proxy]', ...a),
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-log' || request === 'electron-log/main')
    return { __esModule: true, default: logStub, ...logStub };
  return origLoad.call(this, request, ...rest);
};

const proxy = require('./dist/proxy.js');

function writePortFile(port) {
  try {
    const dir = path.join(home, '.gemini', 'antigravity');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'active_port'), String(port));
  } catch (e) {
    console.error('[proxy] could not write active_port file:', e.message);
  }
}

// ---- IDE watchdog -----------------------------------------------------------
// JEV_IDE_PROCESSES overrides the watched image names (comma-separated);
// used for testing the self-exit path without touching the real IDE.
const IDE_IMAGES = (process.env.JEV_IDE_PROCESSES || 'Antigravity IDE.exe,Antigravity.exe')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WATCH_INTERVAL_MS = 5000;
// The installer starts the proxy before the IDE, so allow some startup time
// before giving up when no IDE process has ever been seen.
const INITIAL_GRACE_MS = Number(process.env.JEV_WATCH_INITIAL_MS) || 120000;
// Linger briefly after the IDE closes so quick IDE restarts don't kill it.
const AFTER_GRACE_MS = Number(process.env.JEV_WATCH_AFTER_MS) || 60000;

// Returns true (IDE seen), false (tasklist ran cleanly and did NOT see it)
// or 'unknown' (tasklist itself failed/timed out). Killing the proxy because
// tasklist hiccuped mid-session made the IDE's in-flight requests die with
// "Agent execution terminated" - an unknown must count as "keep running".
function isIdeProcess(image) {
  return new Promise((resolve) => {
    cp.execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('unknown');
        // Match rows are CSV like "Antigravity IDE.exe","1234",...
        resolve(
          !!stdout && stdout.toLowerCase().includes('"' + image.toLowerCase() + '"') ? true : false,
        );
      },
    );
  });
}

function ideRunning() {
  return Promise.all(IDE_IMAGES.map(isIdeProcess)).then((hits) => {
    if (hits.some((h) => h === true)) return true;
    if (hits.some((h) => h === 'unknown')) return 'unknown';
    return false;
  });
}

function shutdown(reason) {
  console.log('[proxy] ' + reason + ' - stopping proxy');
  try {
    proxy.stopProxy();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 500);
}

function startIdeWatchdog() {
  if (process.env.JEV_STANDALONE === '1') {
    console.log('[proxy] JEV_STANDALONE=1 - IDE watchdog disabled');
    return;
  }
  if (process.platform !== 'win32') return; // deploy-ide.ps1 flow is Windows-only
  let seenIde = false;
  let checking = false;
  const startedAt = Date.now();
  let missedMs = 0;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (await ideRunning()) {
        seenIde = true;
        missedMs = 0;
        return;
      }
      if (!seenIde) {
        if (Date.now() - startedAt >= INITIAL_GRACE_MS) {
          clearInterval(timer);
          shutdown('no Antigravity IDE appeared');
        }
        return;
      }
      missedMs += WATCH_INTERVAL_MS;
      if (missedMs >= AFTER_GRACE_MS) {
        clearInterval(timer);
        shutdown('Antigravity IDE is not running');
      }
    } finally {
      checking = false;
    }
  }, WATCH_INTERVAL_MS);
  console.log(
    '[proxy] IDE watchdog on - proxy stops ' +
      Math.round(AFTER_GRACE_MS / 1000) +
      's after the IDE closes'
  );
}

proxy
  .startProxy()
  .then((port) => {
    console.log(`[proxy] listening on http://127.0.0.1:${port} (set jetski.cloudCodeUrl to this)`);
    writePortFile(port);
    startIdeWatchdog();
  })
  .catch((e) => {
    console.error('[proxy] failed to start:', e);
    process.exit(1);
  });

process.on('SIGINT', () => proxy.stopProxy().then(() => process.exit(0)));
process.on('SIGTERM', () => proxy.stopProxy().then(() => process.exit(0)));
