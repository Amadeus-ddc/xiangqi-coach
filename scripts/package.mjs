import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureEngineAssets } from './setup-engine.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await ensureEngineAssets();
await import('./build.mjs');
await mkdir(resolve(root, 'dist/licenses'), { recursive: true });
await cp(resolve(root, 'vendor/pikafish/Copying.txt'), resolve(root, 'dist/licenses/Pikafish-GPL-3.txt'));
await cp(resolve(root, 'data/CCPD-LICENSE.txt'), resolve(root, 'dist/licenses/CCPD-CC-BY-4.0.txt'));
await cp(resolve(root, 'LICENSE'), resolve(root, 'dist/licenses/Xiangqi-Coach-MIT.txt'));
const hashes = {};
for (const name of ['xiangqi-rules', 'pikafish', 'pikafish.nnue', 'board.html']) {
  hashes[name] = createHash('sha256').update(await readFile(resolve(root, 'dist', name))).digest('hex');
}
await writeFile(resolve(root, 'dist/build-info.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.version, hashes }, null, 2) + '\n');
await mkdir(resolve(root, '.runtime/releases'), { recursive: true });
const filename = resolve(root, `.runtime/releases/xiangqi-coach-macos-${process.arch}.tar.gz`);
execFileSync('tar', ['--exclude=node_modules/.cache', '--exclude=vendor/pikafish/.git', '-czf', filename,
  '.agents', '.github', '.codex-plugin', '.mcp.json', 'skills', 'server', 'data', 'web', 'scripts', 'native', 'test', 'vendor', 'dist',
  'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY.md', 'TIANTIAN_RESEARCH.md', 'CCPD_DATA.md',
  'VALIDATION.md', 'validation', 'docs', 'node_modules'], { cwd: root, stdio: 'inherit' });
console.log(`Runtime archive ready: ${filename}`);
