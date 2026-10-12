import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinned = JSON.parse(await readFile(new URL('../data/engine-manifest.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, asset) => bytes.length === asset.bytes && digest(bytes) === asset.sha256;

export async function ensureEngineAssets({ directory = resolve(root, 'dist'), manifest = pinned, fetcher = globalThis.fetch,
  platform = process.platform, arch = process.arch, onProgress = console.log } = {}) {
  if (platform !== manifest.platform || arch !== manifest.arch) {
    throw new Error('The supplied engine supports macOS Apple Silicon. For another platform, build Pikafish and set XIANGQI_ENGINE and XIANGQI_NNUE; see THIRD_PARTY.md.');
  }
  await mkdir(directory, { recursive: true });
  for (const asset of manifest.assets) {
    const destination = resolve(directory, asset.name);
    let cached;
    try { cached = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cached && matches(cached, asset)) {
      if (asset.name === 'pikafish') await chmod(destination, 0o755);
      onProgress(`Verified ${asset.name}`); continue;
    }
    const url = `${manifest.releaseBaseUrl}/${asset.releaseAsset}`;
    onProgress(`Downloading ${asset.releaseAsset}`);
    const response = await fetcher(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!matches(bytes, asset)) throw new Error(`Checksum or size mismatch: ${asset.name}; no file was installed.`);
    const temporary = `${destination}.${process.pid}.part`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: asset.name === 'pikafish' ? 0o755 : 0o644 });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    onProgress(`Installed and verified ${asset.name}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await ensureEngineAssets();
