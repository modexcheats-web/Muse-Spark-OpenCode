'use strict';

// The Muse web session does not expose a native chain-of-thought stream. When
// reasoning is enabled the proxy asks the model to wrap a short reasoning
// summary in <muse_reasoning> and the final answer in <muse_answer>. This
// parser splits that envelope out of the model text while it streams, and also
// accepts the generic <reasoning>/<thinking>/<answer> tags as a fallback.
const OPEN_TAG = /<(muse_reasoning|muse_answer|reasoning|thinking|answer)(?:\s[^>]*)?>/i;
const CLOSE_TAG = /<\/(muse_reasoning|muse_answer|reasoning|thinking|answer)\s*>/i;
const ANSWER_OR_REASONING =
  /<(muse_answer|muse_reasoning|answer|reasoning|thinking)(?:\s[^>]*)?>/i;
const TAIL = 128;

function kindOf(tag) {
  const name = String(tag || '').toLowerCase();
  if (name === 'muse_reasoning' || name === 'reasoning' || name === 'thinking') {
    return 'reasoning';
  }
  if (name === 'muse_answer' || name === 'answer') return 'answer';
  return 'content';
}

class ReasoningStreamParser {
  constructor() {
    this.mode = 'before';
    this.buffer = '';
    this.reasoning = '';
    this.content = '';
  }

  push(chunk) {
    if (chunk == null || chunk === '') return [];
    this.buffer += String(chunk);
    return this.#drain(false);
  }

  flush() {
    return this.#drain(true);
  }

  #emit(type, text, out) {
    if (!text) return;
    if (type === 'reasoning') this.reasoning += text;
    else this.content += text;
    out.push({ type, text });
  }

  #keepTail(out, type) {
    const keep = Math.min(this.buffer.length, TAIL);
    const head = this.buffer.slice(0, this.buffer.length - keep);
    if (head) this.#emit(type, head, out);
    this.buffer = this.buffer.slice(-keep);
  }

  #drain(final) {
    const out = [];
    // Bound the loop so malformed input can never spin forever.
    for (let guard = 0; this.buffer.length > 0 && guard < 10000; guard++) {
      if (this.mode === 'before') {
        const open = OPEN_TAG.exec(this.buffer);
        if (open) {
          const before = this.buffer.slice(0, open.index);
          this.buffer = this.buffer.slice(open.index + open[0].length);
          if (before.trim()) this.#emit('content', before, out);
          this.mode = kindOf(open[1]) === 'answer' ? 'answer' : 'reasoning';
          continue;
        }
        if (final) {
          this.#emit('content', this.buffer, out);
          this.buffer = '';
          break;
        }
        this.#keepTail(out, 'content');
        break;
      }

      if (this.mode === 'reasoning') {
        const close = CLOSE_TAG.exec(this.buffer);
        const answer = /<(muse_answer|answer)(?:\s[^>]*)?>/i.exec(this.buffer);
        if (answer && (!close || answer.index < close.index)) {
          const before = this.buffer.slice(0, answer.index);
          this.buffer = this.buffer.slice(answer.index + answer[0].length);
          if (before) this.#emit('reasoning', before, out);
          this.mode = 'answer';
          continue;
        }
        if (close) {
          const before = this.buffer.slice(0, close.index);
          this.buffer = this.buffer.slice(close.index + close[0].length);
          if (before) this.#emit('reasoning', before, out);
          this.mode = 'after_reasoning';
          continue;
        }
        if (final) {
          this.#emit('reasoning', this.buffer, out);
          this.buffer = '';
          break;
        }
        this.#keepTail(out, 'reasoning');
        break;
      }

      if (this.mode === 'after_reasoning') {
        const open = ANSWER_OR_REASONING.exec(this.buffer);
        if (open) {
          const before = this.buffer.slice(0, open.index);
          this.buffer = this.buffer.slice(open.index + open[0].length);
          if (before.trim()) this.#emit('content', before, out);
          this.mode = kindOf(open[1]) === 'answer' ? 'answer' : 'reasoning';
          continue;
        }
        if (final) {
          this.#emit('content', this.buffer, out);
          this.buffer = '';
          break;
        }
        this.#keepTail(out, 'content');
        break;
      }

      if (this.mode === 'answer') {
        const close = CLOSE_TAG.exec(this.buffer);
        if (close) {
          const before = this.buffer.slice(0, close.index);
          this.buffer = this.buffer.slice(close.index + close[0].length);
          if (before) this.#emit('content', before, out);
          this.mode = 'done';
          continue;
        }
        if (final) {
          this.#emit('content', this.buffer, out);
          this.buffer = '';
          break;
        }
        this.#keepTail(out, 'content');
        break;
      }

      // done: ignore any leftover envelope closing tag; other text is content.
      const close = CLOSE_TAG.exec(this.buffer);
      if (close) {
        const before = this.buffer.slice(0, close.index);
        this.buffer = this.buffer.slice(close.index + close[0].length);
        if (before) this.#emit('content', before, out);
        continue;
      }
      if (final) {
        this.#emit('content', this.buffer, out);
        this.buffer = '';
        break;
      }
      this.#keepTail(out, 'content');
      break;
    }
    return out;
  }
}

function splitReasoning(text) {
  const parser = new ReasoningStreamParser();
  parser.push(text || '');
  parser.flush();
  return { reasoning: parser.reasoning, content: parser.content };
}

module.exports = { ReasoningStreamParser, splitReasoning };
