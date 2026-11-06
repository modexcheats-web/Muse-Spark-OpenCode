'use strict';

const fs = require('fs');
const path = require('path');
const { MuseGateway } = require('../src/muse-gateway');

const ROOT = path.join(__dirname, '..');
const COOKIES_FILE = process.env.MUSE_COOKIES_FILE ||
  path.join(ROOT, 'muse.ai.cookies.json');
const OUT = process.env.MUSE_RECORDS_OUT ||
  path.join(ROOT, 'logs', 'records.jsonl');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function localDeviceId() {
  if (process.env.MUSE_DEVICE_ID) return process.env.MUSE_DEVICE_ID;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.muse-device.json'), 'utf8')).device_id || null;
  } catch {
    return null;
  }
}

const CAPS = [
  'chat_cancel',
  'delta_stream',
  'custom_reactions',
  'custom_reactions_facebook_thumbs_up_v1',
];

function cookieFromFile(path) {
  const jar = JSON.parse(fs.readFileSync(path, 'utf8'));
  return jar.map((c) => `${c.name}=${c.value}`).join('; ');
}

(async () => {
  const gateway = new MuseGateway({ cookie: cookieFromFile(COOKIES_FILE) });
  gateway.on('protocol-error', (e) => console.error('PROTOCOL', e.message));
  await gateway.connect();
  console.log('conectado');

  const text = [];
  let assistantId = null;
  let done;
  const finished = new Promise((r) => (done = r));

  const sub = gateway.openSubscription(
    'POST',
    '/chat/subscribe',
    {
      after_stream_seq: 0,
      after_chat_event_seq: 0,
      capabilities: CAPS,
    },
    {
      timeoutMs: 30000,
      onRecord(record) {
        fs.appendFileSync(OUT, JSON.stringify(record) + '\n');
        if (record.type !== 'event') {
          console.log('ACK', JSON.stringify(record).slice(0, 500));
          return;
        }
        const p = record.payload || {};
        if (record.event === 'delta.message_start') {
          const m = p.message || p;
          assistantId = m.message_id || p.message_id || assistantId;
          console.log('START', assistantId);
        } else if (record.event === 'delta.text_append') {
          if (p.text) text.push(p.text);
          console.log('DELTA', JSON.stringify(p.text ?? ''));
        } else if (record.event === 'delta.message_done') {
          console.log('DONE');
          console.log('FINAL', (text.join('') || '(vazio)').slice(0, 500));
          done();
        }
      },
    }
  );
  await sub.ack;
  console.log('subscribe ok');

  await new Promise((r) => setTimeout(r, 3000));

  const prompt = process.argv[2] || 'Reply with exactly three words: PROXY TEST OK. Do not use tools.';
  const nodeId = localDeviceId();
  const t0 = Date.now();
  const ack = await gateway.request(
    'POST',
    '/chat/stream',
    {
      items: [{ type: 'text', text: prompt }],
      ...(nodeId ? { node_id: nodeId } : {}),
      capabilities: CAPS,
    },
    { timeoutMs: 30000 }
  );
  console.log('STREAM ACK', ack.text, 'em', Date.now() - t0, 'ms');

  const timer = setTimeout(() => {
    console.log('TIMEOUT aguardando resposta');
    process.exit(1);
  }, 60000);
  await finished;
  clearTimeout(timer);
  console.log('TEXTO FINAL:', text.join(''));
  gateway.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e);
  process.exit(1);
});
