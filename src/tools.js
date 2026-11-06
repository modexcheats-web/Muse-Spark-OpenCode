'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_BASE64_BYTES = 32 * 1024;
const MAX_BASE64_BYTES = 128 * 1024;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 2000;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_SHELL_OUTPUT = 1024 * 1024;
const DEFAULT_GLOB_LIMIT = 200;
const MAX_GLOB_LIMIT = 2000;
const MAX_GLOB_SCAN_FILES = 10000;
const MAX_GLOB_MATCHES = 10000;
const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 500;
const MAX_GREP_FILES = 5000;
const MAX_GREP_MATCHES = 5000;
const MAX_GREP_BYTES = 20 * 1024 * 1024;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_LINE_CHARS = 500;
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'target',
  'vendor',
  '__pycache__',
]);

class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

function str(description, enumValues = []) {
  return { type: 1, description, enum_values: enumValues };
}

function num(description) {
  return { type: 2, description, enum_values: [] };
}

function command(description, required = {}, optional = {}, timeoutMs = 30000) {
  return {
    description,
    required,
    optional,
    permissions: [],
    datatype: 'application/json',
    timeout_ms: timeoutMs,
  };
}

const COMMANDS = {
  'workspace.list': command(
    "List a directory in the user's local project workspace (the real project, not your VM).",
    {},
    { path: str('Directory relative to the project root. Defaults to the root.') }
  ),
  'workspace.read': command(
    "Read a file from the user's local project workspace. Use this for every project file; your own VM workspace does not contain the project.",
    { path: str('File path relative to the project root.') },
    {
      offset: num(
        'Text mode: 1-based line to start reading from (default 1). Base64 mode: 0-based byte offset (default 0).'
      ),
      limit: num(
        'Text mode: maximum lines to return (default 200, max 2000). Base64 mode: maximum bytes to return (default 32768, max 131072).'
      ),
      encoding: str(
        'Text mode (utf8, default) or base64 for binary files. Base64 results are paginated; use next_offset to continue.',
        ['utf8', 'base64']
      ),
    }
  ),
  'workspace.write': command(
    "Create or overwrite a UTF-8 text file in the user's local project workspace.",
    {
      path: str('File path relative to the project root.'),
      content: str('Full file content to write.'),
    },
    {},
    60000
  ),
  'workspace.edit': command(
    "Replace text in a file in the user's local project workspace. Prefer this over rewriting the whole file.",
    {
      path: str('File path relative to the project root.'),
      old_string: str('Exact text to replace. Include enough surrounding context to be unique.'),
      new_string: str('Replacement text. Use an empty string to delete.'),
    },
    {
      replace_all: str('Set to "true" to replace every occurrence instead of requiring a unique match.'),
    }
  ),
  'workspace.glob': command(
    "Find files by glob pattern in the user's local project workspace. Results are paginated.",
    { pattern: str('Glob pattern such as **/*.ts or src/**/*.js.') },
    {
      path: str('Directory to search from, relative to the project root. Defaults to the root.'),
      offset: num('0-based index of the first match to return. Default 0.'),
      limit: num('Maximum matches to return. Default 200, max 2000.'),
    }
  ),
  'workspace.grep': command(
    "Search file contents in the user's local project workspace with a JavaScript regular expression. Results are paginated and report whether the scan was complete.",
    { pattern: str('JavaScript regular expression, for example TODO|FIXME.') },
    {
      include: str('Optional glob filter such as **/*.ts.'),
      path: str('Directory to search from, relative to the project root. Defaults to the root.'),
      offset: num('0-based index of the first match to return. Default 0.'),
      limit: num('Maximum matches to return. Default 100, max 500.'),
    }
  ),
  'shell.exec': command(
    "Run a shell command in the user's local project workspace and return stdout and stderr. cwd only sets the starting directory; this is NOT a sandbox and the command can access paths outside the project.",
    { command: str('Shell command to execute.') },
    {
      cwd: str('Working directory relative to the project root. Defaults to the root.'),
      timeout_ms: num('Timeout in milliseconds. Default 60000, max 300000.'),
    },
    300000
  ),
};

function normalizeRelative(input) {
  let value = String(input ?? '').trim();
  if (!value) return '.';
  if (value.startsWith('sandbox://workspace/')) {
    value = value.slice('sandbox://workspace/'.length);
  } else if (value.startsWith('sandbox://')) {
    value = value.slice('sandbox://'.length);
  }
  value = value.replace(/\\/g, '/');
  while (value.startsWith('workspace/')) value = value.slice('workspace/'.length);
  while (value.startsWith('./')) value = value.slice(2);
  return value || '.';
}

function resolveInside(root, input) {
  const relative = normalizeRelative(input);
  const absolute = path.resolve(root, relative);
  const check = path.relative(root, absolute);
  if (check === '') return { absolute, relative: '.' };
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new ToolError(
      `Path "${input}" is outside the workspace root. Use a path relative to the project root.`,
      'PATH_OUTSIDE_WORKSPACE'
    );
  }
  return { absolute, relative: check.replace(/\\/g, '/') };
}

function globToRegExp(pattern) {
  let out = '^';
  const value = String(pattern || '').replace(/\\/g, '/');
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '*') {
      if (value[i + 1] === '*') {
        i++;
        if (value[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function isProbablyBinary(buffer) {
  const end = Math.min(buffer.length, 4096);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function childEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    // Device commands run project code that may be influenced by repository
    // content. Do not hand the Muse cookie or proxy credentials to it.
    if (key.startsWith('MUSE_')) continue;
    out[key] = value;
  }
  return out;
}

async function walkFiles(start, { skipIgnored = true, limit = MAX_GREP_FILES, accept = null } = {}) {
  const files = [];
  let dirsScanned = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const dir = queue[head];
    dirsScanned++;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipIgnored && IGNORED_DIRS.has(entry.name)) continue;
        queue.push(absolute);
      } else if (entry.isFile()) {
        if (accept && !accept(absolute)) continue;
        files.push(absolute);
        if (files.length >= limit) {
          return { files, complete: false, dirsScanned };
        }
      }
    }
  }
  return { files, complete: true, dirsScanned };
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      /* fall through to child.kill */
    }
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

class LocalTools {
  constructor({ workspaceRoot, enableShell = true, logger = console } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot || process.cwd());
    this.enableShell = enableShell;
    this.logger = logger;
  }

  get commands() {
    if (this.enableShell) return COMMANDS;
    const withoutShell = { ...COMMANDS };
    delete withoutShell['shell.exec'];
    return withoutShell;
  }

  has(commandId) {
    return Object.prototype.hasOwnProperty.call(this.commands, commandId);
  }

  setWorkspaceRoot(root) {
    if (root && typeof root === 'string') this.workspaceRoot = path.resolve(root);
  }

  async execute(commandId, params = {}) {
    if (!this.has(commandId)) {
      throw new ToolError(`Unknown tool ${commandId}`, 'UNKNOWN_TOOL');
    }
    const summary = { ...params };
    for (const key of ['content', 'old_string', 'new_string']) {
      if (typeof summary[key] === 'string') {
        summary[key] = `<${Buffer.byteLength(summary[key], 'utf8')} bytes>`;
      }
    }
    this.logger.info?.(`[muse] tool ${commandId} ${JSON.stringify(summary).slice(0, 300)}`);
    switch (commandId) {
      case 'workspace.list':
        return this.#list(params);
      case 'workspace.read':
        return this.#read(params);
      case 'workspace.write':
        return this.#write(params);
      case 'workspace.edit':
        return this.#edit(params);
      case 'workspace.glob':
        return this.#glob(params);
      case 'workspace.grep':
        return this.#grep(params);
      case 'shell.exec':
        return this.#shell(params);
      default:
        throw new ToolError(`Unknown tool ${commandId}`, 'UNKNOWN_TOOL');
    }
  }

  async #list(params) {
    const target = resolveInside(this.workspaceRoot, params.path);
    const entries = await fsp.readdir(target.absolute, { withFileTypes: true });
    const items = entries
      .map((entry) => {
        if (entry.isDirectory()) return { name: entry.name, type: 'dir' };
        if (entry.isFile()) return { name: entry.name, type: 'file' };
        return { name: entry.name, type: 'other' };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return {
      path: target.relative,
      entries: items.slice(0, 500),
      truncated: items.length > 500,
    };
  }

  async #read(params) {
    const target = resolveInside(this.workspaceRoot, params.path);
    const encoding = params.encoding === 'base64' ? 'base64' : 'utf8';
    const handle = await fsp.open(target.absolute, 'r');
    let fileBytes;
    let buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ToolError(`${target.relative} is not a file`, 'NOT_A_FILE');
      fileBytes = stat.size;

      if (encoding === 'base64') {
        const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const requested = clampInt(params.limit, DEFAULT_BASE64_BYTES, 1, MAX_BASE64_BYTES);
        // Keep pages on 3-byte boundaries so concatenating the returned base64
        // strings reproduces the original bytes without per-page padding.
        const limit = Math.max(3, Math.floor(requested / 3) * 3);
        const length = Math.max(0, Math.min(limit, fileBytes - offset));
        buffer = Buffer.alloc(length);
        if (length > 0) {
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          buffer = buffer.subarray(0, bytesRead);
        }
        const nextOffset = offset + buffer.length;
        const complete = nextOffset >= fileBytes;
        return {
          path: target.relative,
          encoding: 'base64',
          content: buffer.toString('base64'),
          offset,
          limit,
          bytes: buffer.length,
          file_bytes: fileBytes,
          next_offset: complete ? null : nextOffset,
          complete,
          truncated: !complete,
          truncated_reason: complete ? null : 'page_limit',
        };
      }

      const length = Math.min(fileBytes, MAX_READ_BYTES);
      buffer = Buffer.alloc(length);
      if (length > 0) {
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        buffer = buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }

    if (isProbablyBinary(buffer)) {
      throw new ToolError(
        `${target.relative} looks like a binary file. Use encoding="base64" to read it.`,
        'BINARY_FILE'
      );
    }
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    const fileComplete = fileBytes <= MAX_READ_BYTES;
    const offset = clampInt(params.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(params.limit, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const reachedEnd = offset - 1 + slice.length >= lines.length;
    const complete = fileComplete && reachedEnd;
    return {
      path: target.relative,
      encoding: 'utf8',
      content: slice.join('\n'),
      offset,
      limit,
      total_lines: fileComplete ? lines.length : null,
      eof: complete,
      has_more: !complete,
      bytes: buffer.length,
      file_bytes: fileBytes,
      truncated: !complete,
      truncated_reason: complete ? null : fileComplete ? 'line_limit' : 'read_limit',
    };
  }

  async #write(params) {
    const target = resolveInside(this.workspaceRoot, params.path);
    const content = String(params.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new ToolError(`Content is too large (${bytes} bytes; max ${MAX_WRITE_BYTES})`, 'CONTENT_TOO_LARGE');
    }
    await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
    await fsp.writeFile(target.absolute, content, 'utf8');
    return { path: target.relative, bytes };
  }

  async #edit(params) {
    const target = resolveInside(this.workspaceRoot, params.path);
    const oldString = String(params.old_string ?? '');
    const newString = String(params.new_string ?? '');
    if (!oldString) throw new ToolError('old_string must not be empty', 'INVALID_ARGUMENT');
    const text = await fsp.readFile(target.absolute, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) {
      throw new ToolError(
        `old_string was not found in ${target.relative}. Read the file again and use the exact current text.`,
        'OLD_STRING_NOT_FOUND'
      );
    }
    const replaceAll = params.replace_all === true || params.replace_all === 'true';
    if (count > 1 && !replaceAll) {
      throw new ToolError(
        `old_string occurs ${count} times in ${target.relative}. Include more surrounding context or set replace_all="true".`,
        'OLD_STRING_NOT_UNIQUE'
      );
    }
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
    await fsp.writeFile(target.absolute, next, 'utf8');
    return { path: target.relative, replacements: replaceAll ? count : 1 };
  }

  async #glob(params) {
    const base = resolveInside(this.workspaceRoot, params.path);
    const pattern = String(params.pattern || '').trim();
    if (!pattern) throw new ToolError('pattern must not be empty', 'INVALID_ARGUMENT');
    const matcher = globToRegExp(pattern);
    const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(params.limit, DEFAULT_GLOB_LIMIT, 1, MAX_GLOB_LIMIT);
    const walk = await walkFiles(base.absolute, {
      skipIgnored: true,
      limit: MAX_GLOB_SCAN_FILES,
    });
    const matches = [];
    let matchLimitHit = false;
    for (const absolute of walk.files) {
      const relative = path.relative(this.workspaceRoot, absolute).replace(/\\/g, '/');
      const candidate =
        base.relative === '.'
          ? relative
          : path.relative(base.absolute, absolute).replace(/\\/g, '/');
      if (matcher.test(candidate) || matcher.test(relative)) {
        matches.push(relative);
        if (matches.length >= MAX_GLOB_MATCHES) {
          matchLimitHit = true;
          break;
        }
      }
    }
    matches.sort();
    const page = matches.slice(offset, offset + limit);
    const complete = walk.complete && !matchLimitHit;
    const hasMore = offset + page.length < matches.length;
    return {
      pattern,
      path: base.relative,
      matches: page,
      offset,
      limit,
      total: matches.length,
      total_is_lower_bound: !complete,
      has_more: hasMore,
      next_offset: hasMore ? offset + page.length : null,
      files_scanned: walk.files.length,
      dirs_scanned: walk.dirsScanned,
      complete,
      truncated: !complete,
      truncated_reason: complete ? null : matchLimitHit ? 'match_limit' : 'file_scan_limit',
    };
  }

  async #grep(params) {
    const base = resolveInside(this.workspaceRoot, params.path);
    const source = String(params.pattern || '');
    if (!source) throw new ToolError('pattern must not be empty', 'INVALID_ARGUMENT');
    let matcher;
    try {
      matcher = new RegExp(source);
    } catch (e) {
      throw new ToolError(`Invalid regular expression: ${e.message}`, 'INVALID_REGEX');
    }
    const include = params.include ? globToRegExp(params.include) : null;
    const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(params.limit, DEFAULT_GREP_LIMIT, 1, MAX_GREP_LIMIT);
    const relativeTo = (absolute) => path.relative(this.workspaceRoot, absolute).replace(/\\/g, '/');
    const includeMatch = (absolute) => {
      if (!include) return true;
      const relative = relativeTo(absolute);
      const candidate =
        base.relative === '.' ? relative : path.relative(base.absolute, absolute).replace(/\\/g, '/');
      return include.test(candidate) || include.test(relative);
    };
    const walk = await walkFiles(base.absolute, {
      skipIgnored: true,
      limit: MAX_GREP_FILES,
      accept: include ? includeMatch : null,
    });
    const matches = [];
    let filesScanned = 0;
    let filesRead = 0;
    let filesSkippedLarge = 0;
    let filesSkippedBinary = 0;
    let filesUnreadable = 0;
    let bytesScanned = 0;
    let matchLimitHit = false;
    let byteLimitHit = false;

    for (const absolute of walk.files) {
      const relative = relativeTo(absolute);
      filesScanned++;
      let handle;
      try {
        handle = await fsp.open(absolute, 'r');
      } catch {
        filesUnreadable++;
        continue;
      }
      let buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        if (stat.size > MAX_GREP_FILE_BYTES) {
          filesSkippedLarge++;
          continue;
        }
        if (bytesScanned + stat.size > MAX_GREP_BYTES) {
          byteLimitHit = true;
          break;
        }
        buffer = Buffer.alloc(stat.size);
        if (stat.size > 0) {
          const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
          buffer = buffer.subarray(0, bytesRead);
        }
      } catch {
        filesUnreadable++;
        continue;
      } finally {
        await handle.close();
      }
      filesRead++;
      bytesScanned += buffer.length;
      if (isProbablyBinary(buffer)) {
        filesSkippedBinary++;
        continue;
      }
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i])) continue;
        const line = lines[i];
        const textTruncated = line.length > MAX_GREP_LINE_CHARS;
        matches.push({
          file: relative,
          line: i + 1,
          text: textTruncated ? line.slice(0, MAX_GREP_LINE_CHARS) : line,
          ...(textTruncated ? { text_truncated: true } : {}),
        });
        if (matches.length >= MAX_GREP_MATCHES) {
          matchLimitHit = true;
          break;
        }
      }
      if (matchLimitHit) break;
    }

    matches.sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
    );
    const page = matches.slice(offset, offset + limit);
    const reasons = [];
    if (!walk.complete) reasons.push('file_scan_limit');
    if (matchLimitHit) reasons.push('match_limit');
    if (byteLimitHit) reasons.push('byte_limit');
    if (filesSkippedLarge > 0) reasons.push('file_size_limit');
    if (filesUnreadable > 0) reasons.push('file_read_error');
    const complete = reasons.length === 0;
    const hasMore = offset + page.length < matches.length;
    return {
      pattern: source,
      path: base.relative,
      include: params.include || null,
      matches: page,
      offset,
      limit,
      total_matches: matches.length,
      total_matches_is_lower_bound: !complete,
      files_matched: new Set(matches.map((match) => match.file)).size,
      has_more: hasMore,
      next_offset: hasMore ? offset + page.length : null,
      files_scanned: filesScanned,
      files_read: filesRead,
      files_skipped_large: filesSkippedLarge,
      files_skipped_binary: filesSkippedBinary,
      files_unreadable: filesUnreadable,
      bytes_scanned: bytesScanned,
      complete,
      truncated: !complete,
      truncated_reason: reasons[0] || null,
      truncated_reasons: reasons,
    };
  }

  async #shell(params) {
    if (!this.enableShell) {
      throw new ToolError('shell.exec is disabled (MUSE_ENABLE_SHELL=false)', 'SHELL_DISABLED');
    }
    const commandText = String(params.command || '').trim();
    if (!commandText) throw new ToolError('command must not be empty', 'INVALID_ARGUMENT');
    const cwd = resolveInside(this.workspaceRoot, params.cwd);
    const requestedTimeout = Number(params.timeout_ms) || 60000;
    const timeoutMs = Math.min(300000, Math.max(1000, requestedTimeout));
    return new Promise((resolve, reject) => {
      const child = spawn(commandText, {
        shell: true,
        cwd: cwd.absolute,
        env: childEnv(process.env),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        if (stdoutBytes >= MAX_SHELL_OUTPUT) return;
        stdoutBytes += chunk.length;
        stdout += chunk.toString('utf8');
        if (stdoutBytes > MAX_SHELL_OUTPUT) {
          stdout = stdout.slice(0, MAX_SHELL_OUTPUT);
          truncated = true;
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderrBytes >= MAX_SHELL_OUTPUT) return;
        stderrBytes += chunk.length;
        stderr += chunk.toString('utf8');
        if (stderrBytes > MAX_SHELL_OUTPUT) {
          stderr = stderr.slice(0, MAX_SHELL_OUTPUT);
          truncated = true;
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ToolError(`Could not run command: ${e.message}`, 'SHELL_SPAWN_FAILED'));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          command: commandText,
          cwd: cwd.relative,
          sandboxed: false,
          exit_code: code,
          signal,
          timed_out: timedOut,
          stdout,
          stderr,
          truncated,
        });
      });
    });
  }
}

module.exports = { LocalTools, ToolError, COMMANDS };
