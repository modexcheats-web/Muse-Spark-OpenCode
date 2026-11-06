'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GatewayError } = require('./muse-gateway');
const { finalMessageText } = require('./prompt');
const { listNodes, isUuid, pickProxyNode } = require('./muse-nodes');

const CAPABILITIES = [
  'chat_cancel',
  'delta_stream',
  'custom_reactions',
  'custom_reactions_facebook_thumbs_up_v1',
];

function oneLine(value, max = 400) {
  return String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, max);
}

class MuseChat extends EventEmitter {
  constructor({
    gateway,
    logger = console,
    deviceId,
    deviceFile = null,
    sessionId = null,
    primarySessionId = null,
    timeoutMs = 180000,
    tools = null,
  }) {
    super();
    this.gateway = gateway;
    this.logger = logger;
    this.deviceId = deviceId || process.env.MUSE_DEVICE_ID || null;
    this.deviceFile =
      deviceFile || process.env.MUSE_DEVICE_FILE || path.join(process.cwd(), '.muse-device.json');
    this.deviceResolved = false;
    this.deviceResolvePromise = null;
    this.sessionId = sessionId || process.env.MUSE_SESSION_ID || null;
    this.primarySessionId = primarySessionId || process.env.MUSE_PRIMARY_SESSION_ID || null;
    this.timeoutMs = timeoutMs;
    this.tools = tools;
    this.registeredDeviceId = null;
    this.invokeChain = Promise.resolve();
    this.sub = null;
    this.subSessionId = null;
    this.subscribing = null;
    this.subscribingSessionId = null;
    this.turn = null;
    this.lastAckSessionId = null;
    gateway.on('close', (err) => {
      this.sub = null;
      this.subSessionId = null;
      this.subscribing = null;
      this.subscribingSessionId = null;
      this.registeredDeviceId = null;
      if (this.turn) this.turn.fail(err);
    });
  }

  #closeSubscription() {
    try {
      this.sub?.close();
    } catch {
      /* ignore */
    }
    this.sub = null;
    this.subSessionId = null;
  }

  #subscriptionParams(sessionId) {
    const params = {
      after_stream_seq: 0,
      after_chat_event_seq: 0,
      capabilities: CAPABILITIES,
    };
    // The primary chat is addressed without session_id. Thread chats need it,
    // otherwise the server acknowledges the subscription but sends no events.
    if (sessionId && sessionId !== this.primarySessionId) {
      params.session_id = sessionId;
    }
    return params;
  }

  async #ensureSubscription(sessionId) {
    const want = sessionId || null;
    if (this.sub && this.subSessionId === want) return this.sub;
    if (this.subscribing && this.subscribingSessionId === want) return this.subscribing;

    this.#closeSubscription();
    this.subscribingSessionId = want;
    this.subscribing = (async () => {
      await this.gateway.connect();
      const sub = this.gateway.openSubscription(
        'POST',
        '/chat/subscribe',
        this.#subscriptionParams(want),
        {
          timeoutMs: 30000,
          onRecord: (record) => this.#onRecord(record),
        }
      );
      try {
        await sub.ack;
        this.sub = sub;
        this.subSessionId = want;
        // Register the device commands on the connection that owns this
        // subscription. A thread gets its own client node, so registering
        // once on the primary chat is not enough.
        await this.#registerDeviceCommands();
        return sub;
      } catch (e) {
        try {
          sub.close();
        } catch {
          /* ignore */
        }
        throw e;
      }
    })().finally(() => {
      this.subscribing = null;
      this.subscribingSessionId = null;
    });
    return this.subscribing;
  }

  #onRecord(record) {
    if (!record || record.type !== 'event') return;
    this.emit('event', record);
    if (record.event === 'client.invoke' && record.payload) {
      this.#handleInvoke(record.payload);
    }
    if (this.turn) {
      try {
        this.turn.onEvent(record);
      } catch (e) {
        this.logger.error?.('[muse] turn handler error:', e);
      }
    }
  }

  #handleInvoke(payload) {
    const invokeId = payload.invoke_id;
    const commandId = payload.command_id;
    if (!invokeId || !commandId) {
      this.logger.warn?.('[muse] client.invoke without invoke_id/command_id');
      return;
    }
    const run = async () => {
      this.emit('tool-call', { invokeId, commandId, paramsJson: payload.params_json });
      let params = {};
      try {
        params = payload.params_json ? JSON.parse(payload.params_json) : {};
      } catch (e) {
        await this.#sendInvokeError(invokeId, 'INVALID_PARAMS', `params_json is not valid JSON: ${e.message}`);
        return;
      }
      if (!this.tools || !this.tools.has(commandId)) {
        await this.#sendInvokeError(invokeId, 'UNKNOWN_TOOL', `The local proxy does not provide ${commandId}.`);
        return;
      }
      try {
        const result = await this.tools.execute(commandId, params);
        await this.#sendInvokeResult(invokeId, result);
        this.emit('tool-result', { invokeId, commandId, ok: true });
      } catch (e) {
        const code = e.code || 'TOOL_ERROR';
        const message = e.message || String(e);
        this.logger.warn?.(`[muse] tool ${commandId} failed:`, message);
        await this.#sendInvokeError(invokeId, code, message);
        this.emit('tool-result', { invokeId, commandId, ok: false, code, message });
      }
    };
    this.invokeChain = this.invokeChain
      .then(run, run)
      .catch((e) => this.logger.error?.('[muse] invoke handler error:', e));
  }

  async #sendInvokeResult(invokeId, result) {
    await this.gateway.request(
      'POST',
      '/client/invoke-result',
      {
        invoke_id: invokeId,
        ok: true,
        payload_json: JSON.stringify(result ?? null),
      },
      { timeoutMs: 20000 }
    );
  }

  async #sendInvokeError(invokeId, code, message) {
    try {
      await this.gateway.request(
        'POST',
        '/client/invoke-result',
        {
          invoke_id: invokeId,
          ok: false,
          error: { code, message },
        },
        { timeoutMs: 20000 }
      );
    } catch (e) {
      this.logger.warn?.('[muse] could not send invoke error:', e.message);
    }
  }

  async #registerDeviceCommands() {
    if (!this.tools) return;
    const clientId = await this.#resolveDeviceId();
    const payload = {
      client_id: clientId,
      platform: 'web',
      display_name: 'Muse Local Proxy',
      version: '0.0.0',
      capabilities: {
        data_sources: {},
        device_commands: this.tools.commands,
        hatch_app_commands: {},
        rendering: {
          supported_presentations: [],
          supported_inline_presentations: [],
          supported_text_entities: [],
        },
      },
    };
    try {
      const res = await this.gateway.request('POST', '/client/register-capabilities', payload, {
        timeoutMs: 20000,
      });
      this.registeredDeviceId = clientId;
      this.emit('capabilities', res.json);
      this.logger.info?.(
        `[muse] local device commands registered: ${JSON.stringify(res.json).slice(0, 300)}`
      );
    } catch (e) {
      this.logger.warn?.(`[muse] could not register local device commands: ${e.message}`);
    }
  }

  #readPersistedDevice() {
    try {
      if (!fs.existsSync(this.deviceFile)) return null;
      const data = JSON.parse(fs.readFileSync(this.deviceFile, 'utf8'));
      const id = data?.device_id ?? data?.deviceId ?? null;
      if (isUuid(id)) return id;
      this.logger.warn?.(`[muse] ignoring invalid device id in ${this.deviceFile}`);
    } catch (e) {
      this.logger.warn?.(`[muse] could not read ${this.deviceFile}: ${e.message}`);
    }
    return null;
  }

  #persistDevice(id) {
    try {
      fs.mkdirSync(path.dirname(this.deviceFile), { recursive: true });
      const tmp = `${this.deviceFile}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify(
          {
            device_id: id,
            display_name: 'Muse Local Proxy',
            updated_at: new Date().toISOString(),
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      fs.renameSync(tmp, this.deviceFile);
    } catch (e) {
      this.logger.warn?.(`[muse] could not persist device id to ${this.deviceFile}: ${e.message}`);
    }
  }

  /**
   * Resolves the client node id once and keeps it stable across restarts.
   *
   * Order: MUSE_DEVICE_ID (only if it is a UUID) -> .muse-device.json ->
   * an existing "Muse Local Proxy" node -> a new random UUID. History is not
   * used because it can contain ids from other browser clients.
   */
  async #resolveDeviceId() {
    if (this.deviceResolved && this.deviceId) return this.deviceId;
    if (this.deviceResolvePromise) return this.deviceResolvePromise;
    this.deviceResolvePromise = this.#resolveDeviceIdUncached().finally(() => {
      this.deviceResolvePromise = null;
    });
    return this.deviceResolvePromise;
  }

  async #resolveDeviceIdUncached() {
    const select = (id, source) => {
      this.deviceId = id;
      this.deviceResolved = true;
      this.#persistDevice(id);
      this.logger.info?.(`[muse] device id: ${id} (${source})`);
      return id;
    };

    if (this.deviceId) {
      if (isUuid(this.deviceId)) return select(this.deviceId, 'MUSE_DEVICE_ID');
      this.logger.warn?.(
        `[muse] ignoring invalid MUSE_DEVICE_ID ${JSON.stringify(this.deviceId)}; ` +
          'expected a UUID. The proxy will use the saved device or an online node.'
      );
      this.deviceId = null;
    }

    const saved = this.#readPersistedDevice();
    if (saved) return select(saved, 'saved device file');

    try {
      const nodes = await listNodes(this.gateway, { timeoutMs: 20000 });
      const node = pickProxyNode(nodes);
      if (node) return select(node.node_id, `Muse node (${node.online ? 'online' : 'offline'})`);
    } catch (e) {
      this.logger.warn?.(`[muse] could not list Muse nodes: ${e.message}`);
    }

    return select(crypto.randomUUID(), 'new');
  }

  async #fetchLastAssistantText(sessionId) {
    const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    const res = await this.gateway.request('GET', `/chat/history${query}`, null, {
      timeoutMs: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const events = res.json?.result?.chat_events ?? res.json?.chat_events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.event_name !== 'message.assistant') continue;
      if (typeof ev.display_text === 'string' && ev.display_text.length > 0) {
        return ev.display_text;
      }
    }
    return '';
  }

  async connect() {
    await this.gateway.connect();
    await this.#resolveDeviceId();
  }

  /**
   * Sends a prompt and waits for the complete assistant text.
   *
   * `fresh: true` means `sessionId` is a brand new thread. The thread only
   * exists after `chat.stream`, so the event subscription is opened right
   * after the ack. The replay from seq 0 catches anything the agent emitted
   * before the subscription was ready.
   *
   * @returns {Promise<{text: string, sessionId: string|null, messageId: string|null}>}
   */
  async complete(
    prompt,
    {
      sessionId = this.sessionId,
      fresh = false,
      timeoutMs = this.timeoutMs,
      onText = null,
      images = [],
    } = {}
  ) {
    await this.connect();
    this.lastAckSessionId = null;

    let resolveReply;
    let rejectReply;
    let settled = false;
    const reply = new Promise((res, rej) => {
      resolveReply = res;
      rejectReply = rej;
    });
    reply.catch(() => {
      /* handled by the awaited path or the outer catch */
    });

    const turn = {
      ackUserId: null,
      userSeq: null,
      assistantId: null,
      assistantSeq: null,
      chunks: [],
      started: false,
      failed: false,
      fresh,
      seenUser: null,
      onEvent: (record) => {
        if (turn.failed) return;
        const payload = record.payload || {};
        const event = record.event;

        if (event === 'message.user') {
          if (!turn.ackUserId) {
            turn.seenUser = { id: payload.message_id, seq: payload.seq };
            return;
          }
          if (payload.message_id === turn.ackUserId) {
            turn.userSeq = payload.seq ?? null;
            return;
          }
          return;
        }

        if (event === 'delta.message_start') {
          const seq = payload.message_seq;
          if (turn.started) return;
          if (turn.userSeq != null && seq != null && seq <= turn.userSeq) return;
          if (turn.userSeq == null && !turn.fresh) return;
          turn.started = true;
          turn.assistantId = payload.message_id || payload.message?.message_id || null;
          turn.assistantSeq = seq ?? null;
          return;
        }

        if (event === 'delta.text_append') {
          if (!turn.started) {
            if (!turn.fresh || !turn.ackUserId) return;
            if (payload.message_id && payload.message_id === turn.ackUserId) return;
            turn.started = true;
            turn.assistantId = payload.message_id || null;
            turn.assistantSeq = payload.message_seq ?? null;
          }
          if (turn.assistantId && payload.message_id && payload.message_id !== turn.assistantId) {
            return;
          }
          if (typeof payload.text === 'string' && payload.text.length > 0) {
            turn.chunks.push(payload.text);
            if (onText) {
              try {
                onText(payload.text);
              } catch (e) {
                this.logger.error?.('[muse] onText handler error:', e);
              }
            }
          }
          return;
        }

        if (event === 'delta.message_done') {
          if (!turn.started) {
            if (!turn.fresh) return;
            if (payload.message_id && payload.message_id === turn.ackUserId) return;
            turn.started = true;
          }
          const seq = payload.message_seq;
          if (turn.userSeq != null && seq != null && seq <= turn.userSeq) return;
          if (
            !turn.fresh &&
            turn.assistantId &&
            payload.message_id &&
            payload.message_id !== turn.assistantId
          ) {
            return;
          }
          turn.finish(payload);
          return;
        }

        if (
          event === 'delta.error' ||
          event === 'error' ||
          (event === 'agent.status' && payload.activity_code === 'error')
        ) {
          turn.fail(
            new GatewayError(`Muse error event: ${JSON.stringify(payload).slice(0, 500)}`, {
              code: 'MUSE_ERROR',
            })
          );
        }
      },
      finish: (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        this.turn = null;
        const streamed = turn.chunks.join('');
        const text = finalMessageText(payload) || streamed;
        const finishWith = (finalText) => {
          if (onText && finalText && finalText !== streamed) {
            if (!streamed) {
              try {
                onText(finalText);
              } catch (e) {
                this.logger.error?.('[muse] onText handler error:', e);
              }
            } else if (finalText.startsWith(streamed)) {
              const rest = finalText.slice(streamed.length);
              if (rest) {
                try {
                  onText(rest);
                } catch (e) {
                  this.logger.error?.('[muse] onText handler error:', e);
                }
              }
            }
          }
          resolveReply({
            text: finalText,
            sessionId:
              payload.session_id ||
              payload.message?.session_id ||
              sessionId ||
              this.sessionId ||
              null,
            messageId:
              payload.message_id || payload.message?.message_id || turn.assistantId || null,
          });
        };

        if (text) {
          finishWith(text);
          return;
        }

        // If the subscription replay only contained `message_done`, the
        // payload may not carry the text. Read the final assistant message
        // from the thread history instead of returning an empty answer.
        this.#fetchLastAssistantText(sessionId)
          .then((historyText) => finishWith(historyText || ''))
          .catch((e) => {
            this.logger.warn?.('[muse] could not read final message from history:', e.message);
            finishWith('');
          });
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        this.turn = null;
        rejectReply(err);
      },
    };
    this.turn = turn;

    const overall = setTimeout(() => {
      turn.fail(
        new GatewayError(
          `Muse did not finish the response within ${Math.round(timeoutMs / 1000)}s`,
          { code: 'TIMEOUT' }
        )
      );
    }, timeoutMs);

    try {
      if (!fresh) {
        await this.#ensureSubscription(sessionId);
      }

      // The Muse web client always sends mixed content as `items`. Text-only
      // requests keep using `message`, which is the shape the proxy has been
      // exercising against the live service.
      const items = [];
      if (images.length > 0) {
        items.push({ type: 'text', text: prompt });
        for (const image of images) {
          items.push({
            type: 'image',
            mime_type: image.mimeType,
            data_base64: image.dataBase64,
            filename: image.filename,
          });
        }
      }
      const ackRes = await this.gateway.request(
        'POST',
        '/chat/stream',
        {
          ...(items.length > 0 ? { items } : { message: prompt }),
          node_id: await this.#resolveDeviceId(),
          ...(sessionId ? { session_id: sessionId } : {}),
          capabilities: CAPABILITIES,
          ...(process.env.MUSE_HIDDEN_PROMPT
            ? { hidden_prompt: process.env.MUSE_HIDDEN_PROMPT }
            : {}),
        },
        { timeoutMs: 60000 }
      );
      const ack = ackRes.json || {};
      turn.ackUserId = ack.message_id || null;
      const ackSessionId = ack.session_id || sessionId || null;
      this.lastAckSessionId = ackSessionId;
      if (ackSessionId) this.sessionId = ackSessionId;
      if (turn.seenUser && turn.seenUser.id === turn.ackUserId) {
        turn.userSeq = turn.seenUser.seq ?? null;
      }
      this.emit('stream-ack', ack);

      if (fresh) {
        await this.#ensureSubscription(ackSessionId);
      }

      const value = await reply;
      return { ...value, sessionId: value.sessionId || ackSessionId || this.sessionId };
    } catch (e) {
      turn.fail(e);
      throw e;
    }
  }

  async deleteSession(sessionId) {
    if (!sessionId || sessionId === this.primarySessionId) return false;
    if (this.subSessionId === sessionId) this.#closeSubscription();
    try {
      await this.gateway.request(
        'POST',
        '/api/session/delete',
        { method: '/api/session/delete', session_id: sessionId },
        { timeoutMs: 20000 }
      );
      return true;
    } catch (e) {
      this.logger.warn?.(`[muse] could not delete thread ${oneLine(sessionId)}: ${oneLine(e.message)}`);
      return false;
    }
  }

  close() {
    this.#closeSubscription();
    this.gateway.close();
  }
}

module.exports = { MuseChat, CAPABILITIES };
