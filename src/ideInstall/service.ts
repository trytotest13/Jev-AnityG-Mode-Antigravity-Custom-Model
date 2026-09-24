/**
 * IDE Install Service - Download, extract, copy, and launch logic.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log/main';
import { fetchIdeDownloadUrl, getPlatformKey, getIdeInstallPath } from './constants';
import { IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR } from '../paths';

// ─── Download ──────────────────────────────────────────────────────────────

export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const totalBytes = Number(res.headers.get('content-length') || '0');
  let downloadedBytes = 0;
  await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
  const fileStream = fs.createWriteStream(destPath);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Empty response body');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    downloadedBytes += value.length;
    if (totalBytes > 0 && onProgress) onProgress(Math.round((downloadedBytes / totalBytes) * 100));
    if (!fileStream.write(value)) await new Promise((r) => fileStream.once('drain', r));
  }
  fileStream.end();
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
}

// ─── Extract ───────────────────────────────────────────────────────────────

export async function extractIde(archivePath: string, installPath: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  if (!fs.existsSync(path.dirname(installPath))) {
    await fsPromises.mkdir(path.dirname(installPath), { recursive: true });
  }

  switch (process.platform) {
    case 'darwin': {
      const tempDir = path.join(os.tmpdir(), 'antigravity-ide-extract');
      if (fs.existsSync(tempDir)) {
        await execFileAsync('rm', ['-rf', tempDir]);
      }
      await fsPromises.mkdir(tempDir, { recursive: true });
      await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', tempDir]);
      const entries = await fsPromises.readdir(tempDir);
      const appBundle = entries.find((e) => e.endsWith('.app'));
      if (!appBundle) {
        throw new Error('No .app bundle found in the downloaded archive');
      }
      if (fs.existsSync(installPath)) {
        await execFileAsync('rm', ['-rf', installPath]);
      }
      await execFileAsync('mv', [path.join(tempDir, appBundle), installPath]);
      if (fs.existsSync(tempDir)) {
        await execFileAsync('rm', ['-rf', tempDir]);
      }
      break;
    }
    case 'linux': {
      if (!fs.existsSync(installPath)) {
        await fsPromises.mkdir(installPath, { recursive: true });
      }
      await execFileAsync('tar', ['-xzf', archivePath, '-C', installPath, '--strip-components=1']);
      break;
    }
    case 'win32': {
      await execFileAsync(archivePath, ['/VERYSILENT', '/MERGETASKS=!runcode']);
      break;
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// ─── Copy User Data ────────────────────────────────────────────────────────

export async function copyUserData(sourcePath: string, destPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) {
    log.warn(`[IDE Wizard] Source path does not exist: ${sourcePath}`);
    return;
  }
  await fsPromises.cp(sourcePath, destPath, { recursive: true, force: true });
  log.info(`[IDE Wizard] Copied user data: ${sourcePath} → ${destPath}`);
}

// ─── Download & Install (orchestrator) ─────────────────────────────────────

export async function downloadAndInstallIde(): Promise<void> {
  const platformKey = getPlatformKey();
  const downloadUrl = await fetchIdeDownloadUrl(platformKey);
  const ext = process.platform === 'win32' ? '.exe' : process.platform === 'linux' ? '.tar.gz' : '.zip';
  const tempFile = path.join(os.tmpdir(), `antigravity-ide-download${ext}`);
  log.info(`[IDE Wizard] Downloading IDE from ${downloadUrl}…`);
  await downloadFile(downloadUrl, tempFile);
  const installPath = getIdeInstallPath();
  log.info(`[IDE Wizard] Installing IDE to ${installPath}…`);
  await extractIde(tempFile, installPath);
  log.info(`[IDE Wizard] Copying user data…`);
  await copyUserData(IDE_OLD_DATA_DIR, IDE_NEW_DATA_DIR);
  try {
    await fsPromises.unlink(tempFile);
  } catch {
    /* ignore */
  }
}
