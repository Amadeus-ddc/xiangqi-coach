import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Rules, START_FEN } from '../server/rules.mjs';
import { Store } from '../server/store.mjs';
import { GameService } from '../server/game.mjs';
import { moveQuality, summarizeRows, gradeFor, keyTurnsFor } from '../server/review.mjs';
import { referencePoints, gameStage } from '../server/score-scale.mjs';
import { toolDefinitions, callTool } from '../server/mcp.mjs';

const rules = new Rules();
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const score = (value, extra = {}) => ({ type: 'cp', value, bound: 'exact', perspective: 'side_to_move', ...extra });
const line = (move, value, extra = {}) => ({ move, score: score(value), ...extra });
class FixtureEngine {
  calls = [];
  async analyze(options) {
    this.calls.push(options);
    const state = await rules.inspect(options.initialFen, options.moves);
    const moves = options.searchMoves?.length ? options.searchMoves : state.legalMoves.slice(0, options.multiPV ?? 1).map(move => move.uci);
    return { engine: 'review fixture', requestedMs: options.movetime, bestmove: moves[0], lines: moves.map((move, index) => ({ rank: index + 1, depth: 16, score: score(options.searchMoves?.length ? -400 : 100), pv: [move] })) };
  }
  close() {}
}
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-review-test-'));
  const store = new Store(directory), engine = new FixtureEngine(), reviewEngine = new FixtureEngine();
  const service = new GameService({ rules, store, engine, reviewEngine, movetime: 150, reviewMs: 800 });
  t.after(async () => { await Promise.allSettled(service.reviews.jobs.values()); await store.queue; store.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = await service.newGame({ requestId: 'review-source' });
  const user = await service.play(args(initial.game, 'review-source-user', { move: 'h2e2', deferReply: true }));
  const played = await service.engineReply(args(user.game, 'review-source-coach', { fast: true }));
  return { service, store, engine, reviewEngine, directory, played };
}
const args = (game, requestId, extra = {}) => ({ gameId: game.id, expectedVersion: game.version, requestId, ...extra });
async function finishedReview(service, game) {
  const started = await service.reviews.start({ gameId: game.id, expectedVersion: game.version });
  await service.reviews.jobs.get(started.id);
  return service.reviews.read({ gameId: game.id, reviewId: started.id });
}

test('reference scale stays separate from the recovered move score and grades use unrounded scores', () => {
  assert.equal(referencePoints(0, START_FEN), 0);
  assert.equal(referencePoints(-100, START_FEN), -referencePoints(100, START_FEN));
  assert.notEqual(referencePoints(100, START_FEN), 100, 'raw normalized UCI cp must not be labeled material-equivalent points');
  assert.deepEqual([100, 80, 79, 60, 59, 40, 39, 20, 19, 0, null].map(gradeFor), ['优', '优', '良', '良', '中', '中', '差', '差', '错', '错', '未定']);
  assert.equal(moveQuality(line('a0a1', 0), line('a0a2', 0), START_FEN).accuracy, 100);
  assert.ok(moveQuality(line('a0a1', 100), line('a0a2', 99), START_FEN).accuracy < 100, 'the old 50-point free-loss zone is gone');
  const quality = moveQuality(line('a0a1', 100), line('a0a2', -200), START_FEN);
  assert.ok(quality.accuracy < 20);
  assert.equal(quality.loss, referencePoints(300, START_FEN));
});

test('bounds, search disagreement and unverified mating lines cannot produce false precise ratings or missed-mate counts', () => {
  const best = line('a0a1', 100);
  assert.equal(moveQuality(best, { ...line('a0a2', 0), score: score(0, { bound: 'upperbound' }) }, START_FEN).accuracy, null);
  assert.equal(moveQuality(best, line('a0a2', 500), START_FEN).accuracy, null);
  const mating = { move: 'a0a1', score: score(3, { type: 'mate' }), terminal: false };
  const possible = moveQuality(mating, line('a0a2', 0), START_FEN);
  assert.equal(possible.missedMate, false); assert.equal(possible.possibleMissedMate, true); assert.equal(possible.accuracy, null);
  const confirmed = moveQuality({ ...mating, terminal: true }, line('a0a2', 0), START_FEN);
  assert.equal(confirmed.missedMate, true); assert.equal(confirmed.accuracy, -300);
  assert.equal(moveQuality(mating, { move: 'a0a2', score: score(6, { type: 'mate' }) }, START_FEN).accuracy, 100);
  const losing = { move: 'a0a2', score: score(-2, { type: 'mate' }), terminal: true };
  assert.equal(moveQuality(best, losing, START_FEN).accuracy, -300);
  assert.equal(moveQuality({ ...losing, move: 'a0a1' }, losing, START_FEN).accuracy, null);
});

test('key turns keep losing-mate mistakes and unconfirmed mate opportunities without inventing numeric losses', () => {
  const best = line('a0a1', 100);
  const losing = { move: 'a0a2', score: score(-2, { type: 'mate' }), terminal: true };
  const mating = { move: 'a0a1', score: score(3, { type: 'mate' }), terminal: false };
  const qualities = [moveQuality(best, line('a0a2', -100), START_FEN), moveQuality(best, losing, START_FEN), moveQuality(mating, line('a0a2', 0), START_FEN), moveQuality(best, best, START_FEN)];
  const keyTurns = keyTurnsFor(qualities.map((quality, index) => ({ ply: index + 1, quality, best: { chinese: '车九进一' } })));
  assert.deepEqual(keyTurns.map(turn => turn.ply), [2, 1, 3]);
  assert.equal(keyTurns[0].quality.loss, null);
  assert.equal(keyTurns[0].quality.missedMate, false);
  assert.equal(keyTurns[2].quality.possibleMissedMate, true);
});

test('first 20 plies take opening priority, then both sides need at most two major pieces', () => {
  const middle = { a: 'rR', b: 'rN', c: 'rC', d: 'bR', e: 'bN', f: 'bC' };
  assert.equal(gameStage(middle, 19), 'opening'); assert.equal(gameStage(middle, 20), 'middlegame');
  const ending = { a: 'rR', b: 'rC', c: 'bR', d: 'bN' };
  assert.equal(gameStage(ending, 0), 'opening');
  assert.equal(gameStage(ending, 19), 'opening');
  assert.equal(gameStage(ending, 20), 'endgame');
  assert.equal(gameStage({ a: 'rN', b: 'rC', c: 'rC', d: 'bN', e: 'bN', f: 'bC' }, 20), 'middlegame');
  const summary = summarizeRows([{ side: 'r', stage: 'opening', quality: { accuracy: 80, grade: '优', missedMate: false } }, { side: 'r', stage: 'opening', quality: { accuracy: null, grade: '未定', missedMate: false } }, { side: 'b', stage: 'opening', quality: { accuracy: 0, grade: '错', missedMate: true } }]);
  assert.equal(summary.r.accuracy, 80); assert.equal(summary.r.scored, 1); assert.equal(summary.r.phases.endgame.accuracy, null);
  assert.equal(summary.b.mistakes, 1); assert.equal(summary.b.missedMates, 1);
});

test('review starts in background, deduplicates across connections and keeps the original game intact while play continues', async t => {
  const { service, store, reviewEngine, played, directory } = await fixture(t);
  const entered = gate(), release = gate(), analyze = reviewEngine.analyze.bind(reviewEngine);
  reviewEngine.analyze = async options => { entered.resolve(); await release.promise; return analyze(options); };
  const first = await service.reviews.start(args(played.game));
  await entered.promise;
  assert.equal(first.status, 'running'); assert.equal(first.rows.length, 0);
  const otherStore = new Store(directory), other = new GameService({ rules, store: otherStore, engine: new FixtureEngine() });
  try {
    const duplicate = await other.reviews.start(args(played.game));
    assert.equal(duplicate.id, first.id); assert.equal(other.reviews.jobs.size, 0);
  } finally { otherStore.close(); }
  const later = await service.play(args(played.game, 'play-during-review', { move: played.position.legalMoves[0].uci, deferReply: true }));
  const saved = await store.load(played.game.id);
  release.resolve(); await service.reviews.jobs.get(first.id);
  const report = await service.reviews.read({ gameId: played.game.id, reviewId: first.id });
  assert.equal(report.status, 'complete'); assert.equal(report.total, 2); assert.equal(report.rows.length, 2); assert.equal(report.points.length, 3);
  assert.equal(report.obsolete, false); assert.equal(report.gameFinished, false);
  assert.equal(report.rows[0].chinese, '炮二平五'); assert.equal(report.rows[0].quality.grade, '错'); assert.equal(report.summary.r.mistakes, 1);
  assert.equal(report.rows[1].side, 'b'); assert.equal(report.rows[1].quality.accuracy, 100);
  assert.equal(report.keyTurns[0].ply, 1);
  assert.ok(reviewEngine.calls.every(call => call.movetime === 800));
  assert.deepEqual(await store.load(later.game.id), saved);
  assert.equal(report.frozenGame, undefined); assert.equal(report.owner, undefined);
});

test('completed reports survive reopening, expose verified lines on demand, and feed board-only GPT lessons', async t => {
  const { service, store, reviewEngine, played, directory } = await fixture(t);
  const report = await finishedReview(service, played.game), calls = reviewEngine.calls.length;
  assert.equal((await service.reviews.start(args(played.game))).status, 'complete'); assert.equal(reviewEngine.calls.length, calls);
  const reopened = new Store(directory);
  try {
    const restored = new GameService({ rules, store: reopened, engine: new FixtureEngine() });
    assert.deepEqual(await restored.reviews.read({ gameId: played.game.id, reviewId: report.id }), report);
  } finally { reopened.close(); }
  const row = await service.reviews.read({ gameId: played.game.id, reviewId: report.id, ply: 1 });
  assert.equal(row.selected.played.move, played.game.moves[0].uci);
  assert.equal(row.selected.played.steps[0].fen, played.game.moves[0].fen);
  const request = args(played.game, 'review-gpt-summary', { kind: 'review', reviewId: report.id });
  const lesson = await service.insights.prepare(request);
  assert.equal(lesson.evidence.scope, 'game'); assert.equal(lesson.evidence.moves[0].ply, 1);
  const gameBefore = await store.load(played.game.id);
  await service.insights.publish({ gameId: played.game.id, requestId: request.requestId, text: '这一局先回看第一手，再对照推荐变化检查子力协调。' });
  assert.equal((await service.read(played.game.id)).boardLesson.kind, 'review');
  assert.deepEqual(await store.load(played.game.id), gameBefore);
  await assert.rejects(service.insights.prepare({ ...request, ply: 1 }), /请求编号/);
});

test('legacy reports retain their method and cannot replace a current report saved by another connection', async t => {
  const { service, store, played } = await fixture(t);
  const current = await finishedReview(service, played.game);
  const old = { ...store.review(played.game.id, current.id), id: 'legacy-score-report', method: { version: 'loss50-exp300-v1', source: '历史本地指数公式' } };
  await store.serial(played.game.id, () => store.saveReview(old));
  const historical = await service.reviews.read({ gameId: played.game.id, reviewId: old.id });
  assert.equal(historical.outdatedMethod, true);
  assert.equal(historical.method.source, '历史本地指数公式');
  assert.equal(service.reviews.latest(played.game).id, current.id);
  assert.equal(service.reviews.latest(played.game).outdatedMethod, false);
  assert.equal((await service.reviews.start(args(played.game))).id, current.id);
  assert.equal(store.review(played.game.id, old.id).method.version, 'loss50-exp300-v1');
});

test('retry creates an independent practice game and self-analysis can return to the previous position without writing moves', async t => {
  const { service, store, played } = await fixture(t);
  const report = await finishedReview(service, played.game), before = await store.load(played.game.id);
  const request = { gameId: played.game.id, reviewId: report.id, ply: 2, requestId: 'retry-black-move' };
  const practice = await service.reviews.practice(request);
  assert.notEqual(practice.game.id, played.game.id);
  assert.equal(practice.game.initialFen, played.game.moves[1].beforeFen); assert.equal(practice.game.playerSide, 'b');
  assert.equal(practice.game.moves.length, 0); assert.equal(practice.game.trainingOrigin.reviewId, report.id);
  assert.equal((await service.reviews.practice(request)).duplicate, true);
  const definitions = toolDefinitions(service);
  const root = await callTool(definitions, 'preview_line', { gameId: played.game.id, ply: 0, moves: [] });
  assert.equal(root.isError, undefined); assert.equal(root.structuredContent.position.fen, START_FEN);
  const hypothetical = await service.preview({ gameId: played.game.id, ply: 0, moves: ['h2e2'] });
  assert.equal(hypothetical.position.fen, played.game.moves[0].fen);
  assert.deepEqual(await store.load(played.game.id), before);
});

test('undo makes the old report obsolete and rejects its practice/lesson actions', async t => {
  const { service, played } = await fixture(t);
  const report = await finishedReview(service, played.game);
  const undone = await service.undo(args(played.game, 'undo-review', { plies: 2 }));
  assert.equal(undone.review, null);
  assert.equal((await service.reviews.read({ gameId: played.game.id, reviewId: report.id })).obsolete, true);
  await assert.rejects(service.reviews.practice({ gameId: played.game.id, reviewId: report.id, ply: 1, requestId: 'practice-old' }), /撤回/);
  await assert.rejects(service.insights.prepare(args(undone.game, 'lesson-old-review', { kind: 'review', reviewId: report.id })), /撤回/);
});

test('a failed or interrupted review resumes saved rows and does not mutate the game', async t => {
  const { service, store, reviewEngine, played } = await fixture(t);
  const analyze = reviewEngine.analyze.bind(reviewEngine);
  let failed = false;
  reviewEngine.analyze = async options => { if (options.moves.length && !failed) { failed = true; throw new Error('interrupted fixture'); } return analyze(options); };
  const first = await finishedReview(service, played.game);
  assert.equal(first.status, 'failed'); assert.equal(first.rows.length, 1);
  const firstRow = first.rows[0], before = await store.load(played.game.id);
  const second = await finishedReview(service, played.game);
  assert.equal(second.id, first.id); assert.equal(second.status, 'complete'); assert.deepEqual(second.rows[0], firstRow);
  assert.deepEqual(await store.load(played.game.id), before);
  const expired = store.review(played.game.id, first.id);
  expired.status = 'running'; expired.leaseUntil = Date.now() - 1;
  await store.serial(played.game.id, () => store.saveReview(expired));
  assert.equal((await service.reviews.read({ gameId: played.game.id, reviewId: first.id })).status, 'paused');
  assert.equal((await finishedReview(service, played.game)).status, 'complete');
});

test('terminal review records the actual result separately from centipawn scores', async t => {
  const { service } = await fixture(t);
  const initial = await service.newGame({ requestId: 'review-mate-game', fen: '4k4/3R1R1N1/9/9/9/9/9/9/9/5K3 r' });
  const ended = await service.play(args(initial.game, 'review-mate-move', { move: 'f8e8', deferReply: true }));
  assert.equal(ended.game.status, 'finished');
  const report = await finishedReview(service, ended.game);
  assert.equal(report.gameFinished, true); assert.equal(report.result.winner, 'r');
  assert.equal(report.points[1].red.type, 'result'); assert.equal(report.points[1].red.value, 1);
});
