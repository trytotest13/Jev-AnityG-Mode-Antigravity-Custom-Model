/**
 * Shared translator utility functions.
 * Extracted from proxy.js to avoid duplication across translator modules.
 */

import * as path from 'path';
import log from 'electron-log';
import { modelToolCallIds, translatedToolCalls, stateTimestamps, touchStateTimestamp } from '../shared';

// ─── Types ────────────────────────────────────────────────────────────────

export interface GeminiParameterProperties {
  type?: string;
  properties?: GeminiParameterProperties;
  items?: GeminiParameterProperties;
  [key: string]: unknown;
}

export interface ToolCallArgs {
  CommandLine?: string;
  Cwd?: string;
  [key: string]: unknown;
}

export interface TranslatedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd?: string;
}

export interface MatchResult {
  Filename: string;
  LineNumber: number;
  LineContent: string;
}

export interface DirectoryItem {
  name: string;
  isDir: boolean;
  sizeBytes?: number;
}

export interface FileListResponse {
  files?: DirectoryItem[];
  children?: DirectoryItem[];
  content?: string;
  CodeContent?: string;
}

export type ToolResponse = string | DirectoryItem[] | MatchResult[] | FileListResponse;

// ─── Tool Parameter Normalization ──────────────────────────────────────────
// One alias->canonical map: key is "<tool>.<alias>", value is the canonical
// PascalCase key. Covers primary aliases and "<tool>.<subkey>" entries alike.

const TOOL_PRIMARY: Record<string, string> = {
  view_file: 'AbsolutePath',
  list_dir: 'DirectoryPath',
  grep_search: 'Query',
  replace_file_content: 'TargetFile',
  write_file: 'AbsolutePath',
  run_command: 'CommandLine',
  read_file: 'AbsolutePath',
  search_files: 'SearchPath',
  create_directory: 'DirectoryPath',
  delete_file: 'AbsolutePath',
  move_file: 'SourcePath',
};

const TOOL_ALIAS: Map<string, string> = new Map(
  (
    [
      [
        'view_file',
        'AbsolutePath',
        [
          'absolute_path',
          'absolutePath',
          'path',
          'file_path',
          'filePath',
          'file',
          'filename',
          'FilePath',
          'FileName',
          'target',
          'source',
          'input',
          'uri',
        ],
      ],
      [
        'list_dir',
        'DirectoryPath',
        [
          'directory_path',
          'directoryPath',
          'path',
          'dir_path',
          'dirPath',
          'dir',
          'directory',
          'folder',
          'FolderPath',
          'folder_path',
          'target',
          'root',
          'base',
        ],
      ],
      [
        'grep_search',
        'Query',
        [
          'query',
          'search',
          'SearchQuery',
          'search_query',
          'searchQuery',
          'pattern',
          'Pattern',
          'regex',
          'Regex',
          'term',
          'keyword',
          'text',
          'needle',
        ],
      ],
      [
        'grep_search',
        'SearchPath',
        [
          'search_path',
          'searchPath',
          'path',
          'directory',
          'DirectoryPath',
          'directory_path',
          'folder',
          'dir',
          'root',
          'base',
        ],
      ],
      [
        'replace_file_content',
        'TargetFile',
        [
          'target_file',
          'targetFile',
          'file',
          'AbsolutePath',
          'absolute_path',
          'filePath',
          'file_path',
          'path',
          'FilePath',
          'target',
          'filename',
          'source',
        ],
      ],
      [
        'write_file',
        'AbsolutePath',
        [
          'absolute_path',
          'absolutePath',
          'path',
          'file_path',
          'filePath',
          'file',
          'filename',
          'FilePath',
          'FileName',
          'target_file',
          'targetFile',
          'target',
          'dest',
          'destination',
        ],
      ],
      [
        'run_command',
        'CommandLine',
        [
          'command_line',
          'commandLine',
          'cmd',
          'command',
          'Command',
          'Cmd',
          'shell_command',
          'shellCommand',
          'script',
          'exec',
          'execute',
        ],
      ],
      [
        'run_command',
        'Cwd',
        ['cwd', 'working_dir', 'workingDirectory', 'working_directory', 'dir', 'directory', 'path', 'folder'],
      ],
      [
        'read_file',
        'AbsolutePath',
        [
          'absolute_path',
          'absolutePath',
          'path',
          'file_path',
          'filePath',
          'file',
          'filename',
          'FilePath',
          'FileName',
          'target',
          'source',
          'input',
        ],
      ],
      [
        'search_files',
        'SearchPath',
        [
          'search_path',
          'searchPath',
          'path',
          'directory',
          'DirectoryPath',
          'directory_path',
          'folder',
          'dir',
          'root',
          'base',
        ],
      ],
      [
        'create_directory',
        'DirectoryPath',
        ['directory_path', 'directoryPath', 'path', 'dir_path', 'dirPath', 'dir', 'folder', 'target', 'name'],
      ],
      [
        'delete_file',
        'AbsolutePath',
        ['absolute_path', 'absolutePath', 'path', 'file_path', 'filePath', 'file', 'filename', 'FilePath', 'target'],
      ],
      [
        'move_file',
        'SourcePath',
        [
          'source_path',
          'sourcePath',
          'source',
          'from',
          'src',
          'path',
          'file_path',
          'filePath',
          'AbsolutePath',
          'absolute_path',
        ],
      ],
      [
        'move_file',
        'DestinationPath',
        ['destination_path', 'destinationPath', 'dest', 'destination', 'to', 'dst', 'target'],
      ],
    ] as [string, string, string[]][]
  ).flatMap(([tool, canonical, aliases]) => [
    [`${tool}.${canonical}`, canonical],
    ...aliases.map((a): [string, string] => [`${tool}.${a}`, canonical]),
  ]),
);

const UNIVERSAL_ALIAS: Record<string, string> = {
  path: 'AbsolutePath',
  file_path: 'AbsolutePath',
  filePath: 'AbsolutePath',
  file: 'AbsolutePath',
  filename: 'AbsolutePath',
  target: 'AbsolutePath',
  directory_path: 'DirectoryPath',
  directoryPath: 'DirectoryPath',
  dir: 'DirectoryPath',
  directory: 'DirectoryPath',
  folder: 'DirectoryPath',
  target_file: 'TargetFile',
  targetFile: 'TargetFile',
  source: 'SourcePath',
  sourcePath: 'SourcePath',
  source_path: 'SourcePath',
  dest: 'DestinationPath',
  destination: 'DestinationPath',
};

function guessPathValue(entries: [string, unknown][]): [string, unknown] | undefined {
  return (
    entries.find(([, v]) => typeof v === 'string' && (v.includes('/') || v.includes('\\') || v.includes('.'))) ||
    entries.find(([, v]) => typeof v === 'string' && v.length > 0)
  );
}

/**
 * Normalizes parameter names from external models to match Antigravity's expected PascalCase format.
 */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!args || typeof args !== 'object') return args || {};

  const primaryKey = TOOL_PRIMARY[name];
  if (!primaryKey) return applyUniversalPathFallback(args);

  // Handle array args
  if (Array.isArray(args)) {
    if (args.length > 0 && typeof args[0] === 'string') return { [primaryKey]: args[0] };
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const usedKeys = new Set<string>();

  for (const [key, value] of Object.entries(args)) {
    const canonical = TOOL_ALIAS.get(`${name}.${key}`);
    if (canonical) {
      normalized[canonical] = value;
      usedKeys.add(key);
    } else {
      normalized[key] = value;
    }
  }

  if (!normalized[primaryKey]) {
    const unassigned = Object.entries(args).filter(([k]) => !usedKeys.has(k));
    const found = guessPathValue(unassigned) || guessPathValue(Object.entries(args));
    if (found) {
      normalized[primaryKey] = found[1];
      log.info(
        `[Utils] normalizeToolArgs fallback: "${name}" extracted ${primaryKey}=${found[1]} from key "${found[0]}"`,
      );
    } else {
      log.warn(
        `[Utils] normalizeToolArgs: "${name}" could not find value for "${primaryKey}". args=${JSON.stringify(args)}`,
      );
    }
  }

  return normalized;
}

function applyUniversalPathFallback(args: Record<string, unknown>): Record<string, unknown> {
  const result = { ...args };

  for (const [key, value] of Object.entries(args)) {
    const mappedKey = UNIVERSAL_ALIAS[key];
    if (mappedKey) {
      result[mappedKey] = value;
      delete result[key];
      return result;
    }
  }

  for (const [, value] of Object.entries(args)) {
    if (typeof value === 'string' && (value.includes('/') || value.includes('\\') || value.includes('.'))) {
      result['AbsolutePath'] = value;
      return result;
    }
  }

  return result;
}

// ─── Utility Functions ────────────────────────────────────────────────────

/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
export function fixParamTypes(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const key of Object.keys(properties)) {
    const val = properties[key];
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj.type === 'string') {
        obj.type = (obj.type as string).toLowerCase();
      }
      if (obj.properties && typeof obj.properties === 'object') {
        fixParamTypes(obj.properties as Record<string, unknown>);
      }
      if (obj.items && typeof obj.items === 'object') {
        const items = obj.items as Record<string, unknown>;
        if (typeof items.type === 'string') {
          items.type = (items.type as string).toLowerCase();
        }
        if (items.properties && typeof items.properties === 'object') {
          fixParamTypes(items.properties as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
export function translateToolCallToNative(name: string, args: ToolCallArgs): TranslatedToolCall {
  if (name !== 'run_command' || !args || !args.CommandLine) {
    return { name, args: args as Record<string, unknown> };
  }

  const cmd = args.CommandLine.trim();
  const cwd = args.Cwd || process.cwd();

  // 1. list_dir translation
  const isListDir = /^(ls|dir)(\s+[\w\-\/\.\*]+)*$/i.test(cmd);
  if (isListDir) {
    let dirPath = cwd;
    const tokens = cmd.split(/\s+/).slice(1);
    const pathToken = tokens.find((t) => !t.startsWith('-') && !t.startsWith('/'));
    if (pathToken) {
      dirPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
    }
    log.info(`[Proxy] Translating run_command "${cmd}" to list_dir on "${dirPath}"`);
    return { name: 'list_dir', args: { DirectoryPath: dirPath } };
  }

  // 2. view_file translation
  const catMatch = /^(cat|type)\s+(["']?)(.*?)\2$/i.exec(cmd);
  if (catMatch) {
    const filePath = catMatch[3].trim();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    log.info(`[Proxy] Translating run_command "${cmd}" to view_file on "${absPath}"`);
    return { name: 'view_file', args: { AbsolutePath: absPath } };
  }

  // 2b. write_file translation (echo redirect)
  const echoRedirectMatch = /^(echo|printf)\s+(.+?)\s*>\s*(.+)$/i.exec(cmd);
  if (echoRedirectMatch) {
    const content = echoRedirectMatch[2].replace(/^["']|["']$/g, '');
    const filePath = echoRedirectMatch[3].trim();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    log.info(`[Proxy] Translating run_command "${cmd}" to write_file on "${absPath}"`);
    return { name: 'write_file', args: { AbsolutePath: absPath, Content: content, Append: cmd.includes('>>') } };
  }

  // 3. grep_search translation
  if (cmd.toLowerCase().startsWith('grep') || cmd.toLowerCase().startsWith('findstr')) {
    let query = '';
    let searchPath = cwd;
    const regexQuotes = /"([^"]+)"|'([^']+)'/g;
    const quotesFound = [...cmd.matchAll(regexQuotes)];
    if (quotesFound.length > 0) {
      query = quotesFound[0][1] || quotesFound[0][2];
    } else {
      const tokens = cmd.split(/\s+/);
      query = tokens[tokens.length - 1];
    }
    const tokens = cmd.split(/\s+/);
    const pathToken = tokens.find(
      (t, idx) =>
        idx > 0 && !t.startsWith('-') && !t.startsWith('/') && !t.includes('"') && !t.includes("'") && t !== query,
    );
    if (pathToken) {
      searchPath = path.isAbsolute(pathToken) ? pathToken : path.resolve(cwd, pathToken);
    }
    if (query) {
      log.info(`[Proxy] Translating run_command "${cmd}" to grep_search (Query: "${query}", Path: "${searchPath}")`);
      return {
        name: 'grep_search',
        args: {
          Query: query,
          SearchPath: searchPath,
          CaseInsensitive: cmd.includes('-i') || cmd.toLowerCase().includes('/i'),
          IsRegex: false,
          MatchPerLine: true,
        },
      };
    }
  }

  return { name, args: args as Record<string, unknown> };
}

/**
 * Records model→call-id mapping and native translation bookkeeping shared by
 * the OpenAI and Anthropic translators (was 5 copy-pasted blocks).
 */
export function trackTranslatedToolCall(
  modelName: string,
  origName: string,
  normalizedArgs: ToolCallArgs,
  callId: string,
): TranslatedToolCall {
  const modelTCIds = modelToolCallIds.get(modelName) || {};
  modelTCIds[origName] = callId;
  modelToolCallIds.set(modelName, modelTCIds);
  touchStateTimestamp(stateTimestamps.toolCallIds, modelName);
  const translated = translateToolCallToNative(origName, normalizedArgs);
  if (translated.name !== origName) {
    translated.args = normalizeToolArgs(translated.name, translated.args);
    translatedToolCalls.set(callId, {
      originalName: origName,
      translatedName: translated.name,
      cmd: normalizedArgs.CommandLine || '',
      cwd: normalizedArgs.Cwd || '',
    });
    touchStateTimestamp(stateTimestamps.translatedCalls, callId);
  }
  return translated;
}

/**
 * Formats native file tool outputs (JSON/Array) back into standard textual command-line outputs.
 */
export function formatTranslatedResponse(translatedInfo: TranslatedCallInfo, responseData: unknown): string {
  const { translatedName, cmd } = translatedInfo;
  log.info(`[Proxy] Formatting native response back to CLI for translated tool "${translatedName}" (Cmd: "${cmd}")`);

  if (translatedName === 'list_dir') {
    if (Array.isArray(responseData)) {
      return (responseData as DirectoryItem[])
        .map((item) => {
          const typeIndicator = item.isDir ? '<DIR>' : '     ';
          const sizeStr = item.isDir ? '' : ` (${item.sizeBytes || 0} bytes)`;
          return `${typeIndicator}  ${item.name}${sizeStr}`;
        })
        .join('\n');
    }
    if (responseData && typeof responseData === 'object') {
      const data = responseData as FileListResponse;
      const items = data.files || data.children || [];
      if (Array.isArray(items)) {
        return items.map((item) => `${item.isDir ? '<DIR>' : '     '}  ${item.name}`).join('\n');
      }
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  if (translatedName === 'view_file') {
    if (responseData && typeof responseData === 'object') {
      const data = responseData as FileListResponse;
      return data.content || data.CodeContent || JSON.stringify(responseData);
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  if (translatedName === 'grep_search') {
    if (Array.isArray(responseData)) {
      return (responseData as MatchResult[])
        .map((match) => `${match.Filename}:${match.LineNumber}:${match.LineContent}`)
        .join('\n');
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  if (translatedName === 'write_file') {
    if (responseData && typeof responseData === 'object') {
      const data = responseData as Record<string, unknown>;
      if (data.success) return `File written successfully: ${data.path || 'unknown'}`;
      return `Failed to write file: ${data.error || 'Unknown error'}`;
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
  }

  return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
}
