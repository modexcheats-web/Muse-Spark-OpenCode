'use strict';

// Real image test: builds a solid red PNG in memory and asks the proxy to
// describe it. This exercises /v1/chat/completions -> Muse `items` with
// { type: "image", mime_type, data_base64, filename }.

const zlib = require('zlib');
const { readLocalApiKey } = require('./install-opencode-provider');

const base = process.env.PROXY_URL || 'http://127.0.0.1:8790/v1';
const key = readLocalApiKey();
const headers = {
  'content-type': 'application/json',
  ...(key ? { authorization: `Bearer ${key}` } : {}),
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function redPng(size = 128) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = 220; // R
    row[2 + x * 3] = 30; // G
    row[3 + x * 3] = 40; // B
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const png = redPng();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'muse-spark',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Qual é a cor sólida que preenche esta imagem? Responda em uma palavra, em português.',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  console.log('status', res.status, 'in', Date.now() - t0, 'ms');
  console.log(text.slice(0, 4000));
  if (!res.ok) process.exit(1);
  const parsed = JSON.parse(text);
  const answer = parsed?.choices?.[0]?.message?.content || '';
  if (!/vermelh|red/i.test(answer)) {
    console.error(`Resposta não reconheceu a imagem vermelha: ${JSON.stringify(answer)}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
