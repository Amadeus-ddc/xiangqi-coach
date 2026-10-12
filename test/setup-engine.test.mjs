import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ensureEngineAssets } from '../scripts/setup-engine.mjs';

const bytes = Buffer.from('test engine fixture');
const manifest = { platform: 'darwin', arch: 'arm64', releaseBaseUrl: 'https://example.invalid/release', assets: [
  { name: 'pikafish', releaseAsset: 'pikafish-macos-arm64', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
] };
const options = directory => ({ directory, manifest, platform: 'darwin', arch: 'arm64', onProgress() {} });
const directoryFor = async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-engine-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
};

test('engine setup verifies downloads and reuses only a matching cache', async t => {
  const directory = await directoryFor(t); let calls = 0;
  const fetcher = async url => { calls++; assert.equal(url, 'https://example.invalid/release/pikafish-macos-arm64'); return new Response(bytes); };
  await ensureEngineAssets({ ...options(directory), fetcher });
  assert.deepEqual(await readFile(resolve(directory, 'pikafish')), bytes);
  await ensureEngineAssets({ ...options(directory), fetcher }); assert.equal(calls, 1);
});

test('a tampered download never replaces an existing engine', async t => {
  const directory = await directoryFor(t), path = resolve(directory, 'pikafish');
  await writeFile(path, 'keep the existing file');
  await assert.rejects(ensureEngineAssets({ ...options(directory), fetcher: async () => new Response('corrupt') }), /Checksum or size mismatch/);
  assert.equal(await readFile(path, 'utf8'), 'keep the existing file');
});

test('an unsupported architecture is rejected before downloading', async t => {
  const directory = await directoryFor(t); let fetched = false;
  await assert.rejects(ensureEngineAssets({ ...options(directory), arch: 'x64', fetcher: async () => { fetched = true; } }), /macOS Apple Silicon/);
  assert.equal(fetched, false);
});
