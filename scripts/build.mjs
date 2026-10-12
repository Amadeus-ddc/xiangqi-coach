import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(resolve(root, 'dist'), { recursive: true });
// Keep release binaries usable on the same macOS version exercised by CI;
// otherwise swiftc inherits the maintainer's potentially newer host version.
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos15.0`;
execFileSync('xcrun', ['swiftc', '-O', '-target', target, ...['BoardUtils', 'MoveRules', 'Move', 'FenObject', 'PathConfig'].map(n => resolve(root, `native/core/${n}.swift`)), resolve(root, 'native/main.swift'), '-o', resolve(root, 'dist/xiangqi-rules')], { stdio: 'inherit' });
await build({ entryPoints: [resolve(root, 'web/board.mjs')], bundle: true, format: 'iife', outfile: resolve(root, 'dist/board.js'), target: 'es2022', minify: true });
await build({ entryPoints: [resolve(root, 'web/host.mjs')], bundle: true, format: 'esm', outfile: resolve(root, 'dist/host.js'), target: 'es2022', minify: true });
const html = await readFile(resolve(root, 'web/board.html'), 'utf8');
const js = (await readFile(resolve(root, 'dist/board.js'), 'utf8')).replaceAll('</script', '<\\/script');
// Embed generated textures: MCP Apps resources must work without a web server
// or remote image permissions, including in an offline conversation.
const skin = await build({ entryPoints: [resolve(root, 'web/star-river.css')], bundle: true, write: false,
  loader: { '.jpg': 'dataurl', '.png': 'dataurl' }, minify: true, target: 'es2022' });
const css = await readFile(resolve(root, 'web/board.css'), 'utf8') + '\n' + skin.outputFiles[0].text;
await writeFile(resolve(root, 'dist/board.html'), html.replace('/* BOARD_CSS */', () => css).replace('/* BOARD_JS */', () => js));
console.log('Built native rules and self-contained MCP Apps board.');
