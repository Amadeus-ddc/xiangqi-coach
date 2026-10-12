import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
async function linkedRoot(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-linked-entry-'));
  const link = resolve(directory, 'linked checkout');
  await symlink(root, link, 'dir');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, link };
}

test('stdio entry starts from an absolute symlink path, including a directory with spaces', async t => {
  const { directory, link } = await linkedRoot(t);
  const client = new Client({ name: 'entrypoint regression', version: '0.1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve(link, 'server/main.mjs'), '--stdio'], cwd: link,
      env: { ...process.env, XIANGQI_DATA_DIR: resolve(directory, 'games') }, stderr: 'pipe' }));
    assert.equal((await client.listTools()).tools.length, 21);
  } finally { await client.close(); }
});

test('engine setup entry executes from an absolute symlink path', async t => {
  const { link } = await linkedRoot(t);
  const output = execFileSync(process.execPath, [resolve(link, 'scripts/setup-engine.mjs')], { cwd: link, encoding: 'utf8' });
  assert.match(output, /Verified pikafish\n/); assert.match(output, /Verified pikafish.nnue/);
});
