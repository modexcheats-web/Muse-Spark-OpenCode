'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const {
  scanBrowsers,
  closeBrowsers,
  validateCookieJar,
  normalizeCookieJar,
  cookiesFromHatchSess,
  readCookieJarFile,
  summarizeCandidate,
  cookieHeader,
  isMuseHost,
} = require('./browser-cookies');
const {
  installProvider,
  configPath,
  CONTEXT_WINDOW,
  MODEL_ID,
  PROVIDER_ID,
} = require('../scripts/install-opencode-provider');

const ROOT = path.resolve(__dirname, '..');
const COOKIE_FILE = path.join(ROOT, 'muse.ai.cookies.json');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const PID_FILE = path.join(ROOT, '.muse-proxy.pid');
const SESSION_FILE = path.join(ROOT, '.muse-session.json');
const LOG_DIR = path.join(ROOT, 'logs');
const DEFAULT_PORT = 8790;
const DEFAULT_MODEL = 'muse-spark';

const MANAGED_ENV_KEYS = [
  'MUSE_HATCH_SESS',
  'MUSE_HATCH_GW',
  'MUSE_HATCH_VML',
  'MUSE_COOKIE',
];

function log(message = '') {
  console.log(`[muse-install] ${message}`);
}

function warn(message = '') {
  console.warn(`[muse-install] AVISO: ${message}`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    closeBrowsers: false,
    cookies: null,
    hatchSess: null,
    noStart: false,
    noProvider: false,
    smoke: false,
    checkThreads: false,
    proxyUrl: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--close-browsers') options.closeBrowsers = true;
    else if (arg === '--cookies') options.cookies = argv[++i];
    else if (arg === '--hatch-sess') options.hatchSess = argv[++i];
    else if (arg === '--no-start') options.noStart = true;
    else if (arg === '--no-provider') options.noProvider = true;
    else if (arg === '--smoke') options.smoke = true;
    else if (arg === '--check-threads') options.checkThreads = true;
    else if (arg === '--proxy-url') options.proxyUrl = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }

  if (!options.help) {
    for (const flag of ['cookies', 'hatchSess', 'proxyUrl']) {
      if (options[flag] === undefined || options[flag] === null || options[flag] === '') {
        if (argv.includes(flag === 'cookies' ? '--cookies' : flag === 'hatchSess' ? '--hatch-sess' : '--proxy-url')) {
          throw new Error(`Faltou o valor de --${flag === 'hatchSess' ? 'hatch-sess' : flag === 'proxyUrl' ? 'proxy-url' : 'cookies'}`);
        }
      }
    }
  }
  return options;
}

function usage() {
  console.log(`Uso: node installer/install.js [opções]

  --dry-run           mostra o que seria feito, sem escrever nem reiniciar nada
  --cookies CAMINHO   usa um JSON de cookies exportado
  --hatch-sess VALOR  usa um valor de cookie hatch_sess
  --close-browsers    fecha os navegadores abertos antes de ler os bancos de cookies
  --no-provider       não altera a configuração do OpenCode
  --no-start          não inicia/reinicia o proxy
  --smoke             envia uma mensagem curta de teste pelo proxy
  --check-threads     lista threads no Muse (usa o gateway; combine com --smoke)
  --proxy-url URL     baseURL do provider (padrão: http://127.0.0.1:8790/v1)
  --help              mostra esta ajuda`);
}

function readEnvFile() {
  if (fs.existsSync(ENV_FILE)) return fs.readFileSync(ENV_FILE, 'utf8');
  if (fs.existsSync(ENV_EXAMPLE)) return fs.readFileSync(ENV_EXAMPLE, 'utf8');
  return '';
}

function envValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)$`, 'm'));
  if (!match) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function setEnvValue(text, key, value) {
  const crlf = /\r\n/.test(text);
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*=`);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.splice(-1, 0, `${key}=${value}`);
    else lines.push(`${key}=${value}`);
  }
  return lines.join(crlf ? '\r\n' : '\n');
}

function disableEnvKey(text, key) {
  const crlf = /\r\n/.test(text);
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*)${escaped}\\s*=`);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    if (re.test(lines[i])) {
      lines[i] = `# ${lines[i]}  # desativado pelo instalador: o cookie vem de MUSE_COOKIES_FILE`;
      changed = true;
    }
  }
  return changed ? lines.join(crlf ? '\r\n' : '\n') : text;
}

function disableManagedEnv(text) {
  let next = text;
  for (const key of MANAGED_ENV_KEYS) next = disableEnvKey(next, key);
  return next;
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    fs.renameSync(temp, file);
  }
}

function writeCookieFile(cookies, { dryRun = false } = {}) {
  const normalized = normalizeCookieJar(cookies).filter(
    (cookie) => !cookie.domain || isMuseHost(cookie.domain)
  );
  if (normalized.length === 0) throw new Error('nenhum cookie utilizável para gravar');
  const text = JSON.stringify(normalized, null, 2) + '\n';
  const existing = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8') : null;
  if (existing === text) {
    log(`Cookies já estão atualizados em ${COOKIE_FILE}`);
    return { file: COOKIE_FILE, backup: null, changed: false, cookies: normalized.length };
  }
  if (dryRun) {
    log(`[dry-run] Gravaria ${normalized.length} cookies em ${COOKIE_FILE}`);
    return { file: COOKIE_FILE, backup: null, changed: true, cookies: normalized.length };
  }
  const backup = backupFile(COOKIE_FILE);
  writeFileAtomic(COOKIE_FILE, text);
  log(`Cookies gravados em ${COOKIE_FILE} (${normalized.length} cookies)`);
  if (backup) log(`Backup dos cookies: ${backup}`);
  return { file: COOKIE_FILE, backup, changed: true, cookies: normalized.length };
}

function writeEnvFile(cookiesFile, { dryRun = false } = {}) {
  let text = readEnvFile();
  const original = text;
  text = disableManagedEnv(text);
  text = setEnvValue(text, 'MUSE_COOKIES_FILE', cookiesFile.replace(/\\/g, '/'));
  text = setEnvValue(text, 'MUSE_SESSION_MODE', 'request');
  text = setEnvValue(text, 'MUSE_KEEP_SESSIONS', 'false');
  text = setEnvValue(text, 'MUSE_REASONING_MODE', 'summary');

  let apiKey = envValue(text, 'MUSE_PROXY_API_KEY');
  const generatedKey = !apiKey;
  if (!apiKey) {
    apiKey = crypto.randomBytes(32).toString('hex');
    text = setEnvValue(text, 'MUSE_PROXY_API_KEY', apiKey);
  }

  if (text === original) {
    log(`.env já está atualizado (${ENV_FILE})`);
    return { file: ENV_FILE, backup: null, changed: false, apiKey, generatedKey: false };
  }

  if (dryRun) {
    log(
      `[dry-run] Atualizaria ${ENV_FILE} (MUSE_COOKIES_FILE, MUSE_SESSION_MODE=request, MUSE_REASONING_MODE=summary)`
    );
    if (generatedKey) log('[dry-run] Geraria uma API key local para o proxy');
    return { file: ENV_FILE, backup: null, changed: true, apiKey, generatedKey };
  }

  const backup = backupFile(ENV_FILE);
  writeFileAtomic(ENV_FILE, text);
  log(`.env atualizado: ${ENV_FILE}`);
  if (generatedKey) log('API key local gerada e gravada no .env (protege o proxy).');
  if (backup) log(`Backup do .env: ${backup}`);
  return { file: ENV_FILE, backup, changed: true, apiKey, generatedKey };
}

function cookieJarFromHeader(header) {
  return normalizeCookieJar(
    String(header || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        return eq > 0 ? { name: part.slice(0, eq), value: part.slice(eq + 1) } : null;
      })
      .filter(Boolean)
  );
}

async function validateCandidate(cookies, label) {
  const validation = await validateCookieJar(cookies);
  if (validation.ok) {
    log(`Cookie válido: ${label}`);
    return validation;
  }
  warn(`Cookie rejeitado (${label}): ${validation.status || 'sem HTTP'} ${validation.reason || ''}`.trim());
  return null;
}

async function tryConfiguredCookies() {
  const envText = readEnvFile();
  const attempts = [];

  const cookiesFile = envValue(envText, 'MUSE_COOKIES_FILE');
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    attempts.push({
      label: `MUSE_COOKIES_FILE (${cookiesFile})`,
      load: () => readCookieJarFile(cookiesFile),
    });
  }

  if (fs.existsSync(COOKIE_FILE)) {
    attempts.push({
      label: `cookie file do instalador (${COOKIE_FILE})`,
      load: () => readCookieJarFile(COOKIE_FILE),
    });
  }

  const hatchSess = envValue(envText, 'MUSE_HATCH_SESS');
  if (hatchSess) {
    attempts.push({
      label: 'MUSE_HATCH_SESS do .env',
      load: () => cookiesFromHatchSess(hatchSess),
    });
  }

  const fullCookie = envValue(envText, 'MUSE_COOKIE');
  if (fullCookie) {
    attempts.push({
      label: 'MUSE_COOKIE do .env',
      load: () => cookieJarFromHeader(fullCookie),
    });
  }

  for (const attempt of attempts) {
    let cookies;
    try {
      cookies = attempt.load();
    } catch (e) {
      warn(`${attempt.label}: ${e.message}`);
      continue;
    }
    if (!cookies.length) continue;
    const validation = await validateCandidate(cookies, attempt.label);
    if (validation) {
      return { cookies, source: attempt.label, validation, fromConfig: true };
    }
  }
  return null;
}

async function chooseCookies(options) {
  if (options.hatchSess) {
    const cookies = cookiesFromHatchSess(options.hatchSess);
    const validation = await validateCandidate(cookies, 'hatch_sess informado');
    if (!validation) {
      throw new Error(
        'O hatch_sess informado não autenticou no Muse. Copie um valor novo do navegador e tente de novo.'
      );
    }
    return { cookies, source: 'hatch_sess informado', validation };
  }

  if (options.cookies) {
    const file = path.resolve(options.cookies);
    try {
      const cookies = readCookieJarFile(file);
      const validation = await validateCandidate(cookies, `arquivo ${file}`);
      if (validation) return { cookies, source: file, validation };
    } catch (e) {
      warn(`Não usei ${file}: ${e.message}`);
    }
  }

  if (options.closeBrowsers) {
    if (options.dryRun) {
      log('[dry-run] Fecharia os navegadores abertos antes de ler os bancos de cookies');
    } else {
      log('Fechando navegadores abertos para liberar os bancos de cookies...');
      try {
        closeBrowsers({ logger: { log, warn } });
      } catch (e) {
        warn(`Não consegui fechar os navegadores: ${e.message}`);
      }
    }
  }

  log('Escaneando navegadores e perfis...');
  let scan;
  try {
    scan = scanBrowsers({ logger: { log, warn } });
  } catch (e) {
    warn(`Não foi possível escanear os navegadores: ${e.message}`);
    scan = { candidates: [], scanned: [], notes: [e.message] };
  }

  for (const item of scan.scanned) {
    const detail = item.reason ? ` (${item.reason})` : '';
    const count = item.cookies != null ? `, ${item.cookies} cookie(s)` : '';
    log(`  ${item.browser} / ${item.profile}: ${item.status}${count}${detail}`);
  }
  for (const note of scan.notes) warn(note);

  const usable = scan.candidates.filter((candidate) => candidate.hasSession);
  if (usable.length === 0) {
    warn('Nenhum cookie hatch_sess encontrado nos navegadores.');
    const configured = await tryConfiguredCookies();
    if (configured) {
      log(`Usando a configuração existente: ${configured.source}`);
      return configured;
    }
    throw new Error(
      'Não encontrei uma sessão válida do Muse. Feche o navegador e rode de novo, ' +
        'ou exporte os cookies para JSON e use --cookies CAMINHO, ' +
        'ou passe --hatch-sess VALOR. Se o navegador usa App-Bound Encryption (v20), ' +
        'exporte os cookies manualmente.'
    );
  }

  for (const candidate of usable) {
    log(`Testando ${summarizeCandidate(candidate).browser} / ${summarizeCandidate(candidate).profile}...`);
    const validation = await validateCandidate(
      candidate.cookies,
      `${candidate.browser} / ${candidate.profile}`
    );
    if (validation) {
      return {
        cookies: candidate.cookies,
        source: `${candidate.browser} / ${candidate.profile}`,
        validation,
        candidate,
      };
    }
  }

  const configured = await tryConfiguredCookies();
  if (configured) {
    log(`Nenhum navegador autenticou; usando a configuração existente: ${configured.source}`);
    return configured;
  }

  throw new Error(
    'Os cookies encontrados não autenticaram no Muse. Abra o Muse no navegador, ' +
      'confirme que a conta está logada, feche o navegador e rode de novo. ' +
      'Se necessário, exporte o JSON e use --cookies CAMINHO.'
  );
}

function ensureDependencies({ dryRun = false } = {}) {
  const wsPath = path.join(ROOT, 'node_modules', 'ws');
  if (fs.existsSync(wsPath)) return { installed: false };
  if (dryRun) {
    warn(`node_modules/ws ausente; o instalador rodaria "npm ci" em ${ROOT}`);
    return { installed: false, wouldInstall: true };
  }

  log('Instalando dependências (npm ci)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = fs.existsSync(path.join(ROOT, 'package-lock.json'))
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];
  const result = spawnSync(npm, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.error) throw new Error(`npm não encontrado: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm terminou com código ${result.status}`);
  return { installed: true };
}

async function getHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

function processInfo(pid) {
  if (!pid) return null;
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue`,
    'if ($p) { [pscustomobject]@{ pid = $p.ProcessId; name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }',
  ].join('; ');
  const res = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }
  );
  if (res.status !== 0 || !String(res.stdout || '').trim()) return null;
  try {
    return JSON.parse(String(res.stdout).trim());
  } catch {
    return null;
  }
}

function portOwner(port) {
  const script = [
    `$conn = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if ($conn) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue',
    '  [pscustomobject]@{ pid = $conn.OwningProcess; name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
  const res = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }
  );
  if (res.status !== 0 || !String(res.stdout || '').trim()) return null;
  try {
    return JSON.parse(String(res.stdout).trim());
  } catch {
    return null;
  }
}

function looksLikeMuseProxy(info) {
  if (!info) return false;
  const command = String(info.commandLine || '').toLowerCase();
  return (
    String(info.name || '').toLowerCase().includes('node') &&
    command.includes('server.js') &&
    (command.includes('muse-openai-proxy') || command.includes('src\\server.js') || command.includes('src/server.js'))
  );
}

async function stopProxy(port) {
  const owner = portOwner(port);
  let pid = null;

  if (owner && owner.pid && looksLikeMuseProxy(owner)) {
    pid = Number(owner.pid);
  } else if (fs.existsSync(PID_FILE)) {
    const filePid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    const info = processInfo(filePid);
    if (looksLikeMuseProxy(info)) pid = filePid;
  }

  if (!pid) {
    if (owner) {
      throw new Error(
        `A porta ${port} está ocupada por outro processo (${owner.name || 'desconhecido'}, PID ${owner.pid}); ` +
          'não vou matá-lo. Libere a porta ou configure outra PORT no .env.'
      );
    }
    return { stopped: false };
  }

  log(`Parando o proxy atual (PID ${pid})...`);
  const res = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
    { encoding: 'utf8', timeout: 15000, windowsHide: true }
  );
  if (res.error) throw new Error(`não consegui parar o proxy: ${res.error.message}`);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await getHealth(port)).ok && !portOwner(port)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  try {
    if (fs.existsSync(PID_FILE) && Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === pid) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
  return { stopped: true, pid };
}

function childEnvironment() {
  const env = { ...process.env };
  for (const key of [
    ...MANAGED_ENV_KEYS,
    'MUSE_COOKIES_FILE',
    'MUSE_SESSION_MODE',
    'MUSE_KEEP_SESSIONS',
    'MUSE_REASONING_MODE',
    'MUSE_SESSION_ID',
    'PORT',
    'HOST',
  ]) {
    delete env[key];
  }
  return env;
}

async function startProxy(port) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const outFile = path.join(LOG_DIR, 'proxy.log');
  const errFile = path.join(LOG_DIR, 'proxy.err.log');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');

  let child;
  try {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: childEnvironment(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  if (!child.pid) throw new Error('não consegui iniciar o processo do proxy');
  child.unref();
  log(`Proxy iniciado (PID ${child.pid}); logs em ${LOG_DIR}`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const health = await getHealth(port);
    if (health.ok) {
      log(`Proxy respondendo em http://127.0.0.1:${port}`);
      if (health.body?.sessionMode) log(`Modo de sessão: ${health.body.sessionMode}`);
      if (health.body?.workspace) log(`Workspace: ${health.body.workspace}`);
      return { started: true, pid: child.pid, health: health.body };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const tail = (file) => {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      return lines.slice(-30).join('\n');
    } catch {
      return '';
    }
  };
  throw new Error(
    `o proxy não respondeu em 30s. Log:\n${tail(outFile)}\n${tail(errFile)}`.trim()
  );
}

async function smokeTest(baseURL, apiKey = '') {
  log('Enviando uma mensagem curta de teste...');
  const started = Date.now();
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'Responda apenas: OK' }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  log(`Teste: HTTP ${res.status} em ${Date.now() - started}ms`);
  if (!res.ok) throw new Error(`teste do proxy falhou: ${text.slice(0, 500)}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  const content = json?.choices?.[0]?.message?.content;
  log(`Resposta: ${typeof content === 'string' ? content.slice(0, 200) : text.slice(0, 200)}`);
  return { status: res.status, content };
}

function primarySessionId() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).sessionId || null;
  } catch {
    return null;
  }
}

async function checkThreads(cookies) {
  let MuseGateway;
  try {
    ({ MuseGateway } = require('../src/muse-gateway'));
  } catch (e) {
    warn(`Não consegui carregar o gateway para listar threads: ${e.message}`);
    return null;
  }

  const gateway = new MuseGateway({ cookie: cookieHeader(cookies) });
  try {
    await gateway.connect();
    const res = await gateway.request('GET', '/api/session/list', null, { timeoutMs: 30000 });
    const sessions = res.json?.result?.sessions || [];
    const primary = primarySessionId();
    const threads = sessions.filter(
      (session) =>
        session.is_thread === true ||
        (!session.is_primary && primary && session.session_id !== primary)
    );
    if (threads.length === 0) {
      log('Nenhuma thread extra no Muse (somente a sessão primária).');
    } else {
      warn(`${threads.length} thread(s) extra no Muse:`);
      for (const thread of threads.slice(0, 20)) {
        warn(`  ${thread.session_id} ${thread.title ? `- ${thread.title}` : ''}`);
      }
    }
    return { total: sessions.length, threads };
  } finally {
    try {
      gateway.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    throw new Error(`Node.js 20+ é necessário; você está usando ${process.versions.node}.`);
  }

  log(`Proxy: ${ROOT}`);
  log(`OpenCode config: ${configPath()}`);
  if (options.dryRun) log('MODO DRY-RUN: nada será gravado nem reiniciado.');

  ensureDependencies({ dryRun: options.dryRun });

  const chosen = await chooseCookies(options);
  const summary = chosen.candidate ? summarizeCandidate(chosen.candidate) : null;
  log(`Origem dos cookies: ${chosen.source}`);
  if (summary) {
    log(
      `Cookies Muse: ${summary.cookies}; hatch_sess: ${summary.hasSession ? 'presente' : 'ausente'}` +
        (summary.expires ? `; expira em ${summary.expires}` : '')
    );
  }

  writeCookieFile(chosen.cookies, { dryRun: options.dryRun });
  const envResult = writeEnvFile(COOKIE_FILE, { dryRun: options.dryRun });

  const envText = readEnvFile();
  const port = Number(envValue(envText, 'PORT') || DEFAULT_PORT);
  const baseURL = options.proxyUrl || `http://127.0.0.1:${port}/v1`;

  if (options.noProvider) {
    log('Configuração do OpenCode não alterada (--no-provider).');
  } else {
    const provider = installProvider({ baseURL, apiKey: envResult.apiKey, dryRun: options.dryRun });
    log(`Provider ${PROVIDER_ID}/${MODEL_ID} em ${provider.file}`);
    if (provider.backup) log(`Backup do OpenCode: ${provider.backup}`);
    log(`Contexto declarado: ${provider.provider.models[MODEL_ID].limit.context} tokens`);
  }

  if (options.noStart) {
    log('Proxy não iniciado/reiniciado (--no-start).');
  } else if (options.dryRun) {
    log(`[dry-run] Reiniciaria o proxy na porta ${port} e aguardaria /health`);
  } else {
    const health = await getHealth(port);
    if (health.ok) {
      log('Proxy já está rodando; reiniciando para carregar os cookies novos...');
      await stopProxy(port);
    } else {
      const owner = portOwner(port);
      if (owner) await stopProxy(port);
    }
    await startProxy(port);
  }

  if (options.smoke && !options.dryRun) {
    await smokeTest(baseURL, envResult.apiKey);
  }
  if (options.checkThreads && !options.dryRun) {
    await checkThreads(chosen.cookies);
  }

  log('');
  log('Instalação concluída.');
  log(`Cookies:  ${COOKIE_FILE}`);
  log(`Provider: ${PROVIDER_ID}/${MODEL_ID} (${CONTEXT_WINDOW} tokens de contexto)`);
  log(`Proxy:    ${baseURL}`);
  log('');
  log('No OpenCode, selecione Muse Spark em /models (ou use o modelo "muse/muse-spark").');
  log('Cada requisição cria uma thread nova no Muse e apaga no fim; não há mistura com outros modelos.');
  log('Para manter uma thread por conversa, use MUSE_SESSION_MODE=session no .env.');
  if (options.dryRun) log('Isto foi um dry-run; nenhuma alteração foi gravada.');
}

main().catch((e) => {
  console.error(`[muse-install] ERRO: ${e.message}`);
  if (e.cause?.message) console.error(`[muse-install] causa: ${e.cause.message}`);
  process.exitCode = 1;
});
