'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalTools, ToolError } = require('../src/tools');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tools-'));
const tools = new LocalTools({ workspaceRoot: root, enableShell: true, logger: { info() {} } });

(async () => {
  const results = {};

  results.listEmpty = await tools.execute('workspace.list', {});
  assert.deepStrictEqual(results.listEmpty.entries, []);

  results.write = await tools.execute('workspace.write', {
    path: 'src/hello.txt',
    content: 'linha um\nlinha dois\n',
  });
  results.read = await tools.execute('workspace.read', { path: 'src/hello.txt' });
  assert.strictEqual(results.read.encoding, 'utf8');
  assert.strictEqual(results.read.eof, true);
  assert.strictEqual(results.read.limit, 200);

  results.edit = await tools.execute('workspace.edit', {
    path: 'src/hello.txt',
    old_string: 'linha dois',
    new_string: 'linha editada',
  });
  results.readAfter = await tools.execute('workspace.read', { path: 'src/hello.txt' });
  assert.match(results.readAfter.content, /linha editada/);

  const manyLines = Array.from({ length: 250 }, (_, i) => `linha ${i + 1}`).join('\n');
  await tools.execute('workspace.write', { path: 'src/lines.txt', content: manyLines });
  results.readPage1 = await tools.execute('workspace.read', { path: 'src/lines.txt' });
  assert.strictEqual(results.readPage1.content.split('\n').length, 200);
  assert.strictEqual(results.readPage1.has_more, true);
  assert.strictEqual(results.readPage1.truncated_reason, 'line_limit');
  results.readPage2 = await tools.execute('workspace.read', {
    path: 'src/lines.txt',
    offset: 201,
    limit: 100,
  });
  assert.strictEqual(results.readPage2.has_more, false);
  assert.strictEqual(results.readPage2.eof, true);
  assert.strictEqual(results.readPage2.content.split('\n').length, 50);

  const binary = Buffer.from([0, 1, 2, 3, 255, 0, 65]);
  fs.writeFileSync(path.join(root, 'src', 'bin.dat'), binary);
  results.readBase64 = await tools.execute('workspace.read', {
    path: 'src/bin.dat',
    encoding: 'base64',
  });
  assert.strictEqual(results.readBase64.content, binary.toString('base64'));
  assert.strictEqual(results.readBase64.complete, true);

  const bigBinary = Buffer.alloc(100);
  for (let i = 0; i < bigBinary.length; i++) bigBinary[i] = (i * 7) % 256;
  fs.writeFileSync(path.join(root, 'src', 'big.dat'), bigBinary);
  const base64Page1 = await tools.execute('workspace.read', {
    path: 'src/big.dat',
    encoding: 'base64',
    limit: 48,
  });
  assert.strictEqual(base64Page1.offset, 0);
  assert.strictEqual(base64Page1.bytes, 48);
  assert.strictEqual(base64Page1.complete, false);
  assert.strictEqual(base64Page1.next_offset, 48);
  const base64Page2 = await tools.execute('workspace.read', {
    path: 'src/big.dat',
    encoding: 'base64',
    offset: base64Page1.next_offset,
    limit: 48,
  });
  assert.strictEqual(base64Page2.offset, 48);
  assert.strictEqual(base64Page2.bytes, 48);
  assert.strictEqual(base64Page2.complete, false);
  const base64Page3 = await tools.execute('workspace.read', {
    path: 'src/big.dat',
    encoding: 'base64',
    offset: base64Page2.next_offset,
    limit: 48,
  });
  assert.strictEqual(base64Page3.complete, true);
  assert.strictEqual(base64Page3.next_offset, null);
  results.readBase64Paged = {
    pages: [
      base64Page1.content,
      base64Page2.content,
      base64Page3.content,
    ].join('') === bigBinary.toString('base64'),
    bytes: base64Page1.bytes + base64Page2.bytes + base64Page3.bytes,
  };
  assert.strictEqual(results.readBase64Paged.pages, true);
  assert.strictEqual(results.readBase64Paged.bytes, bigBinary.length);
  try {
    await tools.execute('workspace.read', { path: 'src/bin.dat' });
    results.binaryHint = 'NOT BLOCKED';
    assert.fail('binary read should fail without encoding=base64');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, 'BINARY_FILE');
    assert.match(e.message, /encoding="base64"/);
    results.binaryHint = e.code;
  }

  await tools.execute('workspace.write', { path: 'src/other.js', content: 'const TODO = 1;\n' });
  await tools.execute('workspace.write', { path: 'src/many/a.js', content: 'const a = 1;\n' });
  await tools.execute('workspace.write', {
    path: 'src/many/b.js',
    content: 'const TODO = 2;\n',
  });
  await tools.execute('workspace.write', {
    path: 'src/many/c.txt',
    content: 'TODO in text\n',
  });

  results.glob = await tools.execute('workspace.glob', { pattern: '**/*.js' });
  assert.strictEqual(results.glob.complete, true);
  assert.strictEqual(results.glob.total, 3);
  results.globPage = await tools.execute('workspace.glob', {
    pattern: '**/*.js',
    offset: 1,
    limit: 1,
  });
  assert.strictEqual(results.globPage.matches.length, 1);
  assert.strictEqual(results.globPage.has_more, true);
  assert.strictEqual(results.globPage.next_offset, 2);

  results.grep = await tools.execute('workspace.grep', { pattern: 'TODO', path: 'src' });
  assert.strictEqual(results.grep.complete, true);
  assert.strictEqual(results.grep.total_matches, 3);
  results.grepPage = await tools.execute('workspace.grep', {
    pattern: 'TODO',
    path: 'src',
    limit: 1,
  });
  assert.strictEqual(results.grepPage.matches.length, 1);
  assert.strictEqual(results.grepPage.has_more, true);
  assert.strictEqual(results.grepPage.next_offset, 1);
  results.grepInclude = await tools.execute('workspace.grep', {
    pattern: 'TODO',
    path: 'src',
    include: '**/*.js',
  });
  assert.strictEqual(results.grepInclude.total_matches, 2);
  assert.ok(results.grepInclude.matches.every((match) => match.file.endsWith('.js')));

  await tools.execute('workspace.write', {
    path: 'big/big.txt',
    content: 'x'.repeat(1024 * 1024 + 1),
  });
  results.grepLarge = await tools.execute('workspace.grep', { pattern: 'x', path: 'big' });
  assert.strictEqual(results.grepLarge.complete, false);
  assert.strictEqual(results.grepLarge.truncated_reason, 'file_size_limit');
  assert.strictEqual(results.grepLarge.total_matches_is_lower_bound, true);

  process.env.MUSE_TEST_SECRET = 'should-not-leak';
  results.shell = await tools.execute('shell.exec', {
    command: 'node -e "console.log(process.env.MUSE_TEST_SECRET || \'redacted\'); console.log(40+2)"',
  });
  assert.strictEqual(results.shell.sandboxed, false);
  assert.match(results.shell.stdout, /redacted/);
  assert.match(results.shell.stdout, /42/);
  assert.doesNotMatch(results.shell.stdout, /should-not-leak/);
  delete process.env.MUSE_TEST_SECRET;

  const noShell = new LocalTools({ workspaceRoot: root, enableShell: false, logger: { info() {} } });
  results.shellDisabled = {
    advertised: Object.keys(noShell.commands),
    has: noShell.has('shell.exec'),
  };
  assert.strictEqual(results.shellDisabled.has, false);

  try {
    await tools.execute('workspace.read', { path: '../outside.txt' });
    results.traversal = 'NOT BLOCKED';
    assert.fail('traversal should be blocked');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, 'PATH_OUTSIDE_WORKSPACE');
    results.traversal = e.code;
  }

  fs.rmSync(root, { recursive: true, force: true });
  results.ok = true;
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error(e);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
