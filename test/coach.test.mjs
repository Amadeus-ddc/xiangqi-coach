import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Script } from 'node:vm';
import { Rules, START_FEN, engineFen } from '../server/rules.mjs';
import { Engine, parseInfo } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';
import { GameService } from '../server/game.mjs';
import { createServer, BOARD_URI } from '../server/mcp.mjs';
import { startHttp } from '../server/main.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rules = new Rules();
class DeterministicEngine {
  calls = [];
  async analyze(options) {
    this.calls.push(options);
    const position = await rules.inspect(options.initialFen, options.moves);
    const selected = options.searchMoves?.length ? options.searchMoves : position.legalMoves.slice(0, options.multiPV ?? 3).map(move => move.uci);
    return { engine: 'test fixture', bestmove: selected[0], requestedMs: options.movetime, lines: selected.map((uci, i) => ({ rank: i + 1, depth: 10, score: { type: 'cp', value: 20 - i, bound: 'exact', perspective: 'side_to_move' }, pv: [uci] })) };
  }
  close() {}
}
async function fixture(t, engine = new DeterministicEngine()) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-coach-test-'));
  const store = new Store(directory);
  const service = new GameService({ rules, store, engine, movetime: 150 });
  t.after(async () => { engine.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, engine, directory };
}
const args = (game, requestId, extra = {}) => ({ gameId: game.id, expectedVersion: game.version, requestId, ...extra });

test('opening has 44 legal moves and authentic Chinese notation', async () => {
  const position = await rules.inspect(START_FEN);
  assert.equal(position.legalCount, 44);
  assert.equal(position.pieces.e0, 'rK');
  assert.equal(position.legalMoves.find(move => move.uci === 'h2e2').chinese, '炮二平五');
  assert.equal((await rules.inspect(START_FEN, ['h2e2'])).turn, 'b');
});
test('regression: reject diagonal rook, wrong side, out-of-board, no-op, own capture and second red move', async () => {
  for (const move of ['a0b1', 'a9a8', 'h2z2', 'h2h2', 'h2b2']) await assert.rejects(rules.inspect(START_FEN, [move]), /不合法/);
  await assert.rejects(rules.inspect(START_FEN, ['h2e2', 'b0c2']), /不合法/);
});
test('Chinese, full-width and half-width notation select the same legal move', async () => {
  const afterRed = await rules.inspect(START_FEN, ['h2e2']);
  for (const text of ['马８进７', '马8进7', '馬八進七']) assert.equal((await rules.resolveMove(afterRed.fen, text)).move.uci, 'h9g7');
  assert.equal((await rules.resolveMove(START_FEN, '炮2平5')).move.uci, 'h2e2');
});
test('malformed and impossible FEN rejected before reaching engine', async () => {
  for (const fen of ['invalid r', '9/9/9/9/9/9/9/9/9/9 r', START_FEN.replace(' r', ' q'), '4k4/9/9/9/9/9/9/9/9/4K4 r', START_FEN.replace('RNBAKABNR', 'RNBQKABNR')]) await assert.rejects(rules.inspect(fen));
});
test('flying generals and self-check cannot be exposed', async () => {
  const fen = '4k4/9/9/9/4P4/9/9/9/9/4K4 r';
  await assert.rejects(rules.inspect(fen, ['e5d5']), /不合法/);
  assert.ok((await rules.inspect(fen)).legalMoves.some(move => move.uci === 'e5e6'));
});
test('checkmate and stalemate both lose, with distinct reasons', async () => {
  const mate = await rules.inspect('4k4/3RR2N1/9/9/9/9/9/9/9/5K3 b');
  assert.equal(mate.terminal, true); assert.equal(mate.endReason, 'checkmate'); assert.equal(mate.winner, 'r');
  const stale = await rules.inspect('4k4/3R1R3/9/9/9/9/9/9/9/5K3 b');
  assert.equal(stale.terminal, true); assert.equal(stale.endReason, 'stalemate');
});
test('engine format preserves n/b pieces; score parser keeps mate, bounds and perspective', () => {
  assert.equal(engineFen(START_FEN), START_FEN.replace(/ r$/, ' w - - 0 1'));
  assert.deepEqual(parseInfo('info depth 18 score mate -3 lowerbound pv e9d9 d0d8').score, { type: 'mate', value: -3, bound: 'lowerbound', perspective: 'side_to_move' });
  assert.equal(parseInfo('info string NNUE loaded'), null);
  assert.equal(parseInfo('info depth 4 score cp -42 wdl 1 200 799 pv h9g7').wdl.loss, 799);
});
test('new game is idempotent and does not overwrite other games', async t => {
  const { service } = await fixture(t);
  const a = await service.newGame({ requestId: 'start-one', autoReply: false });
  const b = await service.newGame({ requestId: 'start-one', autoReply: false });
  assert.equal(a.game.id, b.game.id); assert.equal(b.duplicate, true);
  await assert.rejects(service.newGame({ requestId: 'start-one', playerSide: 'b', autoReply: false }), /请求编号/);
  await service.newGame({ requestId: 'start-two', autoReply: false });
  assert.equal((await service.store.list()).length, 2);
});
test('one click commits player plus coach; retry never plays twice', async t => {
  const { service } = await fixture(t);
  const initial = await service.newGame({ requestId: 'one-click' });
  const request = args(initial.game, 'move-one', { move: '炮二平五' });
  const result = await service.play(request);
  assert.equal(result.game.moves.length, 2); assert.equal(result.position.turn, 'r'); assert.equal(result.game.version, 1);
  assert.equal(result.game.lastLesson.userMove.played.chinese, '炮二平五');
  assert.equal(result.game.lastLesson.engineMove.rootTurn, 'b');
  const retry = await service.play(request);
  assert.equal(retry.game.moves.length, 2); assert.equal(retry.duplicate, true);
  await assert.rejects(service.engineReply(args(result.game, 'double-reply')), /轮到你/);
});
test('illegal and stale requests do not mutate position or run analysis', async t => {
  const { service, engine } = await fixture(t);
  const initial = await service.newGame({ requestId: 'illegal-click', autoReply: false });
  await assert.rejects(service.play(args(initial.game, 'illegal-move', { move: 'h2z2' })), /合法走法/);
  assert.equal(engine.calls.length, 0);
  const next = await service.play(args(initial.game, 'valid-move', { move: 'h2e2' }));
  await assert.rejects(service.play(args(initial.game, 'stale-move', { move: 'b0c2' })), /棋局已经更新/);
  assert.equal((await service.read(initial.game.id)).game.fen, next.game.fen);
});
test('separate connections serialize writes and only one stale click succeeds', async t => {
  const { service, directory } = await fixture(t);
  const anotherStore = new Store(directory);
  const another = new GameService({ rules, store: anotherStore, engine: new DeterministicEngine() });
  t.after(() => anotherStore.close());
  const initial = await service.newGame({ requestId: 'concurrency' });
  const results = await Promise.allSettled([
    service.play(args(initial.game, 'first-click', { move: 'h2e2' })),
    another.play(args(initial.game, 'second-click', { move: 'b0c2' })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await service.read(initial.game.id)).game.moves.length, 2);
});
test('failed engine reply rolls back the entire exchange', async t => {
  const { service, engine } = await fixture(t);
  const initial = await service.newGame({ requestId: 'engine-error' });
  const analyze = engine.analyze.bind(engine);
  engine.analyze = options => { if (options.moves?.length) throw new Error('fixture failure'); return analyze(options); };
  await assert.rejects(service.play(args(initial.game, 'failed-move', { move: 'h2e2' })), /fixture failure/);
  const result = await service.read(initial.game.id);
  assert.equal(result.game.version, 0); assert.equal(result.game.fen, START_FEN); assert.equal(result.game.moves.length, 0);
});
test('specified move outside candidates receives its own search and evidence', async t => {
  const { service, engine } = await fixture(t);
  const initial = await service.newGame({ requestId: 'forced-search', autoReply: false });
  const { analysis } = await service.analyze({ gameId: initial.game.id, candidate: 'h2h9' });
  assert.equal(analysis.candidateSearch, true);
  assert.deepEqual(engine.calls.at(-1).searchMoves, ['h2h9']);
  assert.equal(analysis.played.steps[0].captured, 'bN');
  assert.equal(analysis.played.materialBefore.b.N - analysis.played.materialAfter.b.N, 1);
  assert.equal((await service.read(initial.game.id)).game.version, 0);
});
test('hypothetical line and historical analysis preserve the real game', async t => {
  const { service } = await fixture(t);
  const initial = await service.newGame({ requestId: 'preview-only' });
  const played = await service.play(args(initial.game, 'play-preview', { move: 'h2e2' }));
  const preview = await service.preview({ gameId: initial.game.id, ply: 0, moves: ['b0c2', 'h9g7'] });
  assert.equal(preview.hypothetical, true); assert.notEqual(preview.position.fen, played.game.fen);
  const analysis = await service.analyze({ gameId: initial.game.id, ply: 0, candidate: 'b0c2' });
  assert.equal(analysis.analysis.rootFen, START_FEN);
  assert.equal((await service.read(initial.game.id)).game.fen, played.game.fen);
});
test('undo restores exact position, increments version, and survives process reopen', async t => {
  const { service, directory } = await fixture(t);
  const initial = await service.newGame({ requestId: 'save-undo' });
  const next = await service.play(args(initial.game, 'move-undo', { move: 'h2e2' }));
  const undone = await service.undo(args(next.game, 'undo-one'));
  assert.equal(undone.game.fen, START_FEN); assert.equal(undone.game.version, 2); assert.equal(undone.game.lastLesson, null);
  const fresh = new Store(directory);
  assert.equal((await fresh.load(initial.game.id)).fen, START_FEN); fresh.close();
});
test('black player gets a red opening move, and manual reply is explicit', async t => {
  const { service } = await fixture(t);
  const black = await service.newGame({ requestId: 'play-black', playerSide: 'b' });
  assert.equal(black.game.moves.length, 1); assert.equal(black.position.turn, 'b');
  const manual = await service.newGame({ requestId: 'manual-game', autoReply: false });
  const next = await service.play(args(manual.game, 'manual-play', { move: 'h2e2' }));
  assert.equal(next.game.moves.length, 1);
  const replied = await service.engineReply(args(next.game, 'manual-reply'));
  assert.equal(replied.game.moves.length, 2);
});
test('repetition is paused for adjudication, not falsely declared a draw', async t => {
  const { service, store } = await fixture(t);
  const initial = await service.newGame({ requestId: 'repetition' });
  const game = await store.load(initial.game.id);
  game.moves = [{ fen: START_FEN }, { fen: START_FEN }];
  service.updateStatus(game, initial.position);
  assert.equal(game.status, 'review_required'); assert.equal(game.result.winner, undefined);
});
test('export round-trips through the original notebook PGN parser', async t => {
  const { service, directory } = await fixture(t);
  const initial = await service.newGame({ requestId: 'export-pgn' });
  const played = await service.play(args(initial.game, 'pgn-play', { move: 'h2e2' }));
  const exported = await service.export({ gameId: initial.game.id });
  const main = resolve(directory, 'main.swift');
  await writeFile(main, 'import Foundation\nlet text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!\nlet games = PGNParser.parseFile(text)\nlet fens = PGNParser.generateFenSequence(games[0])!\nprint(String(data: try! JSONSerialization.data(withJSONObject: fens), encoding: .utf8)!)\n');
  const production = ['PGNParser', 'GameObject', 'Utils'].map(name => fileURLToPath(new URL(`./fixtures/notebook/${name}.swift`, import.meta.url)));
  const core = ['BoardUtils', 'MoveRules', 'Move', 'FenObject', 'PathConfig'].map(name => fileURLToPath(new URL(`../native/core/${name}.swift`, import.meta.url)));
  const binary = resolve(directory, 'pgn-roundtrip');
  execFileSync('xcrun', ['swiftc', ...core, ...production, main, '-o', binary], { stdio: ['ignore', 'pipe', 'pipe'] });
  const fens = JSON.parse(execFileSync(binary, { input: exported.pgn, encoding: 'utf8' }));
  assert.equal(fens.length, 3);
  assert.equal(fens.at(-1).split(' ').slice(0, 2).join(' '), played.game.fen);
  assert.match((await service.export({ gameId: initial.game.id, format: 'iccs' })).pgn, /H2-E2/);
});
test('real Pikafish concurrent searches return legal lines for their own positions', async t => {
  const engine = new Engine(); t.after(() => engine.close());
  const evaluations = await Promise.all([
    engine.analyze({ initialFen: START_FEN, movetime: 200 }),
    engine.analyze({ initialFen: START_FEN, moves: ['h2e2'], searchMoves: ['h9g7'], multiPV: 1, movetime: 200 }),
  ]);
  assert.ok((await rules.inspect(START_FEN)).legalMoves.some(move => move.uci === evaluations[0].bestmove));
  assert.equal(evaluations[1].bestmove, 'h9g7'); assert.equal(evaluations[1].rootTurn, 'b');
  await rules.inspect(START_FEN, ['h2e2', ...evaluations[1].lines[0].pv]);
});
test('real engine play returns fully rechecked teaching evidence', async t => {
  const { service } = await fixture(t, new Engine());
  const initial = await service.newGame({ requestId: 'real-engine-game' });
  const result = await service.play(args(initial.game, 'real-game-move', { move: 'h2e2' }));
  assert.equal(result.game.moves.length, 2); assert.equal(result.position.turn, 'r');
  for (const evidence of Object.values(result.game.lastLesson)) {
    assert.match(evidence.engine, /Pikafish/);
    for (const line of evidence.candidates) {
      assert.equal((await rules.inspect(evidence.rootFen, line.steps.map(step => step.uci))).fen, line.finalFen);
    }
  }
});
test('MCP exposes UI resource and separate data tools with correct annotations', async t => {
  const { service } = await fixture(t);
  const server = createServer(service), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 21);
  assert.equal(tools.find(tool => tool.name === 'show_board')._meta.ui.resourceUri, BOARD_URI);
  assert.equal(tools.find(tool => tool.name === 'play_move')._meta.ui.resourceUri, undefined);
  assert.equal(tools.find(tool => tool.name === 'play_move').annotations.readOnlyHint, false);
  const resource = await client.readResource({ uri: BOARD_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /象棋教练/);
  const inlineScript = resource.contents[0].text.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Script(inlineScript));
  const created = await client.callTool({ name: 'new_game', arguments: { requestId: 'mcp-create', autoReply: false } });
  assert.equal(created.structuredContent.position.legalCount, 44);
  assert.equal((await client.callTool({ name: 'read_game', arguments: { gameId: '../unsafe' } })).isError, true);
});
test('HTTP requires bearer auth and rejects cross-origin requests and DNS rebinding', async t => {
  const { service } = await fixture(t);
  const server = await startHttp({ service, port: 0, token: 'test-only-token', dev: true });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/mcp', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/dev/call', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/health', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(reboundStatus, 403);
  const client = new Client({ name: 'http-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test-only-token' } } }));
  assert.equal((await client.listTools()).tools.length, 21); await client.close();
});
test('stdio starts from an unrelated working directory and speaks only MCP on stdout', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-stdio-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server/main.mjs', import.meta.url)), '--stdio'], cwd: directory, env: { ...process.env, XIANGQI_DATA_DIR: directory }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 21); await client.close();
});
