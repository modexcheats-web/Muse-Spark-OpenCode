'use strict';

const crypto = require('crypto');
const { parseProto, ld, vf, str, bool } = require('./protobuf');

const PROTOCOL = Buffer.from('Noise_XX_25519_AESGCM_SHA256');
const EMPTY = Buffer.alloc(0);
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

function hkdf(ck, input, count) {
  const temp = hmac(ck, input);
  const out = [hmac(temp, Buffer.from([1]))];
  if (count > 1) out.push(hmac(temp, Buffer.concat([out[0], Buffer.from([2])])));
  return out;
}

class CipherState {
  constructor(key) {
    this.key = key ? Buffer.from(key) : null;
    this.n = 0n;
  }

  #nonce() {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(this.n, 4);
    this.n++;
    return b;
  }

  encrypt(ad, pt) {
    if (!this.key) return Buffer.from(pt);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, this.#nonce());
    c.setAAD(ad);
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  }

  decrypt(ad, ct) {
    if (!this.key) return Buffer.from(ct);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, this.#nonce());
    d.setAAD(ad);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  }
}

class SymmetricState {
  constructor() {
    const padded = Buffer.alloc(32);
    padded.set(PROTOCOL);
    this.ck = Buffer.from(padded);
    this.hash = sha256(padded, EMPTY);
    this.cipher = new CipherState(null);
  }

  mixHash(data) {
    this.hash = sha256(this.hash, data);
  }

  mixKey(data) {
    const [ck, key] = hkdf(this.ck, data, 2);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }

  encryptAndHash(pt) {
    const ct = this.cipher.encrypt(this.hash, pt);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ct) {
    const pt = this.cipher.decrypt(this.hash, ct);
    this.mixHash(ct);
    return pt;
  }

  split() {
    const [a, b] = hkdf(this.ck, EMPTY, 2);
    return [new CipherState(a), new CipherState(b)];
  }
}

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey, privateKey, pub: der.subarray(der.length - 32) };
}

function dh(key, remotePub) {
  const remote = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, remotePub]),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey: key.privateKey, publicKey: remote });
}

class XX {
  constructor() {
    this.s = new SymmetricState();
    this.e = null;
    this.serverEphemeral = null;
    this.serverStatic = null;
  }

  writeMessage1(payload) {
    this.e = makeKey();
    this.s.mixHash(this.e.pub);
    const enc = this.s.encryptAndHash(payload);
    return Buffer.concat([this.e.pub, enc]);
  }

  readMessage2(msg) {
    if (msg.length < 80) throw new Error('noise: message 2 too short');
    const serverE = msg.subarray(0, 32);
    this.serverEphemeral = serverE;
    this.s.mixHash(serverE);
    this.s.mixKey(dh(this.e, serverE));
    this.serverStatic = this.s.decryptAndHash(msg.subarray(32, 80));
    this.s.mixKey(dh(this.e, this.serverStatic));
    const payload = this.s.decryptAndHash(msg.subarray(80));
    return { serverStatic: this.serverStatic, payload };
  }

  writeMessage3(payload) {
    const e = makeKey();
    const encPub = this.s.encryptAndHash(e.pub);
    this.s.mixKey(dh(e, this.serverEphemeral));
    const encPayload = this.s.encryptAndHash(payload);
    return Buffer.concat([encPub, encPayload]);
  }

  split() {
    const [a, b] = this.s.split();
    return { send: a, recv: b };
  }
}

// ---------- transport frames ----------

function encodeHeader(h) {
  return Buffer.concat([str(1, h.key), str(2, h.value)]);
}

function encodeAppRequest({ verb, path, headers, body, endBody }) {
  const parts = [str(1, verb), str(2, path)];
  for (const h of headers) parts.push(ld(3, encodeHeader(h)));
  if (body && body.length) parts.push(ld(4, body));
  parts.push(bool(5, endBody !== false));
  return Buffer.concat(parts);
}

function encodeServiceFrame(streamId, kind, value) {
  const field = { request: 2, response: 3, bodyChunk: 4, reset: 5 }[kind];
  return Buffer.concat([vf(1, streamId), ld(field, value)]);
}

function encodeServiceRequest(service, payload) {
  return Buffer.concat([vf(1, service), ld(2, payload)]);
}

function encodeServiceReset(service, streamId, { code = 1, reason = '' } = {}) {
  const reset = Buffer.concat([vf(1, code), str(2, reason)]);
  const frame = Buffer.concat([vf(1, streamId), ld(5, reset)]);
  return encodeServiceRequest(service, frame);
}

function encodeTransportFrame({ chunkId, chunkIndex, totalChunks, payload }) {
  return Buffer.concat([
    vf(1, chunkId),
    vf(2, chunkIndex),
    vf(3, totalChunks),
    ld(4, payload),
  ]);
}

function decodeTransportFrame(buf) {
  const out = { chunkId: 0n, chunkIndex: 0, totalChunks: 1, payload: EMPTY };
  for (const f of parseProto(buf)) {
    if (f.field === 1) out.chunkId = f.value;
    else if (f.field === 2) out.chunkIndex = Number(f.value);
    else if (f.field === 3) out.totalChunks = Number(f.value);
    else if (f.field === 4) out.payload = f.value;
  }
  return out;
}

function decodeHeader(buf) {
  const o = {};
  for (const f of parseProto(buf)) {
    if (f.field === 1) o.key = f.value.toString();
    if (f.field === 2) o.value = f.value.toString();
  }
  return o;
}

function decodeAppResponse(buf) {
  const o = { headers: [], status: 0 };
  for (const f of parseProto(buf)) {
    if (f.field === 1) o.status = Number(f.value);
    else if (f.field === 2) o.headers.push(decodeHeader(f.value));
    else if (f.field === 3) o.body = f.value;
    else if (f.field === 4) o.endBody = !!Number(f.value);
  }
  return o;
}

function decodeServiceFrame(buf) {
  const fields = parseProto(buf);
  const o = { streamId: Number(fields.find((f) => f.field === 1)?.value ?? 0n) };
  for (const f of fields) {
    if (f.field === 2) o.request = decodeAppResponse(f.value);
    else if (f.field === 3) o.response = decodeAppResponse(f.value);
    else if (f.field === 4) {
      o.bodyChunk = {};
      for (const g of parseProto(f.value)) {
        if (g.field === 1) o.bodyChunk.data = g.value;
        if (g.field === 2) o.bodyChunk.endBody = !!Number(g.value);
      }
    } else if (f.field === 5) {
      o.reset = {};
      for (const g of parseProto(f.value)) {
        if (g.field === 1) o.reset.code = Number(g.value);
        if (g.field === 2) o.reset.reason = g.value.toString();
      }
    }
  }
  return o;
}

module.exports = {
  XX,
  PROTOCOL,
  EMPTY,
  encodeAppRequest,
  encodeServiceFrame,
  encodeServiceRequest,
  encodeServiceReset,
  encodeTransportFrame,
  decodeTransportFrame,
  decodeServiceFrame,
};
