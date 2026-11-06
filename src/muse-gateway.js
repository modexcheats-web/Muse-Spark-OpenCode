'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');
const {
  XX,
  EMPTY,
  encodeAppRequest,
  encodeServiceFrame,
  encodeServiceRequest,
  encodeServiceReset,
  encodeTransportFrame,
  decodeTransportFrame,
  decodeServiceFrame,
} = require('./noise');

const MUSE_ORIGIN = 'https://muse.ai';
const GATEWAY_URL = 'wss://hatch.metaaivm.com/v1/noise';
const APP_ID = 'hatch-web';
const DAEMON = 0;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

class GatewayError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

class MuseGateway extends EventEmitter {
  constructor({ cookie, userAgent = DEFAULT_UA, logger = console } = {}) {
    super();
    if (!cookie) throw new GatewayError('missing Muse cookie');
    this.cookie = cookie;
    this.userAgent = userAgent;
    this.logger = logger;
    this.ws = null;
    this.xx = null;
    this.sendCipher = null;
    this.recvCipher = null;
    this.connecting = null;
    this.assemblies = new Map();
    this.streams = new Map();
    this.nextStreamId = 1n;
    this.lastSeq = 0;
    this.closed = false;
  }

  // ---------- HTTPS control plane ----------

  async #api(path, opts = {}) {
    const headers = {
      'user-agent': this.userAgent,
      accept: 'application/json, text/plain, */*',
      cookie: this.cookie,
      origin: MUSE_ORIGIN,
      referer: MUSE_ORIGIN + '/',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...opts.headers,
    };
    let res;
    try {
      res = await fetch(MUSE_ORIGIN + path, { ...opts, headers });
    } catch (e) {
      throw new GatewayError(`Muse HTTP ${path} failed: ${e.message}`, { code: 'NETWORK' });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new GatewayError(`Muse HTTP ${path} -> ${res.status}: ${text.slice(0, 300)}`, {
        code: res.status === 401 || res.status === 403 ? 'AUTH' : 'HTTP',
        status: res.status,
      });
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GatewayError(`Muse HTTP ${path} returned invalid JSON`);
    }
  }

  async #gatewayCredentials() {
    const session = await this.#api('/api/session?vm_state=live');
    if (!session || !session.vm_id) {
      throw new GatewayError('Muse session has no live VM assignment (is the web session signed in?)', {
        code: 'NO_VM',
      });
    }
    const token = await this.#api('/api/hatch/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vmAddress: session.endpoint_url, vmName: session.vm_name }),
    });
    if (!token || !token.token) {
      throw new GatewayError('Muse gateway token response missing token', { code: 'AUTH' });
    }
    return { session, token: token.token, notary: token.notary_token };
  }

  async #wakeVm(vmId) {
    if (!vmId) return;
    try {
      await this.#api('/api/hatch/vm/wake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vm_id: vmId, retry_count: 0 }),
      });
    } catch (e) {
      // Wake is best-effort: an already-running VM can reject the request.
      this.emit('wake-error', e);
    }
  }

  // ---------- WebSocket + Noise ----------

  async connect() {
    if (this.closed) throw new GatewayError('gateway is closed');
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sendCipher) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this.#connect();
        } catch (e) {
          lastError = e;
          if (e.code !== 'COLD_START' || attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 8000));
        }
      }
      throw lastError;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #connect() {
    const creds = await this.#gatewayCredentials();
    await this.#wakeVm(creds.session.vm_id);
    const url = new URL(GATEWAY_URL);
    url.searchParams.set('vm_id', creds.session.vm_id);
    url.searchParams.set('auth_token', creds.token);
    url.searchParams.set('app_id', APP_ID);
    url.searchParams.set('request_id', crypto.randomUUID());
    if (creds.notary) url.searchParams.set('notary_token', creds.notary);

    const ws = new WebSocket(url, { origin: MUSE_ORIGIN, handshakeTimeout: 15000 });
    this.ws = ws;

    ws.on('message', (data) => this.#handleRaw(Buffer.from(data)));
    ws.on('close', (code, reason) => {
      this.sendCipher = null;
      this.recvCipher = null;
      const err = new GatewayError(`gateway closed (${code}) ${reason?.toString() ?? ''}`.trim(), {
        code: 'CLOSED',
      });
      for (const stream of this.streams.values()) stream.reject?.(err);
      this.streams.clear();
      this.emit('close', err);
    });
    ws.on('error', (err) => this.emit('socket-error', err));

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(new GatewayError(`gateway websocket failed: ${err.message}`, { code: 'NETWORK' }));
      };
      const onUnexpected = (req, res) => {
        const status = res.statusCode;
        res.resume();
        cleanup();
        reject(
          new GatewayError(`gateway websocket rejected with HTTP ${status}`, {
            code: status === 502 || status === 503 ? 'COLD_START' : 'NETWORK',
            status,
          })
        );
      };
      const onClose = () => {
        cleanup();
        reject(new GatewayError('gateway websocket closed before Noise handshake', { code: 'CLOSED' }));
      };
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
        ws.off('unexpected-response', onUnexpected);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.once('close', onClose);
      ws.once('unexpected-response', onUnexpected);
    });

    const xx = new XX();
    const nonce = crypto.randomBytes(32);
    const msg1 = xx.writeMessage1(Buffer.concat([Buffer.from([0x0a, 0x20]), nonce]));
    ws.send(msg1);
    const msg2 = await this.#nextHandshakeMessage();
    xx.readMessage2(msg2);
    ws.send(xx.writeMessage3(EMPTY));
    const { send, recv } = xx.split();
    this.sendCipher = send;
    this.recvCipher = recv;
    this.xx = xx;
    this.emit('connected');
  }

  #nextHandshakeMessage() {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      const timer = setTimeout(() => {
        cleanup();
        reject(new GatewayError('Noise handshake timed out', { code: 'TIMEOUT' }));
      }, 15000);
      const onMessage = (data) => {
        cleanup();
        resolve(Buffer.from(data));
      };
      const onClose = () => {
        cleanup();
        reject(new GatewayError('gateway closed during Noise handshake', { code: 'CLOSED' }));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };
      ws.once('message', onMessage);
      ws.once('close', onClose);
    });
  }

  #handleRaw(raw) {
    if (!this.recvCipher) return;
    let plain;
    try {
      plain = this.recvCipher.decrypt(EMPTY, raw);
    } catch (e) {
      this.emit('protocol-error', new Error('Noise decrypt failed: ' + e.message));
      return;
    }
    const tf = decodeTransportFrame(plain);
    const key = tf.chunkId.toString();
    let asm = this.assemblies.get(key);
    if (!asm) {
      asm = { total: tf.totalChunks, chunks: new Map() };
      this.assemblies.set(key, asm);
    }
    asm.chunks.set(tf.chunkIndex, tf.payload);
    if (asm.chunks.size < asm.total) return;
    this.assemblies.delete(key);
    const parts = [];
    for (let i = 0; i < asm.total; i++) {
      const part = asm.chunks.get(i);
      if (!part) return;
      parts.push(part);
    }
    let frameBytes;
    try {
      frameBytes = parseServiceFramePayload(Buffer.concat(parts));
    } catch (e) {
      this.emit('protocol-error', e);
      return;
    }
    this.#handleServiceFrame(decodeServiceFrame(frameBytes));
  }

  #handleServiceFrame(sf) {
    const stream = this.streams.get(String(sf.streamId));
    if (!stream) {
      this.emit('orphan-frame', sf);
      return;
    }
    if (sf.reset) {
      const err = new GatewayError(
        `gateway reset (${sf.reset.code ?? '?'}): ${sf.reset.reason ?? ''}`.trim(),
        { code: 'RESET', status: sf.reset.code }
      );
      this.streams.delete(String(sf.streamId));
      stream.reject(err);
      return;
    }
    if (sf.response) {
      stream.status = sf.response.status;
      stream.headers = sf.response.headers;
      if (sf.response.body && sf.response.body.length) this.#deliverBody(stream, sf.response.body);
      if (sf.response.endBody) this.#endStream(stream);
      stream.onResponse?.(sf.response);
    }
    if (sf.bodyChunk) {
      if (sf.bodyChunk.data && sf.bodyChunk.data.length) this.#deliverBody(stream, sf.bodyChunk.data);
      if (sf.bodyChunk.endBody) this.#endStream(stream);
    }
  }

  #deliverBody(stream, data) {
    if (stream.mode === 'lines') {
      stream.text += data.toString('utf8');
      if (stream.text.length > stream.maxBuffer) {
        const err = new GatewayError('subscription record buffer overflow', { code: 'OVERFLOW' });
        this.streams.delete(String(stream.streamId));
        stream.reject(err);
        return;
      }
      let idx;
      while ((idx = stream.text.indexOf('\n')) !== -1) {
        const line = stream.text.slice(0, idx).trim();
        stream.text = stream.text.slice(idx + 1);
        if (line) this.#emitRecord(stream, line);
      }
    } else {
      stream.chunks.push(data);
      stream.bytes = (stream.bytes ?? 0) + data.length;
      if (stream.bytes > stream.maxBuffer) {
        const err = new GatewayError('response body exceeded buffer limit', { code: 'OVERFLOW' });
        this.streams.delete(String(stream.streamId));
        stream.reject(err);
      }
    }
  }

  #emitRecord(stream, line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stream.onRawRecord?.(line);
      return;
    }
    try {
      stream.onRecord?.(record);
    } catch (e) {
      this.emit('record-error', e);
    }
  }

  #endStream(stream) {
    const key = String(stream.streamId);
    this.streams.delete(key);
    if (stream.mode === 'lines') {
      if (stream.text.trim()) this.#emitRecord(stream, stream.text.trim());
      stream.text = '';
      stream.onEnd?.();
      stream.resolve?.({ status: stream.status, headers: stream.headers });
      return;
    }
    const body = Buffer.concat(stream.chunks);
    const text = body.toString('utf8');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    stream.resolve?.({ status: stream.status, headers: stream.headers, body, text, json });
  }

  async #send(method, path, body, stream) {
    const streamId = this.nextStreamId++;
    stream.streamId = streamId;
    stream.status = 0;
    stream.headers = [];
    this.streams.set(String(streamId), stream);

    await this.connect();
    if (!this.sendCipher || this.ws?.readyState !== WebSocket.OPEN) {
      this.streams.delete(String(streamId));
      throw new GatewayError('gateway is not connected', { code: 'CLOSED' });
    }

    const headers = [
      { key: 'x-app-id', value: APP_ID },
      { key: 'x-request-id', value: crypto.randomUUID() },
      { key: 'Accept-Language', value: 'en-US' },
    ];
    const payload = body == null ? EMPTY : Buffer.from(JSON.stringify(body));
    if (payload.length) headers.push({ key: 'Content-Type', value: 'application/json' });
    const appReq = encodeAppRequest({
      verb: method,
      path,
      headers,
      body: payload,
      endBody: true,
    });
    const service = encodeServiceRequest(
      DAEMON,
      encodeServiceFrame(streamId, 'request', appReq)
    );
    const maxChunk = 65489;
    const totalChunks = Math.max(1, Math.ceil(service.length / maxChunk));
    if (totalChunks > 256) {
      this.streams.delete(String(streamId));
      throw new GatewayError(
        `request too large for noise framing (${service.length} bytes)`,
        { code: 'TOO_LARGE' }
      );
    }
    const chunkId = crypto.randomBytes(8).readBigUInt64BE(0);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = service.subarray(i * maxChunk, Math.min((i + 1) * maxChunk, service.length));
      const frame = encodeTransportFrame({
        chunkId,
        chunkIndex: i,
        totalChunks,
        payload: chunk,
      });
      this.ws.send(this.sendCipher.encrypt(EMPTY, frame));
    }
    this.emit('send', { method, path, streamId, bytes: service.length, chunks: totalChunks });
    return streamId;
  }

  request(method, path, body, { timeoutMs = 30000, maxBuffer = 16 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const stream = { mode: 'buffer', chunks: [], maxBuffer };
      stream.resolve = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      stream.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      timer = setTimeout(() => {
        if (stream.streamId != null) this.streams.delete(String(stream.streamId));
        reject(new GatewayError(`request ${method} ${path} timed out`, { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.#send(method, path, body, stream).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * Opens a long-lived NDJSON subscription.
   * `onRecord(record)` receives every parsed line (including the initial ack).
   * Returns { streamId, closed: Promise } and is resolveable to when ack arrives via onAck.
   */
  openSubscription(
    method,
    path,
    body,
    { onRecord, onAck, timeoutMs = 30000, maxBuffer = 4 * 1024 * 1024 } = {}
  ) {
    let resolveAck;
    let rejectAck;
    const ack = new Promise((res, rej) => {
      resolveAck = res;
      rejectAck = rej;
    });
    let first = true;
    let timer;
    const stream = {
      mode: 'lines',
      text: '',
      maxBuffer,
      onRecord: (record) => {
        if (first) {
          first = false;
          clearTimeout(timer);
        }
        const isAck =
          record &&
          typeof record === 'object' &&
          record.type !== 'event' &&
          !('event' in record);
        if (isAck) {
          onAck?.(record);
          resolveAck(record);
        }
        onRecord?.(record);
      },
      reject: (e) => rejectAck(e),
    };
    timer = setTimeout(() => {
      rejectAck(new GatewayError(`subscription ${method} ${path} timed out`, { code: 'TIMEOUT' }));
    }, timeoutMs);
    this.#send(method, path, body, stream).catch((e) => {
      clearTimeout(timer);
      rejectAck(e);
    });
    return {
      ack,
      get streamId() {
        return stream.streamId;
      },
      close: () => this.#cancel(stream.streamId),
    };
  }

  #cancel(streamId) {
    const stream = this.streams.get(String(streamId));
    if (!stream) return;
    this.streams.delete(String(streamId));
    stream.reject?.(new GatewayError('subscription cancelled', { code: 'CANCELLED' }));
    if (this.sendCipher && this.ws?.readyState === WebSocket.OPEN) {
      const payload = encodeServiceReset(DAEMON, streamId, {
        code: 1,
        reason: 'client cancelled request',
      });
      const totalChunks = Math.max(1, Math.ceil(payload.length / 65489));
      const chunkId = crypto.randomBytes(8).readBigUInt64BE(0);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = payload.subarray(i * 65489, Math.min((i + 1) * 65489, payload.length));
        const frame = encodeTransportFrame({
          chunkId,
          chunkIndex: i,
          totalChunks,
          payload: chunk,
        });
        this.ws.send(this.sendCipher.encrypt(EMPTY, frame));
      }
    }
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close(1000, 'client shutdown');
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

function parseServiceFramePayload(buf) {
  // ServiceResponse { 1: ServiceFrame }
  const fields = require('./protobuf').parseProto(buf);
  const inner = fields.find((f) => f.field === 1);
  if (!inner) throw new Error('ServiceResponse missing payload');
  return inner.value;
}

module.exports = { MuseGateway, GatewayError };
