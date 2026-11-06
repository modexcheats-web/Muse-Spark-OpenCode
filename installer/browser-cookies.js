'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const MUSE_HOST = 'muse.ai';
const REQUIRED_COOKIE = 'hatch_sess';
const MUSE_ORIGIN = 'https://muse.ai';

class BrowserCookieError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserCookieError';
    this.code = code;
    Object.assign(this, details);
  }
}

let DatabaseSync = null;
function getDatabaseSync() {
  if (DatabaseSync) return DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new BrowserCookieError(
      'node:sqlite não está disponível. Use Node.js 22.5+ (recomendado: 23+ ou 26).',
      'SQLITE_UNAVAILABLE',
      { cause: e }
    );
  }
  return DatabaseSync;
}

/**
 * Browsers whose cookie store is a Chromium SQLite database.
 * `roots` are the "User Data" directories. Some browsers (Opera) use the
 * root directory itself as the profile.
 */
const CHROMIUM_BROWSERS = [
  {
    id: 'brave',
    name: 'Brave',
    roots: [
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser-Beta', 'User Data'),
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser-Dev', 'User Data'),
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser-Nightly', 'User Data'),
    ],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    roots: [
      path.join(LOCAL, 'Google', 'Chrome', 'User Data'),
      path.join(LOCAL, 'Google', 'Chrome Beta', 'User Data'),
      path.join(LOCAL, 'Google', 'Chrome Dev', 'User Data'),
      path.join(LOCAL, 'Google', 'Chrome SxS', 'User Data'),
      path.join(LOCAL, 'Google', 'Chrome Canary', 'User Data'),
    ],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    roots: [path.join(LOCAL, 'Chromium', 'User Data')],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    roots: [
      path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'),
      path.join(LOCAL, 'Microsoft', 'Edge Beta', 'User Data'),
      path.join(LOCAL, 'Microsoft', 'Edge Dev', 'User Data'),
      path.join(LOCAL, 'Microsoft', 'Edge Canary', 'User Data'),
    ],
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    roots: [path.join(LOCAL, 'Vivaldi', 'User Data')],
  },
  {
    id: 'opera',
    name: 'Opera',
    roots: [
      path.join(ROAMING, 'Opera Software', 'Opera Stable'),
      path.join(ROAMING, 'Opera Software', 'Opera GX Stable'),
      path.join(ROAMING, 'Opera Software', 'Opera Next'),
    ],
  },
  {
    id: 'yandex',
    name: 'Yandex Browser',
    roots: [path.join(LOCAL, 'Yandex', 'YandexBrowser', 'User Data')],
  },
];

const FIREFOX_BROWSERS = [
  {
    id: 'firefox',
    name: 'Firefox',
    roots: [
      path.join(ROAMING, 'Mozilla', 'Firefox'),
      path.join(LOCAL, 'Mozilla', 'Firefox'),
    ],
  },
  {
    id: 'librewolf',
    name: 'LibreWolf',
    roots: [path.join(ROAMING, 'LibreWolf'), path.join(LOCAL, 'LibreWolf')],
  },
  {
    id: 'waterfox',
    name: 'Waterfox',
    roots: [path.join(ROAMING, 'Waterfox'), path.join(LOCAL, 'Waterfox')],
  },
  {
    id: 'zen',
    name: 'Zen Browser',
    roots: [path.join(ROAMING, 'zen'), path.join(ROAMING, 'Zen'), path.join(LOCAL, 'zen')],
  },
];

const PROCESS_NAMES = [
  'brave',
  'chrome',
  'msedge',
  'chromium',
  'vivaldi',
  'opera',
  'firefox',
  'librewolf',
  'waterfox',
  'zen',
  'yandex',
];

function isMuseHost(host) {
  if (typeof host !== 'string') return false;
  return host === MUSE_HOST || host.endsWith(`.${MUSE_HOST}`);
}

function chromiumExpires(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Chromium stores microseconds since 1601-01-01.
  const seconds = Math.floor(raw / 1_000_000 - 11_644_473_600);
  return seconds > 0 ? seconds : null;
}

function isProbablyPlainText(buf) {
  if (!buf.length) return false;
  for (const byte of buf) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return true;
}

function dpapiUnprotect(encrypted) {
  const b64 = Buffer.from(encrypted).toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `$b = [Convert]::FromBase64String('${b64}')`,
    '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');

  const res = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }
  );
  if (res.error) {
    throw new BrowserCookieError(`não consegui executar o PowerShell: ${res.error.message}`, 'DPAPI');
  }
  if (res.status !== 0) {
    const detail = String(res.stderr || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    throw new BrowserCookieError(`DPAPI falhou: ${detail || 'erro desconhecido'}`, 'DPAPI');
  }
  const out = String(res.stdout || '').trim();
  if (!out) throw new BrowserCookieError('DPAPI retornou vazio', 'DPAPI');
  return Buffer.from(out, 'base64');
}

const masterKeyCache = new Map();

function localStatePathFor(root, profileDir) {
  const candidates = [path.join(root, 'Local State'), path.join(profileDir, 'Local State')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function masterKeyFor(root, profileDir) {
  const localStatePath = localStatePathFor(root, profileDir);
  if (!localStatePath) {
    return {
      key: null,
      appBound: false,
      reason: 'Local State não encontrado (sem a chave DPAPI do navegador)',
    };
  }

  const stat = fs.statSync(localStatePath);
  const cacheKey = `${localStatePath}:${stat.mtimeMs}`;
  if (masterKeyCache.has(cacheKey)) return masterKeyCache.get(cacheKey);

  let localState;
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (e) {
    const result = { key: null, appBound: false, reason: `Local State inválido: ${e.message}` };
    masterKeyCache.set(cacheKey, result);
    return result;
  }

  const osCrypt = localState && localState.os_crypt ? localState.os_crypt : {};
  const appBound = Boolean(osCrypt.app_bound_encrypted_key);
  if (!osCrypt.encrypted_key) {
    const result = {
      key: null,
      appBound,
      reason: appBound
        ? 'o navegador só tem App-Bound Encryption (v20); exporte os cookies manualmente'
        : 'Local State não tem os_crypt.encrypted_key',
    };
    masterKeyCache.set(cacheKey, result);
    return result;
  }

  try {
    const wrapped = Buffer.from(osCrypt.encrypted_key, 'base64');
    const payload = wrapped.subarray(0, 5).toString('ascii') === 'DPAPI'
      ? wrapped.subarray(5)
      : wrapped;
    const key = dpapiUnprotect(payload);
    const result = { key, appBound, reason: null };
    masterKeyCache.set(cacheKey, result);
    return result;
  } catch (e) {
    const result = { key: null, appBound, reason: e.message };
    masterKeyCache.set(cacheKey, result);
    return result;
  }

}

function decryptChromiumValue(encrypted, masterKey) {
  const data = Buffer.from(encrypted);
  if (!data.length) return '';
  const prefix = data.subarray(0, 3).toString('ascii');

  if (prefix === 'v20') {
    throw new BrowserCookieError(
      'o cookie usa App-Bound Encryption (v20); esse formato exige o serviço interno do navegador',
      'APP_BOUND_COOKIE'
    );
  }

  if (prefix !== 'v10' && prefix !== 'v11') {
    if (isProbablyPlainText(data)) return data.toString('utf8');
    throw new BrowserCookieError(
      `prefixo de criptografia desconhecido: ${JSON.stringify(prefix)}`,
      'UNKNOWN_PREFIX'
    );
  }

  const key = crypto.pbkdf2Sync(masterKey, 'saltysalt', 1, 32, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const payload = data.subarray(3);

  // Windows/Chromium uses AES-256-GCM for v10/v11. Older stores use CBC.
  if (payload.length > 16) {
    try {
      const tag = payload.subarray(payload.length - 16);
      const ciphertext = payload.subarray(0, payload.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      /* try CBC below */
    }
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new BrowserCookieError(
      'não consegui descriptografar o cookie (chave DPAPI de outro usuário/perfil?)',
      'DECRYPT',
      { cause: e }
    );
  }
}

function findCookieDb(profileDir) {
  const candidates = [
    path.join(profileDir, 'Network', 'Cookies'),
    path.join(profileDir, 'Cookies'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function chromiumProfileDirs(root) {
  if (findCookieDb(root)) return [{ dir: root, name: path.basename(root) }];

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => /^(Default|Profile \d+|Guest Profile|System Profile)$/.test(entry.name))
    .map((entry) => ({ dir: path.join(root, entry.name), name: entry.name }));
}

function copySqliteDatabase(dbPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-cookies-'));
  const destination = path.join(tempDir, path.basename(dbPath));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = dbPath + suffix;
      if (!fs.existsSync(source)) continue;
      try {
        fs.copyFileSync(source, destination + suffix);
      } catch (e) {
        if (['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(e.code)) {
          throw new BrowserCookieError(
            `o banco de cookies está bloqueado (${e.code}); feche o navegador e tente de novo`,
            'LOCKED',
            { cause: e }
          );
        }
        throw e;
      }
    }
    return {
      path: destination,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  } catch (e) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw e;
  }
}

function readChromiumProfile({ databasePath, masterKey, appBound = false }) {
  const Database = getDatabaseSync();
  const copy = copySqliteDatabase(databasePath);
  let db;
  try {
    db = new Database(copy.path, { readOnly: true });
    const columns = new Set(
      db.prepare('PRAGMA table_info(cookies)').all().map((row) => String(row.name))
    );
    if (!columns.has('host_key') || !columns.has('name')) {
      throw new BrowserCookieError('o banco de cookies não tem o esquema esperado', 'SCHEMA');
    }
    const selected = ['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly'];
    if (columns.has('samesite')) selected.push('samesite');
    const rows = db
      .prepare(`SELECT ${selected.join(', ')} FROM cookies WHERE host_key LIKE ?`)
      .all(`%${MUSE_HOST}`);

    const cookies = [];
    const errors = [];
    for (const row of rows) {
      if (!isMuseHost(row.host_key)) continue;
      const name = String(row.name || '');
      if (!name) continue;

      let value = row.value == null ? '' : String(row.value);
      if (!value && row.encrypted_value && row.encrypted_value.length) {
        try {
          value = decryptChromiumValue(row.encrypted_value, masterKey);
        } catch (e) {
          errors.push({ name, code: e.code || 'DECRYPT', reason: e.message });
          continue;
        }
      }
      if (!value) continue;

      cookies.push({
        name,
        value,
        domain: String(row.host_key || ''),
        path: String(row.path || '/'),
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        expires: chromiumExpires(row.expires_utc),
        ...(columns.has('samesite') && row.samesite != null ? { sameSite: row.samesite } : {}),
      });
    }

    return { cookies, errors, appBound };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    copy.cleanup();
  }
}

function firefoxProfileDirs(root) {
  const profiles = [];
  const iniPath = path.join(root, 'profiles.ini');
  if (fs.existsSync(iniPath)) {
    let section = null;
    const flush = () => {
      if (!section || !section.Path) return;
      const relative = String(section.IsRelative ?? '1') !== '0';
      profiles.push(relative ? path.join(root, section.Path) : section.Path);
    };
    for (const raw of fs.readFileSync(iniPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        flush();
        section = /^\[Profile/i.test(line) ? {} : null;
        continue;
      }
      if (!section) continue;
      const eq = line.indexOf('=');
      if (eq > 0) section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    flush();
  }

  const profilesDir = path.join(root, 'Profiles');
  if (fs.existsSync(profilesDir)) {
    try {
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) profiles.push(path.join(profilesDir, entry.name));
      }
    } catch {
      /* ignore */
    }
  }

  const seen = new Set();
  return profiles
    .map((profile) => {
      try {
        return fs.realpathSync.native(profile);
      } catch {
        return path.resolve(profile);
      }
    })
    .filter((profile) => {
      if (seen.has(profile)) return false;
      seen.add(profile);
      return fs.existsSync(path.join(profile, 'cookies.sqlite'));
    })
    .map((profile) => ({ dir: profile, name: path.basename(profile) }));
}

function readFirefoxProfile({ databasePath }) {
  const Database = getDatabaseSync();
  const copy = copySqliteDatabase(databasePath);
  let db;
  try {
    db = new Database(copy.path, { readOnly: true });
    const columns = new Set(
      db.prepare('PRAGMA table_info(moz_cookies)').all().map((row) => String(row.name))
    );
    if (!columns.has('host') || !columns.has('name')) {
      throw new BrowserCookieError('o cookies.sqlite não tem o esquema esperado', 'SCHEMA');
    }
    const selected = ['host', 'name', 'value', 'path', 'expiry', 'isSecure', 'isHttpOnly'];
    if (columns.has('sameSite')) selected.push('sameSite');
    const rows = db
      .prepare(`SELECT ${selected.join(', ')} FROM moz_cookies WHERE host LIKE ?`)
      .all(`%${MUSE_HOST}`);

    const cookies = [];
    for (const row of rows) {
      if (!isMuseHost(row.host)) continue;
      const name = String(row.name || '');
      const value = row.value == null ? '' : String(row.value);
      if (!name || !value) continue;
      cookies.push({
        name,
        value,
        domain: String(row.host || ''),
        path: String(row.path || '/'),
        secure: Boolean(row.isSecure),
        httpOnly: Boolean(row.isHttpOnly),
        expires: row.expiry ? Number(row.expiry) : null,
        ...(columns.has('sameSite') && row.sameSite != null ? { sameSite: row.sameSite } : {}),
      });
    }
    return { cookies, errors: [], appBound: false };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    copy.cleanup();
  }
}

function hasSessionCookie(cookies) {
  return cookies.some((cookie) => cookie.name === REQUIRED_COOKIE && cookie.value);
}

function candidateScore(candidate) {
  if (!candidate.hasSession) return -1;
  let score = 10;
  if (candidate.cookies.some((cookie) => cookie.name === 'hatch_gw')) score += 4;
  if (candidate.cookies.some((cookie) => cookie.name === 'hatch_vml')) score += 2;
  score += Math.min(5, candidate.cookies.length / 4);
  return score;
}

function summarizeCandidate(candidate) {
  const session = candidate.cookies.find((cookie) => cookie.name === REQUIRED_COOKIE);
  return {
    browser: candidate.browser,
    profile: candidate.profile,
    cookies: candidate.cookies.length,
    hasSession: candidate.hasSession,
    expires: session?.expires ? new Date(session.expires * 1000).toISOString() : null,
    errors: candidate.errors.length,
    locked: Boolean(candidate.locked),
  };
}

/**
 * Scans every known browser profile and returns the Muse cookie jars found.
 * Locked Chromium stores are reported instead of guessed.
 */
function scanBrowsers({ logger = console } = {}) {
  const candidates = [];
  const scanned = [];
  const notes = [];

  for (const browser of CHROMIUM_BROWSERS) {
    for (const root of browser.roots) {
      if (!fs.existsSync(root)) continue;
      const profiles = chromiumProfileDirs(root);
      if (profiles.length === 0) {
        scanned.push({ browser: browser.name, profile: '(nenhum)', status: 'no-profile' });
        continue;
      }

      let keyInfo;
      try {
        keyInfo = masterKeyFor(root, profiles[0].dir);
      } catch (e) {
        keyInfo = { key: null, appBound: false, reason: e.message };
      }
      for (const profile of profiles) {
        const databasePath = findCookieDb(profile.dir);
        if (!databasePath) continue;
        const record = { browser: browser.name, profile: profile.name };
        if (!keyInfo.key) {
          scanned.push({ ...record, status: 'no-key', reason: keyInfo.reason });
          notes.push(`${browser.name} (${profile.name}): ${keyInfo.reason}`);
          continue;
        }

        try {
          const result = readChromiumProfile({
            databasePath,
            masterKey: keyInfo.key,
            appBound: keyInfo.appBound,
          });
          const candidate = {
            source: browser.id,
            browser: browser.name,
            family: 'chromium',
            profile: profile.name,
            databasePath,
            modifiedAt: fs.statSync(databasePath).mtimeMs,
            cookies: result.cookies,
            errors: result.errors,
            appBound: result.appBound,
            hasSession: hasSessionCookie(result.cookies),
            locked: false,
          };
          candidate.score = candidateScore(candidate);
          if (candidate.cookies.length > 0) candidates.push(candidate);
          scanned.push({
            ...record,
            status: candidate.cookies.length > 0 ? 'ok' : 'no-cookies',
            cookies: candidate.cookies.length,
            errors: result.errors.length,
          });
          if (result.errors.length > 0) {
            const names = [...new Set(result.errors.map((error) => error.name))].join(', ');
            notes.push(`${browser.name} (${profile.name}): não decifrei ${names}`);
            if (result.errors.some((error) => error.code === 'APP_BOUND_COOKIE')) {
              notes.push(
                `${browser.name} usa App-Bound Encryption (v20) em alguns cookies; ` +
                  'exporte esses cookies manualmente ou use um JSON/hatch_sess.'
              );
            }
          }
        } catch (e) {
          if (e.code === 'LOCKED') {
            scanned.push({ ...record, status: 'locked', reason: e.message });
            notes.push(`${browser.name} (${profile.name}): ${e.message}`);
          } else {
            scanned.push({ ...record, status: 'error', reason: e.message });
            notes.push(`${browser.name} (${profile.name}): ${e.message}`);
          }
        }
      }
    }
  }

  for (const browser of FIREFOX_BROWSERS) {
    for (const root of browser.roots) {
      if (!fs.existsSync(root)) continue;
      const profiles = firefoxProfileDirs(root);
      for (const profile of profiles) {
        const databasePath = path.join(profile.dir, 'cookies.sqlite');
        const record = { browser: browser.name, profile: profile.name };
        try {
          const result = readFirefoxProfile({ databasePath });
          const candidate = {
            source: browser.id,
            browser: browser.name,
            family: 'firefox',
            profile: profile.name,
            databasePath,
            modifiedAt: fs.statSync(databasePath).mtimeMs,
            cookies: result.cookies,
            errors: [],
            appBound: false,
            hasSession: hasSessionCookie(result.cookies),
            locked: false,
          };
          candidate.score = candidateScore(candidate);
          if (candidate.cookies.length > 0) candidates.push(candidate);
          scanned.push({
            ...record,
            status: candidate.cookies.length > 0 ? 'ok' : 'no-cookies',
            cookies: candidate.cookies.length,
          });
        } catch (e) {
          scanned.push({ ...record, status: e.code === 'LOCKED' ? 'locked' : 'error', reason: e.message });
          notes.push(`${browser.name} (${profile.name}): ${e.message}`);
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt);
  return { candidates, scanned, notes };
}

function closeBrowsers({ logger = console, timeoutMs = 10000 } = {}) {
  const nameList = PROCESS_NAMES.map((name) => `'${name}'`).join(',');
  const script = [
    `$names = @(${nameList})`,
    '$procs = Get-Process -Name $names -ErrorAction SilentlyContinue',
    '$closed = @()',
    'foreach ($p in $procs) { try { if ($p.MainWindowHandle -ne 0 -and $p.CloseMainWindow()) { $closed += $p.ProcessName } } catch {} }',
    'Start-Sleep -Milliseconds 700',
    '$remaining = Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique',
    '[pscustomobject]@{ closed = @($closed | Select-Object -Unique); remaining = @($remaining) } | ConvertTo-Json -Compress',
  ].join('; ');

  const res = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }
  );
  if (res.error) throw new BrowserCookieError(`não consegui fechar os navegadores: ${res.error.message}`, 'CLOSE');
  let parsed = null;
  try {
    parsed = JSON.parse(String(res.stdout || '').trim());
  } catch {
    /* ignore */
  }
  const closed = Array.isArray(parsed?.closed) ? parsed.closed : [];
  const remaining = Array.isArray(parsed?.remaining) ? parsed.remaining : [];
  if (closed.length) logger.log?.(`Navegadores fechados: ${[...new Set(closed)].join(', ')}`);
  if (remaining.length) {
    logger.warn?.(`Ainda abertos: ${[...new Set(remaining)].join(', ')}. Feche-os manualmente para ler os cookies.`);
  }
  return { closed, remaining };
}

function normalizeCookieJar(input) {
  let list;
  if (Array.isArray(input)) list = input;
  else if (input && Array.isArray(input.cookies)) list = input.cookies;
  else if (input && typeof input === 'object') {
    list = Object.entries(input).map(([name, value]) => ({ name, value }));
  } else {
    return [];
  }

  const cookies = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim();
    const value = item.value == null ? '' : String(item.value);
    if (!name || !value) continue;
    if (/[\r\n;]/.test(name) || /[\r\n]/.test(value)) continue;
    const key = `${item.domain || ''}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cookies.push({
      name,
      value,
      ...(item.domain ? { domain: String(item.domain) } : {}),
      ...(item.path ? { path: String(item.path) } : {}),
      ...(item.secure != null ? { secure: Boolean(item.secure) } : {}),
      ...(item.httpOnly != null ? { httpOnly: Boolean(item.httpOnly) } : {}),
      ...(item.expires != null
        ? { expires: Number(item.expires) }
        : item.expirationDate != null
          ? { expires: Number(item.expirationDate) }
          : {}),
      ...(item.sameSite != null ? { sameSite: item.sameSite } : {}),
    });
  }
  return cookies;
}

function cookiesFromHatchSess(value) {
  return normalizeCookieJar([
    {
      name: REQUIRED_COOKIE,
      value,
      domain: '.muse.ai',
      path: '/',
      secure: true,
      httpOnly: true,
    },
  ]);
}

function readCookieJarFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BrowserCookieError(`JSON de cookies inválido em ${file}: ${e.message}`, 'INVALID_JSON');
  }
  const cookies = normalizeCookieJar(parsed);
  if (cookies.length === 0) {
    throw new BrowserCookieError(`nenhum cookie utilizável em ${file}`, 'EMPTY_JAR');
  }
  return cookies;
}

function cookieHeader(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && cookie.name && cookie.value != null)
    .filter((cookie) => !cookie.domain || isMuseHost(cookie.domain))
    .filter((cookie) => !/[\r\n;]/.test(cookie.name) && !/[\r\n]/.test(String(cookie.value)))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Checks the cookie against the same HTTPS endpoint the proxy uses before
 * opening the gateway. This validates authentication without waking the VM
 * or creating a Muse thread.
 */
async function validateCookieJar(cookies, { timeoutMs = 15000 } = {}) {
  const header = cookieHeader(cookies);
  if (!header) return { ok: false, status: 0, reason: 'nenhum cookie' };
  if (!cookies.some((cookie) => cookie.name === REQUIRED_COOKIE && cookie.value)) {
    return { ok: false, status: 0, reason: `cookie ${REQUIRED_COOKIE} ausente` };
  }

  try {
    const res = await fetch(`${MUSE_ORIGIN}/api/session?vm_state=live`, {
      method: 'GET',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        accept: 'application/json, text/plain, */*',
        cookie: header,
        origin: MUSE_ORIGIN,
        referer: `${MUSE_ORIGIN}/`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* HTML or plain text */
    }
    if (res.status === 200 && json && typeof json.vm_id === 'string' && json.vm_id) {
      return { ok: true, status: res.status, vmId: json.vm_id };
    }
    const reason =
      (json && (json.error || json.message)) ||
      (text ? text.replace(/\s+/g, ' ').slice(0, 160) : `HTTP ${res.status}`);
    return { ok: false, status: res.status, reason };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      reason: e.name === 'TimeoutError' ? 'timeout ao falar com muse.ai' : e.message,
    };
  }
}

module.exports = {
  BrowserCookieError,
  CHROMIUM_BROWSERS,
  FIREFOX_BROWSERS,
  PROCESS_NAMES,
  REQUIRED_COOKIE,
  isMuseHost,
  chromiumExpires,
  dpapiUnprotect,
  masterKeyFor,
  decryptChromiumValue,
  readChromiumProfile,
  readFirefoxProfile,
  firefoxProfileDirs,
  chromiumProfileDirs,
  closeBrowsers,
  scanBrowsers,
  normalizeCookieJar,
  cookiesFromHatchSess,
  readCookieJarFile,
  cookieHeader,
  validateCookieJar,
  summarizeCandidate,
  hasSessionCookie,
};
