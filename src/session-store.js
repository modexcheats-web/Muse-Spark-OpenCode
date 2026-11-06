'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { textOf } = require('./prompt');

/**
 * Maps an OpenCode conversation to a Muse thread when MUSE_SESSION_MODE=session.
 *
 * The OpenAI request has no OpenCode session id, so the key is derived from
 * the workspace plus the first user message. That stays stable across turns
 * and does not depend on the system prompt, which OpenCode can change.
 */
class SessionStore {
  constructor(file = path.join(process.cwd(), '.muse-sessions.json'), { maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.file = file;
    this.maxAgeMs = maxAgeMs;
    this.data = { version: 1, sessions: {} };
    this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        this.data = parsed;
      }
    } catch {
      /* missing or malformed; start clean */
    }
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  keyFor(body, workspaceRoot) {
    const messages = body?.messages || [];
    const firstUser = messages.find((m) => m.role === 'user');
    const anchor = firstUser ? textOf(firstUser.content) : '';
    const fallback = messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => textOf(m.content))
      .join('\n');
    const material = [workspaceRoot || '', anchor || fallback].join('\u0000');
    return crypto.createHash('sha256').update(material).digest('hex');
  }

  #prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    let changed = false;
    for (const [key, entry] of Object.entries(this.data.sessions)) {
      if (!entry || !entry.sessionId || (entry.updatedAt || 0) < cutoff) {
        delete this.data.sessions[key];
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  get(key) {
    this.#prune();
    const entry = this.data.sessions[key];
    if (!entry || typeof entry.sessionId !== 'string') return null;
    return { ...entry };
  }

  set(key, sessionId) {
    if (!key || !sessionId) return;
    this.data.sessions[key] = { sessionId, updatedAt: Date.now() };
    this.#save();
  }

  delete(key) {
    if (!key || !this.data.sessions[key]) return;
    delete this.data.sessions[key];
    this.#save();
  }
}

module.exports = { SessionStore };
