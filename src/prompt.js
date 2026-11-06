'use strict';

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text') return part.text ?? '';
        if (part && (part.type === 'image_url' || part.type === 'input_image')) {
          return '[image attachment]';
        }
        if (part && part.type === 'image') return '[image attachment]';
        if (part && part.type === 'input_text') return part.text ?? '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

function renderMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      out.push(`### System instructions\n${textOf(m.content)}`);
    } else if (role === 'user') {
      out.push(`### User\n${textOf(m.content)}`);
    } else if (role === 'assistant') {
      let block = `### Assistant\n${textOf(m.content)}`;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls
          .map((c) => {
            const fn = c.function || c;
            return `- ${fn.name}(${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})})`;
          })
          .join('\n');
        block += `\n[assistant requested tools]\n${calls}`;
      }
      out.push(block.trimEnd());
    } else if (role === 'tool') {
      out.push(`### Tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ''}\n${textOf(m.content)}`);
    } else {
      out.push(`### ${role}\n${textOf(m.content)}`);
    }
  }
  return out.join('\n\n');
}

const LOCAL_TOOLS = [
  '- workspace.list {path?}: list a directory in the local project.',
  '- workspace.read {path, offset?, limit?, encoding?}: read a text file (default 200 lines, max 2000) or a binary file with encoding="base64". Read before editing.',
  '- workspace.write {path, content}: create or overwrite a file.',
  '- workspace.edit {path, old_string, new_string, replace_all?}: replace exact text in a file.',
  '- workspace.glob {pattern, path?, offset?, limit?}: find files by glob, for example **/*.ts. Results are paginated.',
  '- workspace.grep {pattern, include?, path?, offset?, limit?}: search file contents with a JavaScript regular expression. Results are paginated and report whether the scan was complete.',
  '- shell.exec {command, cwd?, timeout_ms?}: run a command in the local project, for tests, builds and git. cwd only sets the starting directory; this is NOT a sandbox and commands can read or write outside the project.',
].join('\n');

function buildPrompt(body, { images = [], reasoning = false } = {}) {
  const system = renderMessages(
    (body.messages || []).filter((m) => m.role === 'system' || m.role === 'developer')
  );
  const conversation = renderMessages(
    (body.messages || []).filter((m) => m.role !== 'system' && m.role !== 'developer')
  );
  const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const task = last ? textOf(last.content).trim() : '';

  const parts = [
    'You are Muse Spark, acting as the coding agent for the user\'s local project through an OpenAI-compatible proxy.',
    'The editor sends you the conversation and returns your final text to the user.',
    '',
    '### Local device commands: the user\'s real project',
    'The project is on the user\'s local machine, NOT inside your VM workspace or sandbox. Your own file tools can only see the VM and will not find the project.',
    'The local proxy exposes these native device commands. Call them directly whenever you need to inspect or change the project:',
    LOCAL_TOOLS,
    'Rules:',
    '- Use workspace.* for every project file and directory. Use shell.exec for tests, builds, git and other project commands.',
    '- When the editor instructions mention its read/write/edit/bash tools, use the matching workspace.* or shell.exec device command instead.',
    '- Read a file before editing it, and keep old_string exact and unique.',
    '- workspace.grep and workspace.glob report complete/truncated, so continue with next_offset when a result is paginated.',
    '- shell.exec is not a sandbox: cwd only sets the starting directory. Do not run destructive commands outside the project.',
    '- Never claim a file was read, changed or a command ran unless the device command result confirms it. If a command fails, read the error and adapt.',
    '- Do not stop after describing what you would do. Run the commands until the task is complete, then write the final answer.',
    '',
    system,
    ...(images.length > 0
      ? [
          '### Attached images',
          images
            .map(
              (image, index) =>
                `- ${image.filename} (${image.mimeType}, ${Math.max(1, Math.round(image.bytes / 1024))} KiB)`
            )
            .join('\n'),
          'The image data is attached to this request as image items. Inspect the images directly; do not ask the user to describe them.',
        ]
      : []),
    '### Conversation',
    conversation || '(empty)',
    '### Your task',
    'Continue the conversation and complete the last user request using the local device commands when needed. Keep the final answer concise and report what actually happened.',
    '### Last user message',
    task || 'Continue the conversation and answer the last user message.',
    ...(reasoning
      ? [
          '### Output format',
          'Before the final answer, write a concise step-by-step reasoning summary in the same language as the user.',
          'Put the reasoning inside <muse_reasoning>...</muse_reasoning>.',
          'Put the final answer inside <muse_answer>...</muse_answer>.',
          'Do not write anything outside those two blocks. The reasoning block is shown to the user as your thinking; keep it factual and brief. The answer block is the final response.',
        ]
      : []),
  ];
  return parts.filter((p) => p && p.trim().length > 0).join('\n\n');
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text' || b?.text != null) return b.text ?? '';
      return '';
    })
    .filter(Boolean)
    .join('');
}

function finalMessageText(payload) {
  const transcript = payload?.transcript;
  if (transcript && Array.isArray(transcript.messages)) {
    const text = transcript.messages
      .filter((m) => !m?.role || m.role === 'assistant')
      .map((m) => textFromContent(m?.content))
      .filter(Boolean)
      .join('');
    if (text) return text;
  }
  const msg = payload?.message ?? payload;
  if (!msg) return '';
  const text = textFromContent(msg.content);
  if (text) return text;
  if (typeof msg.display_text === 'string') return msg.display_text;
  if (Array.isArray(msg.blocks)) {
    return msg.blocks
      .map((b) => (b?.type === 'text' ? b.text ?? '' : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

module.exports = { buildPrompt, finalMessageText, textOf, renderMessages };
