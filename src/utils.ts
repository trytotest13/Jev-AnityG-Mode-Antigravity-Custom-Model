import {
  app,
  BrowserWindow,
  type BrowserWindowInstance,
  nativeTheme,
  nativeImage,
  powerSaveBlocker,
  shell,
} from 'electron';
import { WINDOW_ORIGIN } from './constants';
import { registerKeybindings } from './keybindings';
import * as path from 'path';
import * as fs from 'fs';
import { getSettingsPbPath } from './paths';
import { attachLoadingOverlay } from './loadingOverlay';

export let showQuitConfirmation = false;

export function setShowQuitConfirmation(value: boolean): void {
  showQuitConfirmation = value;
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Reads the user's theme preference from the settings file.
 */
function getThemeMode(): string {
  try {
    const filePath = getSettingsPbPath();
    if (!fs.existsSync(filePath)) {
      return 'DARK';
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content) as Record<string, unknown>;
    const themeMode = (config?.userSettings as Record<string, unknown>)?.themeMode as string | undefined;
    if (themeMode && themeMode.includes('INHERIT')) {
      return nativeTheme.shouldUseDarkColors ? 'DARK' : 'LIGHT';
    }
    if (themeMode && themeMode.includes('LIGHT')) {
      return 'LIGHT';
    }
    return 'DARK';
  } catch (e) {
    console.error('Error reading theme mode:', e);
    return 'DARK';
  }
}

/**
 * Ensures the app is visible in the dock for MacOS with the icon set.
 * When refocusing the app after being hidden in the dock, the icon is sometimes lost.
 * This ensures the icon is always visible.
 */
function ensureAppIsInDock(): void {
  void app.dock?.show();
  if (isMacOS() && app.dock) {
    const iconPath = path.join(__dirname, '..', 'icon.png');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
}

// ---------------------------------------------------------------------------
// Window Management
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new BrowserWindow pointed at `url`.
 * Uses a hidden title bar with native traffic lights on macOS.
 * Node integration is disabled and context isolation is enabled for security.
 */
export function createWindow(url: string): BrowserWindowInstance {
  ensureAppIsInDock();
  const theme = getThemeMode().toUpperCase();
  const isLight = theme.includes('LIGHT');
  const backgroundColor = isLight ? '#FAFAFA' : '#131313';
  const foregroundColor = isLight ? '#383A42' : '#FAFAFA';
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: app.getName(),
    icon: path.join(__dirname, '..', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: isMacOS()
      ? false
      : {
          color: backgroundColor,
          symbolColor: foregroundColor,
          height: 30,
        },
    backgroundColor,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });
  attachLoadingOverlay(win, foregroundColor, backgroundColor);
  registerKeybindings(win, {
    createNewWindow: () => {
      void createWindow(url);
    },
    onQuitRequested: () => {
      showQuitConfirmation = true;
      app.quit();
    },
  });
  void win.loadURL(url);
  return win;
}

/**
 * Focuses a window if it exists, or creates a new one.
 */
export const showOrCreateWindow = (port: number): void => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    wins[0].show();
    wins[0].focus();
  } else {
    createWindow(`${WINDOW_ORIGIN}:${port}/`);
  }
};

/**
 * Keeps the computer awake while `keep` is true (power save blocker).
 */
let awakeBlockerId: number | null = null;

export function setKeepComputerAwake(keep: boolean | undefined): void {
  if (keep) {
    if (awakeBlockerId === null) {
      awakeBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      console.log('Power save blocker started:', awakeBlockerId);
    }
  } else if (awakeBlockerId !== null) {
    powerSaveBlocker.stop(awakeBlockerId);
    console.log('Power save blocker stopped:', awakeBlockerId);
    awakeBlockerId = null;
  }
}

/**
 * Sets up a wrapper script for Node.js that runs Electron as Node.
 * This allows running standard Node scripts using the Electron binary.
 */
export function setupNodeWrapper(env: Record<string, string | undefined>): void {
  // Windows environment variables are case-insensitive, but when copying process.env
  // into a plain object, we might get 'Path' instead of 'PATH'. We need to find
  // the actual key used to avoid creating case-duplicate keys (e.g. 'Path' and 'PATH')
  // which can confuse child_process.spawn on Windows.
  const isWindows = process.platform === 'win32';
  const pathKey = isWindows ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH' : 'PATH';
  const envPath = env[pathKey] || '';
  // ponytail: two-branch path setup inline (dev .bin vs packaged userData/bin);
  // re-extract getNodeWrapperPaths if a third mode appears.
  let nodeWrapperPath: string | undefined;
  let binPath: string | undefined;
  if (!app.isPackaged) {
    env[pathKey] = `${path.join(__dirname, '..', 'node_modules', '.bin')}${path.delimiter}${envPath}`;
  } else {
    binPath = path.join(app.getPath('userData'), 'bin');
    nodeWrapperPath = path.join(binPath, process.platform === 'win32' ? 'agy-node.cmd' : 'agy-node');
    env[pathKey] = `${binPath}${path.delimiter}${envPath}`;
  }
  // In non-packaged dev mode, we don't create a wrapper and it'll just use machine node
  if (!nodeWrapperPath || !binPath) {
    return;
  }
  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binPath, { recursive: true });
  }
  let nodeWrapperContent = '';
  switch (process.platform) {
    case 'win32':
      nodeWrapperContent = `@echo off\nset ELECTRON_RUN_AS_NODE=1\n"${process.execPath}" %*\n`;
      break;
    case 'darwin': {
      // Use the Helper app instead of the main executable to prevent macOS
      // from bouncing a new Dock icon when this script is executed. The Helper
      // has LSUIElement=true in its Info.plist, running it invisibly.
      const appName = path.basename(process.execPath);
      let electronBinary = process.execPath;
      const helperPath = path.join(
        path.dirname(process.execPath),
        '..',
        'Frameworks',
        `${appName} Helper.app`,
        'Contents',
        'MacOS',
        `${appName} Helper`,
      );
      if (fs.existsSync(helperPath)) {
        electronBinary = helperPath;
      }
      nodeWrapperContent = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electronBinary}" "$@"\n`;
      break;
    }
    default: // linux, etc.
      nodeWrapperContent = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`;
      break;
  }
  try {
    const existingContent = fs.existsSync(nodeWrapperPath) ? fs.readFileSync(nodeWrapperPath, 'utf-8') : '';
    if (existingContent !== nodeWrapperContent) {
      fs.writeFileSync(nodeWrapperPath, nodeWrapperContent);
      if (process.platform !== 'win32') {
        fs.chmodSync(nodeWrapperPath, 0o755);
      }
    }
  } catch (err) {
    console.error(`Failed to create node wrapper: ${err}`);
  }
}
