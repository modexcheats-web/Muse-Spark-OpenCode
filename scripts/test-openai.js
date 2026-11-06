const { readLocalApiKey } = require('./install-opencode-provider');

const base = process.env.PROXY_URL || 'http://127.0.0.1:8790/v1';
const key = readLocalApiKey();
const workspace = process.env.MUSE_WORKSPACE || process.cwd();
const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };

async function chat(body) {
  const t0 = Date.now();
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log('status', res.status, 'in', Date.now() - t0, 'ms');
  console.log(text.slice(0, 4000));
}

const envPrompt = [
  'You are opencode, the coding agent for the user\'s project.',
  `Working directory: ${workspace}`,
].join('\n');

(async () => {
  const mode = process.argv[2] || 'plain';
  if (mode === 'plain') {
    await chat({
      model: 'muse-spark',
      messages: [
        { role: 'system', content: 'Answer in Brazilian Portuguese, short and direct.' },
        { role: 'user', content: 'Diga apenas: PROXY FUNCIONANDO.' },
      ],
    });
  } else if (mode === 'stream') {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'muse-spark',
        stream: true,
        messages: [{ role: 'user', content: 'Conte de 1 a 10, um numero por linha.' }],
      }),
    });
    console.log('status', res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let firstTokenMs = null;
    const t0 = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
      process.stdout.write(decoder.decode(value, { stream: true }));
    }
    console.log('\nfirst byte in', firstTokenMs, 'ms');
  } else if (mode === 'workspace') {
    await chat({
      model: 'muse-spark',
      messages: [
        { role: 'system', content: envPrompt },
        {
          role: 'user',
          content:
            'Use o comando workspace.list na raiz do projeto e depois workspace.read no package.json. ' +
            'Responda apenas com o nome e a versao do pacote.',
        },
      ],
    });
  } else if (mode === 'edit') {
    await chat({
      model: 'muse-spark',
      messages: [
        { role: 'system', content: envPrompt },
        {
          role: 'user',
          content:
            'Crie o arquivo .muse-test.txt com o texto "linha um\\nlinha dois". Depois use workspace.edit ' +
            'para trocar "linha dois" por "linha editada". Depois rode shell.exec com o comando que mostra ' +
            'o conteudo do arquivo. No final, apague o arquivo com shell.exec e responda o que aconteceu.',
        },
      ],
    });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
