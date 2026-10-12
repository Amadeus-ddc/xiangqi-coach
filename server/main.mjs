import { createServer as createHttpServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Rules } from './rules.mjs';
import { Engine } from './engine.mjs';
import { Store } from './store.mjs';
import { GameService } from './game.mjs';
import { createServer, toolDefinitions, callTool } from './mcp.mjs';

export function makeService(directory = process.env.XIANGQI_DATA_DIR ?? resolve(homedir(), 'Library/Application Support/XiangqiCoach')) {
  return new GameService({ rules: new Rules(), engine: new Engine(), scoreEngine: new Engine(undefined, { threads: 1, hashMb: 16 }), reviewEngine: new Engine(undefined, { threads: 1, hashMb: 32 }), store: new Store(directory), movetime: Math.max(100, Math.min(5000, Number(process.env.XIANGQI_THINK_MS) || 700)) });
}

async function readJson(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 65536) throw new Error('请求过大。');
  }
  return JSON.parse(data);
}

export async function startHttp({ service, port = 9234, token, dev = false }) {
  const definitions = toolDefinitions(service);
  const server = createHttpServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    try {
      const actualPort = server.address().port;
      const host = `127.0.0.1:${actualPort}`;
      if (req.headers.host !== host && req.headers.host !== `localhost:${actualPort}`) return send(403, { error: 'Host rejected' });
      const origin = req.headers.origin;
      if (origin && ![`http://${host}`, `http://localhost:${actualPort}`].includes(origin)) return send(403, { error: 'Origin rejected' });
      const path = new URL(req.url, `http://${host}`).pathname;
      if (path === '/health' && req.method === 'GET') return send(200, { ok: true, name: 'xiangqi-coach' });
      if (dev && req.method === 'GET' && ['/', '/dev/host.js', '/dev/board.html'].includes(path)) {
        const file = path === '/' ? '../web/host.html' : path === '/dev/host.js' ? '../dist/host.js' : '../dist/board.html';
        return send(200, await readFile(new URL(file, import.meta.url), 'utf8'), path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      }
      // Same-origin development host only. It exercises the very same tools and
      // MCP Apps bridge; it does not pretend to contain a language model.
      if (dev && path === '/dev/call' && req.method === 'POST') {
        if (!origin || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: 'Same-origin JSON required' });
        const { name, arguments: args } = await readJson(req);
        return send(200, await callTool(definitions, name, args));
      }
      if (path !== '/mcp') return send(404, { error: 'Not found' });
      const provided = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(401, { error: 'Authentication required' });
      if (req.method !== 'POST') return send(405, { error: 'Use POST' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = createServer(service);
      res.on('finish', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await readJson(req));
    } catch (error) { if (!res.headersSent) send(400, { error: error.message }); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

async function main() {
  process.umask(0o077);
  const service = makeService();
  if (process.argv.includes('--stdio')) {
    const mcp = createServer(service);
    await mcp.connect(new StdioServerTransport());
    process.stdin.on('end', async () => {
      service.engine.close(); service.insights.scoreEngine.close(); service.reviews.close();
      await Promise.allSettled([...service.reviews.jobs.values(), ...service.insights.scoreRequests.values()]);
      await service.store.queue; service.store.close();
    });
  } else {
    const tokenPath = resolve(service.store.directory, 'http-token');
    let token;
    try { token = (await readFile(tokenPath, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('hex');
      await mkdir(service.store.directory, { recursive: true, mode: 0o700 });
      await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' });
    }
    const http = await startHttp({ service, token, port: Number(process.env.XIANGQI_PORT) || 9234, dev: process.argv.includes('--dev') });
    console.error(`象棋教练已启动：http://127.0.0.1:${http.address().port}${process.argv.includes('--dev') ? '/（本地验收预览）' : '/mcp'}。认证令牌仅保存在本机。`);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.engine.close(); service.insights.scoreEngine.close(); service.reviews.engine.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main().catch(error => { console.error(error.message); process.exit(1); });
