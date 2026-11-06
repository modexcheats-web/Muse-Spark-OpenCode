'use strict';

const assert = require('assert');
const { ReasoningStreamParser, splitReasoning } = require('../src/reasoning');
const { buildPrompt } = require('../src/prompt');

function chunked(text, size = 1) {
  const parser = new ReasoningStreamParser();
  const events = [];
  for (let i = 0; i < text.length; i += size) {
    events.push(...parser.push(text.slice(i, i + size)));
  }
  events.push(...parser.flush());
  return { parser, events };
}

function check(name, text, expected) {
  const direct = splitReasoning(text);
  const streamed = chunked(text);
  assert.deepStrictEqual(direct, expected, `${name}: splitReasoning`);
  assert.strictEqual(streamed.parser.reasoning, expected.reasoning, `${name}: streamed reasoning`);
  assert.strictEqual(streamed.parser.content, expected.content, `${name}: streamed content`);
  const eventReasoning = streamed.events
    .filter((e) => e.type === 'reasoning')
    .map((e) => e.text)
    .join('');
  const eventContent = streamed.events
    .filter((e) => e.type === 'content')
    .map((e) => e.text)
    .join('');
  assert.strictEqual(eventReasoning, expected.reasoning, `${name}: event reasoning`);
  assert.strictEqual(eventContent, expected.content, `${name}: event content`);
  console.log(`ok ${name}`);
}

check(
  'muse tags',
  '<muse_reasoning>23 * 47 = 1081. 19 * 12 = 228. 1081 - 228 = 853.</muse_reasoning>\n<muse_answer>853</muse_answer>',
  {
    reasoning: '23 * 47 = 1081. 19 * 12 = 228. 1081 - 228 = 853.',
    content: '853',
  }
);

check('generic tags', '<reasoning>Penso.</reasoning>\n<answer>42</answer>', {
  reasoning: 'Penso.',
  content: '42',
});

check('thinking tag', '<thinking>Analiso.</thinking><answer>ok</answer>', {
  reasoning: 'Analiso.',
  content: 'ok',
});

check('no envelope', 'Apenas a resposta final.', {
  reasoning: '',
  content: 'Apenas a resposta final.',
});

check(
  'missing answer tag',
  '<muse_reasoning>Penso.</muse_reasoning>\nA resposta e 42.',
  {
    reasoning: 'Penso.',
    content: '\nA resposta e 42.',
  }
);

check(
  'missing close tag',
  '<muse_reasoning>Penso sem fechar.',
  {
    reasoning: 'Penso sem fechar.',
    content: '',
  }
);

check(
  'preamble becomes content',
  'Aqui vai:\n<muse_reasoning>Penso.</muse_reasoning>\n<muse_answer>42</muse_answer>',
  {
    reasoning: 'Penso.',
    content: 'Aqui vai:\n42',
  }
);

check(
  'case and attributes',
  '<MUSE_REASONING lang="pt">Penso.</MUSE_REASONING>\n<MUSE_ANSWER>42</MUSE_ANSWER>',
  {
    reasoning: 'Penso.',
    content: '42',
  }
);

check(
  'multiple reasoning blocks',
  '<muse_reasoning>Primeiro.</muse_reasoning>\n<muse_reasoning>Segundo.</muse_reasoning>\n<muse_answer>Fim</muse_answer>',
  {
    reasoning: 'Primeiro.Segundo.',
    content: 'Fim',
  }
);

check(
  'answer before reasoning is content',
  '<answer>42</answer>',
  {
    reasoning: '',
    content: '42',
  }
);

const promptWithReasoning = buildPrompt(
  { messages: [{ role: 'user', content: 'Qual e a resposta?' }] },
  { reasoning: true }
);
assert(
  promptWithReasoning.includes('<muse_reasoning>') &&
    promptWithReasoning.includes('<muse_answer>'),
  'buildPrompt should include the reasoning envelope when enabled'
);
const promptWithoutReasoning = buildPrompt(
  { messages: [{ role: 'user', content: 'Qual e a resposta?' }] },
  { reasoning: false }
);
assert(
  !promptWithoutReasoning.includes('<muse_reasoning>'),
  'buildPrompt should omit the reasoning envelope when disabled'
);
console.log('ok prompt format');

console.log('ok: true');
