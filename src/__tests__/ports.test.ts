import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => name,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../cryptoStore', () => ({
  encryptModels: (m: unknown[]) => m,
  decryptModels: (m: unknown[]) => m,
  backupFile: () => {},
  encryptString: (s: string) => s,
  decryptString: (s: string) => s,
}));

import { resolvePortCandidates, DEFAULT_PROXY_PORT } from '../proxy';

describe('resolvePortCandidates', () => {
  it('prefers the last-known-good port so jetski.cloudCodeUrl stays valid', () => {
    expect(resolvePortCandidates(51234)).toEqual([51234, DEFAULT_PROXY_PORT, 0]);
  });

  it('falls back to default then dynamic when nothing was saved', () => {
    expect(resolvePortCandidates(undefined)).toEqual([DEFAULT_PROXY_PORT, 0]);
  });

  it('does not duplicate the default port', () => {
    expect(resolvePortCandidates(DEFAULT_PROXY_PORT)).toEqual([DEFAULT_PROXY_PORT, 0]);
  });

  it('ignores invalid saved ports', () => {
    for (const bad of [0, -1, 99999, NaN]) {
      expect(resolvePortCandidates(bad)).toEqual([DEFAULT_PROXY_PORT, 0]);
    }
  });
});
