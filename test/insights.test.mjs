import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Rules } from '../server/rules.mjs';
import { Store } from '../server/store.mjs';
import { GameService } from '../server/game.mjs';
import { normalizeScore } from '../server/insights.mjs';
import { referencePoints } from '../server/score-scale.mjs';

const rules = new Rules();
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class FixtureEngine {
  calls = [];
  async analyze(options) {
    this.calls.push(options);
    const position = await rules.inspect(options.initialFen, options.moves);
    const selected = options.searchMoves?.length ? options.searchMoves : position.legalMoves.slice(0, options.multiPV ?? 1).map(move => move.uci);
    return { engine: 'insights fixture', requestedMs: options.movetime, bestmove: selected[0], lines: selected.map((move, index) => ({ rank: index + 1, depth: 12, score: { type: 'cp', value: 80 + options.moves.length, bound: 'exact', perspective: 'side_to_move' }, pv: [move] })) };
  }
}
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-insights-test-'));
  const store = new Store(directory), engine = new FixtureEngine(), scoreEngine = new FixtureEngine();
  const service = new GameService({ rules, store, engine, scoreEngine, movetime: 150 });
  t.after(async () => { await store.queue; store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, engine, scoreEngine, directory };
}
const args = (game, requestId, extra = {}) => ({ gameId: game.id, expectedVersion: game.version, requestId, ...extra });
async function exchange(service, initial, id = 'round') {
  const user = await service.play(args(initial.game, `${id}-user`, { move: 'h2e2', deferReply: true }));
  return service.engineReply(args(user.game, `${id}-coach`, { fast: true }));
}

test('scores preserve red/black perspective, opposite bounds and mate semantics', () => {
  const source = { type: 'cp', value: 175, bound: 'lowerbound', perspective: 'side_to_move' };
  assert.deepEqual(normalizeScore(source, 'b'), { red: { type: 'cp', value: -175, bound: 'upperbound' }, black: { type: 'cp', value: 175, bound: 'lowerbound' } });
  assert.equal(normalizeScore(source, 'r').red.value, 175);
  assert.deepEqual(normalizeScore({ ...source, type: 'mate', value: -3, bound: 'exact' }, 'b').red, { type: 'mate', value: 3, bound: 'exact' });
  assert.equal(Object.is(normalizeScore({ ...source, value: 0 }, 'b').red.value, -0), false);
  assert.throws(() => normalizeScore({ ...source, perspective: 'unknown' }, 'r'), /可靠/);
});

test('each half-move gets its own score, caches persist, and an undone branch cannot leak points', async t => {
  const { service, store, scoreEngine, directory } = await fixture(t);
  const initial = await service.newGame({ requestId: 'score-game' });
  const played = await exchange(service, initial);
  const before = await store.load(played.game.id);
  for (const ply of [2, 1, 0]) {
    const result = await service.insights.evaluate({ gameId: played.game.id, expectedVersion: played.game.version, ply });
    assert.equal(result.point.fen, ply ? played.game.moves[ply - 1].fen : played.game.initialFen);
    assert.equal(result.point.red.value, referencePoints(ply % 2 ? -(80 + ply) : 80 + ply, result.point.fen));
    assert.equal(result.point.black.value, -result.point.red.value);
  }
  await store.queue;
  assert.deepEqual(await store.load(played.game.id), before);
  assert.equal(scoreEngine.calls.length, 3);
  assert.deepEqual(scoreEngine.calls.map(call => call.movetime), [200, 200, 200]);
  const reopened = new Store(directory);
  try {
    const restored = new GameService({ rules, store: reopened, engine: new FixtureEngine() });
    assert.deepEqual((await restored.read(played.game.id)).scores, (await service.read(played.game.id)).scores);
  } finally { reopened.close(); }
  const undone = await service.undo(args(played.game, 'undo-score', { plies: 2 }));
  assert.equal(undone.scores.length, 1);
  assert.equal(undone.scores[0].red.value, referencePoints(80, initial.game.fen));
  const different = await service.play(args(undone.game, 'new-branch', { move: 'b0c2', deferReply: true }));
  assert.equal(different.scores.length, 2);
  assert.equal(different.scores[1].red, undefined);
  await assert.rejects(service.insights.evaluate({ gameId: played.game.id, expectedVersion: played.game.version }), /已更新/);
});

test('scoring returns while the coach holds a write transaction and duplicate requests share one search', async t => {
  const { service, store, scoreEngine } = await fixture(t);
  const initial = await service.newGame({ requestId: 'independent-score' });
  const entered = gate(), release = gate();
  const holding = store.serial(initial.game.id, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let timer;
  try {
    const results = await Promise.race([
      Promise.all([service.insights.evaluate({ gameId: initial.game.id }), service.insights.evaluate({ gameId: initial.game.id })]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('score waited for move transaction')), 1500); }),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(scoreEngine.calls.length, 1);
    assert.equal((await service.read(initial.game.id)).scores[0].red.value, referencePoints(80, initial.game.fen));
  } finally { clearTimeout(timer); release.resolve(); await holding; await store.queue; }
});

test('late scores never replace a newer game and invalid engine output is not cached', async t => {
  const { service, store, scoreEngine } = await fixture(t);
  const initial = await service.newGame({ requestId: 'late-score' });
  const entered = gate(), release = gate(), analyze = scoreEngine.analyze.bind(scoreEngine);
  scoreEngine.analyze = async options => { entered.resolve(); await release.promise; return analyze(options); };
  const pending = service.insights.evaluate({ gameId: initial.game.id });
  await entered.promise;
  const played = await service.play(args(initial.game, 'while-scoring', { move: 'h2e2', deferReply: true }));
  const committed = await store.load(initial.game.id);
  release.resolve();
  assert.equal((await pending).version, 0);
  await store.queue;
  assert.deepEqual(await store.load(initial.game.id), committed);
  scoreEngine.analyze = async () => ({ bestmove: 'a0a9', lines: [] });
  await assert.rejects(service.insights.evaluate({ gameId: initial.game.id }), /校验/);
  assert.equal((await service.read(initial.game.id)).scores[1].red, undefined);
});

test('lessons freeze evidence, deduplicate preparation and publish into the same board after play continues', async t => {
  const { service, store, engine, directory } = await fixture(t);
  const initial = await service.newGame({ requestId: 'inline-lesson' });
  const played = await exchange(service, initial);
  const before = await store.load(played.game.id);
  const request = args(played.game, 'lesson-request', { kind: 'explain' });
  const [lesson, duplicate] = await Promise.all([service.insights.prepare(request), service.insights.prepare(request)]);
  assert.deepEqual(lesson, duplicate);
  assert.equal(lesson.status, 'pending');
  assert.equal(lesson.rootFen, played.game.fen);
  assert.equal(lesson.evidence.lesson.userMove.played.chinese, '炮二平五');
  const calls = engine.calls.length;
  assert.deepEqual(await service.insights.prepare(request), lesson);
  assert.equal(engine.calls.length, calls);
  assert.deepEqual(await store.load(played.game.id), before);
  assert.equal((await service.insights.readLesson(request)).evidence, undefined);
  const later = await service.play(args(played.game, 'continue-reading', { move: played.position.legalMoves[0].uci, deferReply: true }));
  const continued = await store.load(later.game.id);
  const text = '先看这步棋打开了哪条线路，再看对方应手补住了哪里。\n\n'.repeat(35);
  const saved = await service.insights.publish({ ...request, text });
  assert.equal(saved.saved, true);
  assert.equal(saved.lesson.text, text.trim());
  assert.equal((await service.read(later.game.id)).boardLesson.requestId, request.requestId);
  assert.equal((await service.insights.readLesson(request)).obsolete, false);
  assert.deepEqual(await store.load(later.game.id), continued);
  assert.equal((await service.insights.publish({ ...request, text })).lesson.completedAt, saved.lesson.completedAt);
  await assert.rejects(service.insights.publish({ ...request, text: 'overwrite' }), /不能/);
  const reopened = new Store(directory);
  try { assert.equal(reopened.lesson(later.game.id, request.requestId).text, text.trim()); } finally { reopened.close(); }
  const undone = await service.undo(args(later.game, 'undo-requested-round', { plies: 2 }));
  assert.equal(undone.boardLesson, null);
  assert.equal((await service.insights.readLesson(request)).obsolete, true);
  await assert.rejects(service.insights.publish({ ...request, text }), /撤回/);
});

test('lesson request identifiers cannot cross games or change kinds and empty text is rejected', async t => {
  const { service } = await fixture(t);
  const a = await service.newGame({ requestId: 'hint-game-a' });
  const b = await service.newGame({ requestId: 'hint-game-b' });
  const request = args(a.game, 'same-lesson-id', { kind: 'hint' });
  const hint = await service.insights.prepare(request);
  assert.equal(hint.toPly, 0);
  assert.ok(hint.evidence.analysis.best.steps.length <= 4);
  await assert.rejects(service.insights.prepare({ ...request, kind: 'explain' }), /编号/);
  await assert.rejects(service.insights.prepare({ ...request, gameId: b.game.id }), /另一盘/);
  await assert.rejects(service.insights.publish({ ...request, text: ' ' }), /正文/);
  await assert.rejects(service.insights.publish({ ...request, text: '棋'.repeat(6001) }), /正文/);
});
