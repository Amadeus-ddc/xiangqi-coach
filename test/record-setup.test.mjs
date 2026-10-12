import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Rules, START_FEN } from '../server/rules.mjs';
import { Store } from '../server/store.mjs';
import { GameService } from '../server/game.mjs';
import { toolDefinitions, callTool } from '../server/mcp.mjs';
import { SetupDraft, fenFromPieces, piecesFromFen } from '../web/setup-board.mjs';
import { playTurn } from '../web/turn-flow.mjs';
import { deliverInlineLesson } from '../web/inline-teaching.mjs';
import { needsAutomaticReview } from '../web/review-panel.mjs';

const rules = new Rules();
class FixtureEngine {
  calls = [];
  async analyze(options) {
    this.calls.push(options);
    const position = await rules.inspect(options.initialFen, options.moves);
    const moves = options.searchMoves?.length ? options.searchMoves : position.legalMoves.slice(0, options.multiPV ?? 1).map(move => move.uci);
    return { engine: 'record test fixture', bestmove: moves[0], requestedMs: options.movetime,
      lines: moves.map((uci, i) => ({ rank: i + 1, depth: 10, score: { type: 'cp', value: 0, bound: 'exact', perspective: 'side_to_move' }, pv: [uci] })) };
  }
}
const args = (snapshot, extra = {}) => ({ gameId: snapshot.game.id, expectedVersion: snapshot.game.version, requestId: crypto.randomUUID(), ...extra });
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-record-test-'));
  const store = new Store(directory), engine = new FixtureEngine();
  const service = new GameService({ rules, store, engine, movetime: 100, reviewMs: 100 });
  t.after(async () => { await Promise.allSettled(service.reviews.jobs.values()); await store.queue; store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, engine, directory };
}

test('setup supports arbitrary placement, replacement, removal, side selection and undo without changing the original', () => {
  const setup = new SetupDraft();
  assert.equal(setup.fen, START_FEN);
  assert.equal(fenFromPieces(piecesFromFen(START_FEN), 'r'), START_FEN);
  setup.click('h2'); setup.click('e5');
  assert.equal(setup.pieces.e5, 'rC'); assert.equal(setup.pieces.h2, undefined);
  setup.choose('bN'); setup.click('e5'); assert.equal(setup.pieces.e5, 'bN');
  setup.choose('erase'); setup.click('e5'); assert.equal(setup.pieces.e5, undefined);
  setup.setTurn('b'); assert.ok(setup.fen.endsWith(' b'));
  setup.undo(); setup.undo(); assert.equal(setup.pieces.e5, 'bN');
  setup.undo(); assert.equal(setup.pieces.e5, 'rC');
  setup.undo(); assert.equal(setup.fen, START_FEN);
  setup.replace('9/9/9/9/9/9/9/9/9/9 b'); assert.deepEqual(setup.pieces, {});
  setup.undo(); assert.equal(setup.fen, START_FEN);
});

test('record mode commits both sides without any engine work, even with default autoReply or a legacy play call', async t => {
  const { service, engine } = await fixture(t);
  let snapshot = await service.newGame({ requestId: 'record-both', mode: 'record', playerSide: 'b' });
  assert.equal(snapshot.game.moves.length, 0); assert.equal(snapshot.game.autoReply, false);
  for (const move of ['h2e2', 'h9g7', 'h0g2', 'b9c7']) snapshot = await service.play(args(snapshot, { move }));
  assert.equal(snapshot.game.moves.length, 4); assert.equal(snapshot.game.version, 4);
  assert.deepEqual(snapshot.game.moves.map(move => move.side), ['r', 'b', 'r', 'b']);
  assert.equal(engine.calls.length, 0);
  await assert.rejects(service.engineReply(args(snapshot)), /自由录谱/);
  assert.equal((await service.read(snapshot.game.id)).game.version, 4);
});

test('record mode retains legality, stale-write rejection, idempotency, one-ply undo and persistence', async t => {
  const { service, engine, directory } = await fixture(t);
  const first = await service.newGame({ requestId: 'record-save', mode: 'record' });
  const request = args(first, { move: 'h2e2' });
  const red = await service.play(request);
  assert.equal((await service.play(request)).duplicate, true);
  await assert.rejects(service.play(args(red, { move: 'h0g2' })), /合法走法/);
  await assert.rejects(service.play(args(first, { move: 'h9g7' })), /已经更新/);
  const black = await service.play(args(red, { move: 'h9g7' }));
  const undone = await service.undo(args(black, { plies: 1 }));
  assert.equal(undone.game.fen, red.game.fen); assert.equal(undone.position.turn, 'b');
  const reopened = new Store(directory);
  try { assert.equal((await reopened.load(first.game.id)).mode, 'record'); assert.equal((await reopened.list())[0].mode, 'record'); }
  finally { reopened.close(); }
  const exported = await service.export({ gameId: first.game.id });
  assert.match(exported.pgn, /Event "自由录谱"/); assert.doesNotMatch(exported.pgn, /Pikafish/);
  assert.equal(engine.calls.length, 0);
  await assert.rejects(service.newGame({ requestId: 'record-save', mode: 'play' }), /请求编号/);
});

test('illegal setup never creates a saved game or reaches the engine; black-to-move setup is preserved', async t => {
  const { service, store, engine } = await fixture(t);
  const original = await service.newGame({ requestId: 'setup-original', mode: 'record' });
  const invalid = [
    '9/9/9/9/9/9/9/9/9/9 r',
    '4k4/9/9/9/9/9/9/9/9/4K4 r',
    '4k4/9/9/9/4P4/9/9/9/9/K8 r',
    START_FEN.replace('1C5C1', '1C1C3C1'),
    '4k4/9/9/9/4P4/9/9/9/1B7/5K3 r',
    '4k4/4R4/9/9/9/9/9/9/9/5K3 r',
  ];
  for (const fen of invalid) await assert.rejects(service.newGame({ requestId: crypto.randomUUID(), mode: 'record', fen }));
  assert.equal((await store.list()).length, 1); assert.equal(engine.calls.length, 0);
  const fen = '4k4/9/9/9/4P4/9/9/9/9/5K3 b';
  const custom = await service.newGame({ requestId: 'setup-black', mode: 'record', fen });
  assert.equal(custom.game.initialFen, fen); assert.equal(custom.position.turn, 'b'); assert.equal(custom.game.moves.length, 0);
  assert.equal((await service.read(original.game.id)).game.fen, START_FEN);
  const move = custom.position.legalMoves[0].uci;
  const played = await service.play(args(custom, { move }));
  const lesson = await service.insights.prepare({ ...args(played), kind: 'explain' });
  assert.equal(lesson.evidence.lesson.recordedMove.played.move, move);
  assert.equal(lesson.fromPly, 0); assert.equal(lesson.toPly, 1);
  assert.equal(lesson.evidence.lesson.engineMove, undefined);
});

test('custom position can request and persist a lesson before any moves, including a terminal position', async t => {
  const { service, engine } = await fixture(t);
  const snapshot = await service.newGame({ requestId: 'setup-lesson', mode: 'record', fen: '4k4/9/9/9/4P4/9/9/9/9/5K3 r' });
  const definitions = toolDefinitions(service);
  const prepared = await callTool(definitions, 'prepare_lesson', { ...args(snapshot), kind: 'position' });
  assert.equal(prepared.isError, undefined);
  const lesson = prepared.structuredContent;
  assert.equal(lesson.toPly, 0); assert.equal(lesson.evidence.analysis.rootFen, snapshot.game.fen);
  assert.ok(lesson.evidence.analysis.best.steps.length > 0);
  await service.insights.publish({ gameId: snapshot.game.id, requestId: lesson.requestId, text: '测试讲解正文。' });
  assert.equal((await service.read(snapshot.game.id)).boardLesson.text, '测试讲解正文。');
  assert.equal((await service.read(snapshot.game.id)).game.moves.length, 0);
  const terminal = await service.newGame({ requestId: 'setup-terminal', mode: 'record', fen: '4k4/3RR2N1/9/9/9/9/9/9/9/5K3 b' });
  const calls = engine.calls.length;
  const terminalLesson = await service.insights.prepare({ ...args(terminal), kind: 'position' });
  assert.equal(terminalLesson.evidence.analysis.terminal, true);
  assert.equal(engine.calls.length, calls);
});

test('recorded game reviews every ply and provides summary evidence even without large mistakes', async t => {
  const { service, store } = await fixture(t);
  let snapshot = await service.newGame({ requestId: 'record-review', mode: 'record' });
  for (const move of ['h2e2', 'h9g7', 'h0g2']) snapshot = await service.play(args(snapshot, { move }));
  const before = await store.load(snapshot.game.id);
  const started = await service.reviews.start(args(snapshot));
  await service.reviews.jobs.get(started.id);
  const report = await service.reviews.read({ gameId: snapshot.game.id, reviewId: started.id });
  assert.equal(report.status, 'complete'); assert.equal(report.total, 3); assert.equal(report.rows.length, 3);
  assert.equal(report.gameFinished, false); assert.equal(report.keyTurns.length, 0);
  const lesson = await service.insights.prepare({ ...args(snapshot), kind: 'review', reviewId: report.id });
  assert.equal(lesson.evidence.moves.length, 3); assert.equal(lesson.toPly, 3);
  assert.deepEqual(await store.load(snapshot.game.id), before);
});

test('record UI flow never requests engine reply, even when a stale autoReply flag is true', async () => {
  const initial = { game: { id: 'test', mode: 'record', version: 0, playerSide: 'r', status: 'active', autoReply: true }, position: { turn: 'r', pieces: { h2: 'rC' } } };
  const next = { game: { ...initial.game, version: 1 }, position: { turn: 'b', pieces: { e2: 'rC' } } };
  const calls = [];
  await playTurn({ snapshot: initial, move: { from: 'h2', to: 'e2', uci: 'h2e2' }, requestId: 'record-ui', replyRequestId: 'unused',
    call: async name => { calls.push(name); return next; }, onPreview() {}, onCommit() {}, onPhase() {}, paint() { assert.fail('no coach phase'); } });
  assert.deepEqual(calls, ['play_move']);
});

test('position and record explanations send the correct scope and publish to the original board', async () => {
  for (const kind of ['position', 'explain']) {
    const lesson = { gameId: 'custom', requestId: 'custom-request', kind, evidence: { mode: 'record' } };
    let prompt, published;
    await deliverInlineLesson({ lesson, app: {
      getHostCapabilities: () => ({ sampling: {} }),
      async createSamplingMessage(input) { prompt = input.messages[0].content.text; return { content: { type: 'text', text: '测试正文' } }; },
    }, async call(name, args) { published = { name, args }; return { lesson }; } });
    assert.match(prompt, kind === 'position' ? /当前局面/ : /红黑双方都由我录入/);
    assert.equal(published.name, 'publish_lesson'); assert.equal(published.args.gameId, 'custom');
  }
});

test('a terminal record refreshes an earlier phase report, but a complete report or zero-move setup does not restart', () => {
  const game = { id: 'game', status: 'finished', initialFen: 'start', moves: [{ fen: 'one' }, { fen: 'two' }] };
  const report = { gameId: 'game', total: 1, rootFen: 'one' };
  assert.equal(needsAutomaticReview(game, report), true);
  assert.equal(needsAutomaticReview(game, { ...report, total: 2, rootFen: 'two' }), false);
  assert.equal(needsAutomaticReview({ ...game, moves: [] }, null), false);
  assert.equal(needsAutomaticReview({ ...game, status: 'active' }, report), false);
});
