'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { MuseGateway } = require('./muse-gateway');
const { MuseChat } = require('./muse-chat');
const { LocalTools } = require('./tools');
const { SessionStore } = require('./session-store');
const { buildPrompt, textOf } = require('./prompt');
const { collectImages } = require('./images');
const { loadDotEnv, resolveCookie } = require('./env');
const { ReasoningStreamParser, splitReasoning } = require('./reasoning');

const DEFAULT_PORT = 8790;
const DEFAULT_MODEL = 'muse-spark';
const MAX_BODY = 24 * 1024 * 1024;

// Logs and client errors include upstream/proxy strings; keep each entry on one
// line so a crafted workspace path or tool message cannot forge log records.
function oneLine(value, max = 400) {
  return String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, max);
}

function resolveApiKey() {
  const fromEnv = (process.env.MUSE_PROXY_API_KEY || '').trim();
  if (fromEnv) return fromEnv;

  const keyFile = path.join(process.cwd(), '.muse-proxy-key');
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }

  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
    console.warn('[muse] generated local API key in .muse-proxy-key');
  } catch (e) {
    console.warn('[muse] could not persist API key:', oneLine(e.message));
  }
  return key;
}

function corsOrigins() {
  return (process.env.MUSE_CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadConfig() {
  loadDotEnv();
  const sessionFile = path.join(process.cwd(), '.muse-session.json');
  let sessionId = process.env.MUSE_SESSION_ID || null;
  if (!sessionId && fs.existsSync(sessionFile)) {
    try {
      sessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId || null;
    } catch {
      /* ignore */
    }
  }
  const sessionMode = (process.env.MUSE_SESSION_MODE || 'request').toLowerCase();
  const validSessionModes = new Set(['request', 'session', 'legacy']);
  if (!validSessionModes.has(sessionMode)) {
    throw new Error(
      `MUSE_SESSION_MODE must be one of request, session, legacy (got ${JSON.stringify(sessionMode)})`
    );
  }
  const reasoningMode = (process.env.MUSE_REASONING_MODE || 'summary').toLowerCase();
  const validReasoningModes = new Set(['off', 'summary']);
  if (!validReasoningModes.has(reasoningMode)) {
    throw new Error(
      `MUSE_REASONING_MODE must be one of off, summary (got ${JSON.stringify(reasoningMode)})`
    );
  }
  return {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || DEFAULT_PORT),
    apiKey: resolveApiKey(),
    corsOrigins: corsOrigins(),
    model: process.env.MUSE_MODEL || DEFAULT_MODEL,
    cookie: resolveCookie(),
    deviceId: process.env.MUSE_DEVICE_ID || null,
    deviceFile: path.join(process.cwd(), '.muse-device.json'),
    sessionId,
    sessionFile,
    sessionMode,
    reasoningMode,
    keepSessions: process.env.MUSE_KEEP_SESSIONS === 'true',
    timeoutMs: Number(process.env.MUSE_TIMEOUT_MS || 180000),
    workspace: process.env.MUSE_WORKSPACE || null,
    enableShell: process.env.MUSE_ENABLE_SHELL !== 'false',
  };
}

function saveSession(config, sessionId) {
  if (!sessionId || config.sessionId === sessionId) return;
  config.sessionId = sessionId;
  try {
    fs.writeFileSync(config.sessionFile, JSON.stringify({ sessionId }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[muse] could not persist session id:', oneLine(e.message));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = 'server_error', code = null) {
  sendJson(res, status, {
    error: { message, type, param: null, code },
  });
}

function estimateUsage(prompt, text, reasoningText = '') {
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens = Math.max(0, Math.ceil((text || '').length / 4));
  const reasoningTokens = Math.max(0, Math.ceil((reasoningText || '').length / 4));
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  if (reasoningTokens > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return usage;
}

function applyStop(text, stop) {
  if (!text) return text;
  const stops = Array.isArray(stop) ? stop : stop ? [stop] : [];
  let out = text;
  for (const s of stops) {
    if (typeof s !== 'string' || s.length === 0) continue;
    const idx = out.indexOf(s);
    if (idx !== -1) out = out.slice(0, idx);
  }
  return out;
}

function createStopFilter(stop) {
  const stops = (Array.isArray(stop) ? stop : stop ? [stop] : []).filter(
    (s) => typeof s === 'string' && s.length > 0
  );
  if (stops.length === 0) {
    return {
      push: (text) => text,
      flush: () => '',
      get stopped() {
        return false;
      },
    };
  }
  const hold = Math.max(...stops.map((s) => s.length)) - 1;
  let buffer = '';
  let stopped = false;
  return {
    push(text) {
      if (stopped || !text) return '';
      buffer += text;
      let cut = -1;
      for (const s of stops) {
        const idx = buffer.indexOf(s);
        if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
      }
      if (cut !== -1) {
        stopped = true;
        const out = buffer.slice(0, cut);
        buffer = '';
        return out;
      }
      if (hold > 0 && buffer.length > hold) {
        const out = buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        return out;
      }
      return '';
    },
    flush() {
      if (stopped) return '';
      const out = buffer;
      buffer = '';
      return out;
    },
    get stopped() {
      return stopped;
    },
  };
}

function detectWorkspaceRoot(config, req, body) {
  const explicit = config.workspace || req.headers['x-muse-workspace'];
  if (explicit && typeof explicit === 'string') {
    try {
      const resolved = path.resolve(explicit);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      /* ignore */
    }
    console.warn(`[muse] configured workspace does not exist, ignoring: ${oneLine(explicit)}`);
  }
  const pick = (text) => {
    const matches = [...String(text || '').matchAll(/Working directory:\s*([^\r\n<]+)/gi)];
    if (matches.length === 0) return null;
    const candidate = matches[matches.length - 1][1].trim().replace(/^[`"']+|[`"']+$/g, '');
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      /* ignore */
    }
    return null;
  };
  const systemText = (body.messages || [])
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => textOf(m.content))
    .join('\n');
  const fromSystem = pick(systemText);
  if (fromSystem) return fromSystem;
  const fromAny = pick((body.messages || []).map((m) => textOf(m.content)).join('\n'));
  if (fromAny) return fromAny;
  return path.resolve(process.cwd());
}

function completionId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

function sseData(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function applyCors(req, res, config) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = config.corsOrigins.includes('*') || config.corsOrigins.includes(origin);
  if (!allowed) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  return true;
}

function tokenMatches(provided, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

async function main() {
  const config = loadConfig();
  const gateway = new MuseGateway({ cookie: config.cookie });
  const tools = new LocalTools({
    workspaceRoot: config.workspace || process.cwd(),
    enableShell: config.enableShell,
  });
  const chat = new MuseChat({
    gateway,
    deviceId: config.deviceId,
    deviceFile: config.deviceFile,
    sessionId: config.sessionId,
    // A fixed primary session is only meaningful in legacy mode. In request
    // and session modes every conversation has its own thread, so a stale
    // .muse-session.json must not be treated as the primary chat.
    primarySessionId: config.sessionMode === 'legacy' ? config.sessionId : null,
    timeoutMs: config.timeoutMs,
    tools,
  });
  const sessionStore = new SessionStore(path.join(process.cwd(), '.muse-sessions.json'));

  gateway.on('protocol-error', (e) => console.warn('[muse] protocol error:', oneLine(e.message)));
  gateway.on('socket-error', (e) => console.warn('[muse] socket error:', oneLine(e.message)));
  chat.on('stream-ack', (ack) => {
    // Only the legacy fixed-session mode persists the id. Request/session
    // modes create disposable threads; persisting them would leave a dead id
    // in .muse-session.json after the thread is deleted.
    if (config.sessionMode === 'legacy' && ack.session_id) {
      saveSession(config, ack.session_id);
    }
  });
  chat.on('capabilities', (res) => {
    if (res?.accepted_device_commands != null) {
      console.log(`[muse] device commands accepted: ${res.accepted_device_commands}`);
    }
    if (Array.isArray(res?.rejected_ids) && res.rejected_ids.length > 0) {
      console.warn(`[muse] rejected device commands: ${oneLine(res.rejected_ids.join(', '))}`);
    }
  });
  chat.on('tool-call', ({ commandId }) => {
    console.log(`[muse] tool call: ${oneLine(commandId)}`);
  });
  chat.on('tool-result', ({ commandId, ok, code, message }) => {
    console.log(`[muse] tool ${oneLine(commandId)}: ${ok ? 'ok' : `error ${code}: ${oneLine(message)}`}`);
  });

  let tail = Promise.resolve();
  const enqueue = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const originAllowed = applyCors(req, res, config);

    if (req.method === 'OPTIONS') {
      if (req.headers.origin && !originAllowed) {
        res.writeHead(403, { 'content-length': '0' });
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
      sendJson(res, 200, {
        ok: true,
        model: config.model,
        tools: Object.keys(tools.commands),
        sessionMode: config.sessionMode,
        keepSessions: config.keepSessions,
        reasoning: config.reasoningMode,
        images: true,
      });
      return;
    }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(token, config.apiKey)) {
      sendError(res, 401, 'invalid proxy API key', 'authentication_error');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [
          {
            id: config.model,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'meta',
          },
        ],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
      if (id !== config.model) {
        sendError(res, 404, `model ${id} not found`, 'invalid_request_error', 'model_not_found');
        return;
      }
      sendJson(res, 200, {
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'meta',
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        sendError(res, e.statusCode || 400, `invalid JSON body: ${e.message}`, 'invalid_request_error');
        return;
      }

      let images;
      try {
        images = collectImages(body.messages);
      } catch (e) {
        sendError(res, e.statusCode || 400, e.message, 'invalid_request_error', e.code || null);
        return;
      }
      const reasoningEnabled = config.reasoningMode === 'summary';
      const prompt = buildPrompt(body, { images, reasoning: reasoningEnabled });
      const stream = body.stream === true;
      const id = completionId();
      const created = Math.floor(Date.now() / 1000);
      const model = body.model || config.model;
      const base = { id, object: 'chat.completion.chunk', created, model };
      const workspaceRoot = detectWorkspaceRoot(config, req, body);
      const sessionMode = config.sessionMode;
      const sessionKey =
        sessionMode === 'session' ? sessionStore.keyFor(body, workspaceRoot) : null;
      const existingSession = sessionKey ? sessionStore.get(sessionKey) : null;
      const fresh =
        sessionMode === 'request' || (sessionMode === 'session' && !existingSession);
      const requestedSessionId =
        sessionMode === 'legacy'
          ? config.sessionId
          : existingSession?.sessionId || crypto.randomUUID();
      const stopFilter = stream ? createStopFilter(body.stop) : null;
      let ping = null;

      if (stream) {
        startSse(res);
        sseData(res, {
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        });
        ping = setInterval(() => {
          if (!res.writableEnded) res.write(': ping\n\n');
        }, 15000);
      }

      const reasoningParser = stream && reasoningEnabled ? new ReasoningStreamParser() : null;
      const sendDelta = (delta) => {
        if (res.writableEnded) return;
        sseData(res, {
          ...base,
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      };
      const emitParsed = (items) => {
        for (const item of items) {
          if (!item || !item.text) continue;
          if (item.type === 'reasoning') {
            sendDelta({ reasoning_content: item.text });
            continue;
          }
          const safe = stopFilter.push(item.text);
          if (safe) sendDelta({ content: safe });
        }
      };
      const onText = stream
        ? (chunk) => {
            if (reasoningParser) {
              emitParsed(reasoningParser.push(chunk));
              return;
            }
            const safe = stopFilter.push(chunk);
            if (safe) sendDelta({ content: safe });
          }
        : null;

      let completed;
      try {
        completed = await enqueue(() => {
          if (tools.workspaceRoot !== workspaceRoot) {
            console.log(`[muse] workspace for this request: ${oneLine(workspaceRoot)}`);
          }
          tools.setWorkspaceRoot(workspaceRoot);
          return chat.complete(prompt, {
            sessionId: requestedSessionId,
            fresh,
            timeoutMs: config.timeoutMs,
            onText,
            images,
          });
        });
        const completedSessionId = completed.sessionId || requestedSessionId;
        if (sessionMode === 'session' && sessionKey) {
          sessionStore.set(sessionKey, completedSessionId);
        } else if (sessionMode === 'legacy') {
          saveSession(config, completedSessionId);
        }
        if (sessionMode === 'request' && !config.keepSessions) {
          await chat.deleteSession(completedSessionId);
        }
      } catch (e) {
        if (ping) clearInterval(ping);
        if (fresh) {
          try {
            await chat.deleteSession(chat.lastAckSessionId || requestedSessionId);
          } catch {
            /* best effort */
          }
        }
        const message =
          e.code === 'AUTH'
            ? 'Muse web session expired or invalid. Update MUSE_HATCH_SESS with a fresh hatch_sess cookie.'
            : oneLine(e.message || String(e), 600);
        if (stream && res.headersSent) {
          sseData(res, { error: { message, type: 'upstream_error', code: e.code || null } });
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sendError(res, 502, message, 'upstream_error', e.code || null);
        }
        return;
      }

      const parsed = reasoningEnabled
        ? splitReasoning(completed.text || '')
        : { reasoning: '', content: completed.text || '' };
      let text = applyStop(parsed.content, body.stop);
      if (body.response_format?.type === 'json_object' && text.trim()) {
        // Keep the model's JSON as-is; only strip accidental code fences.
        const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)```$/i);
        if (match) text = match[1].trim();
      }
      const usage = estimateUsage(prompt, completed.text || text, parsed.reasoning);

      if (!stream) {
        const message = { role: 'assistant', content: text };
        if (reasoningEnabled && parsed.reasoning) {
          message.reasoning_content = parsed.reasoning;
        }
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message,
              finish_reason: 'stop',
            },
          ],
          usage,
        });
        return;
      }

      if (reasoningParser) {
        emitParsed(reasoningParser.flush());
        // The final transcript can contain text that was not streamed (for
        // example when the subscription replay only had message_done). Send
        // only the suffix that the client has not seen yet.
        const finalParsed = splitReasoning(completed.text || '');
        if (finalParsed.reasoning.startsWith(reasoningParser.reasoning)) {
          const rest = finalParsed.reasoning.slice(reasoningParser.reasoning.length);
          if (rest) sendDelta({ reasoning_content: rest });
        }
        if (!stopFilter.stopped && finalParsed.content.startsWith(reasoningParser.content)) {
          const rest = finalParsed.content.slice(reasoningParser.content.length);
          if (rest) {
            const safe = stopFilter.push(rest);
            if (safe) sendDelta({ content: safe });
          }
        }
      }

      const tail = stopFilter.flush();
      if (tail) {
        sseData(res, {
          ...base,
          choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
        });
      }
      sseData(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      if (body.stream_options?.include_usage) {
        sseData(res, { ...base, choices: [], usage });
      }
      res.write('data: [DONE]\n\n');
      clearInterval(ping);
      res.end();
      return;
    }

    sendError(res, 404, `no route for ${req.method} ${url.pathname}`, 'invalid_request_error');
  });

  const pidFile = path.join(process.cwd(), '.muse-proxy.pid');

  server.listen(config.port, config.host, () => {
    try {
      fs.writeFileSync(pidFile, String(process.pid));
    } catch {
      /* ignore */
    }
    console.log(`[muse] OpenAI-compatible proxy on http://${config.host}:${config.port}/v1`);
    console.log(
      `[muse] model: ${config.model}` +
        (config.sessionMode === 'legacy' && config.sessionId
          ? ` (session ${config.sessionId})`
          : '')
    );
    console.log(`[muse] session mode: ${config.sessionMode}${config.keepSessions ? ' (keep threads)' : ''}`);
    console.log(`[muse] reasoning: ${config.reasoningMode}`);
    console.log('[muse] auth: Bearer token required (MUSE_PROXY_API_KEY)');
    console.log(`[muse] workspace: ${oneLine(tools.workspaceRoot)}`);
    console.log(`[muse] shell.exec: ${config.enableShell ? 'enabled' : 'disabled'}`);
  });

  const shutdown = () => {
    console.log('\n[muse] shutting down...');
    try {
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      /* ignore */
    }
    chat.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[muse] fatal:', e.message);
  process.exit(1);
});
