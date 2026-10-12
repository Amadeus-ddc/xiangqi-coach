import test from 'node:test';
import assert from 'node:assert/strict';
import { ScoreLoader, chartGeometry, scoreLabel } from '../web/score-chart.mjs';
import { deliverInlineLesson, sameLessonPosition } from '../web/inline-teaching.mjs';
import { ReviewLoader, sameReviewPosition } from '../web/review-panel.mjs';

const score = value => ({ type: 'cp', value, bound: 'exact' });
const point = (ply, value) => ({ ply, fen: `fen-${ply}`, red: score(value), black: score(-value) });
const snapshot = (version = 1) => ({ game: { id: 'game-a', version, moves: [{}, {}] }, scores: [0, 1, 2].map(ply => ({ ply, fen: `fen-${ply}` })) });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('one curve keeps gaps and changes red/black color exactly at zero, with integer and mate labels', () => {
  const geometry = chartGeometry([point(0, 250), { ply: 1 }, point(2, 7000)]);
  assert.equal(geometry.lines.red, '');
  assert.equal(geometry.lines.black, '');
  assert.equal(geometry.dots[1].capped, true);
  assert.equal(geometry.dots[1].y, geometry.top);
  assert.equal(scoreLabel(score(700)), '+700');
  assert.equal(scoreLabel({ type: 'mate', value: -3, bound: 'exact' }), '被将杀 3');
  assert.equal(scoreLabel({ ...score(-250), bound: 'upperbound' }), '≤-250');
  assert.equal(scoreLabel({ type: 'result', value: 1 }), '胜');
  assert.equal(scoreLabel(null), '—');
  const crossed = chartGeometry([point(0, 200), point(1, -200)]);
  assert.ok(crossed.lines.red.endsWith(`${crossed.middle.toFixed(2)} `));
  assert.ok(crossed.lines.black.startsWith(`M${((crossed.left + crossed.right) / 2).toFixed(2)},${crossed.middle.toFixed(2)}`));
  assert.ok(crossed.noiseTop < crossed.middle && crossed.noiseBottom > crossed.middle);
});

test('score loader prioritizes latest half-move and discards an old version before loading the new board', async () => {
  let current = snapshot();
  const entered = gate(), release = gate(), calls = [], accepted = [];
  const loader = new ScoreLoader({ getSnapshot: () => current, onStatus() {}, onPoint(value) { accepted.push(value); current.scores[value.ply] = value; },
    async call(name, args) { calls.push(args); if (calls.length === 1) { entered.resolve(); await release.promise; } return { gameId: args.gameId, version: args.expectedVersion, point: point(args.ply, args.expectedVersion * 100) }; },
  });
  const running = loader.update();
  await entered.promise;
  current = snapshot(2);
  await loader.update();
  release.resolve(); await running;
  assert.deepEqual(calls.map(call => [call.expectedVersion, call.ply]), [[1, 2], [2, 2], [2, 1], [2, 0]]);
  assert.deepEqual(accepted.map(value => value.red.value), [200, 200, 200]);
});

test('score failure stays visible without a tight retry loop; explicit retry fills all missing points', async () => {
  const current = snapshot(), statuses = []; let failing = true, calls = 0;
  const loader = new ScoreLoader({ getSnapshot: () => current, onStatus: text => statuses.push(text), onPoint: value => { current.scores[value.ply] = value; }, async call(name, args) { calls++; if (failing) throw new Error('unavailable'); return { gameId: args.gameId, version: args.expectedVersion, point: point(args.ply, 50) }; } });
  await loader.update(); await loader.update();
  assert.equal(calls, 1); assert.match(statuses.at(-1), /重试/);
  failing = false; await loader.retry();
  assert.equal(calls, 4); assert.equal(statuses.at(-1), '');
});

const lesson = { gameId: 'game-a', requestId: 'lesson-a', kind: 'explain', version: 2, toPly: 2, rootFen: 'fen-2', evidence: { gameId: 'game-a', version: 2, fromPly: 0, toPly: 2, lesson: { verified: true } } };
test('direct host sampling publishes plain text to the existing board and never sends a chat message', async () => {
  const calls = [];
  const result = await deliverInlineLesson({ lesson, app: {
    getHostCapabilities: () => ({ sampling: {}, message: {} }),
    async createSamplingMessage(input) { assert.equal(input.includeContext, 'none'); assert.match(input.messages[0].content.text, /verified/); return { content: { type: 'text', text: ' 先看中路。 ' } }; },
    sendMessage() { throw new Error('must remain inline'); },
  }, async call(name, args) { calls.push([name, args]); return { lesson: { ...lesson, status: 'complete', text: args.text } }; } });
  assert.equal(result.mode, 'inline');
  assert.deepEqual(calls, [['publish_lesson', { gameId: 'game-a', requestId: 'lesson-a', text: '先看中路。' }]]);
});

test('a sampling rejection is surfaced without routing around host permission', async () => {
  await assert.rejects(deliverInlineLesson({ lesson, app: { getHostCapabilities: () => ({ sampling: {}, message: {} }), createSamplingMessage() { throw new Error('host rejected'); }, sendMessage() { assert.fail('must not reroute'); } }, call() { assert.fail('must not publish'); } }), /host rejected/);
});

test('Codex fallback sends evidence and required board destination in context, with a short visible request', async () => {
  let context, message;
  const result = await deliverInlineLesson({ lesson, app: { getHostCapabilities: () => ({ message: {}, updateModelContext: {} }), async updateModelContext(input) { context = input.structuredContent; return {}; }, async sendMessage(input) { message = input.content[0].text; return {}; } }, call() { assert.fail('model publishes later'); } });
  assert.equal(result.mode, 'conversation');
  assert.equal(context.boardDelivery.requestId, lesson.requestId);
  assert.match(context.boardDelivery.instructions, /必须调用 publish_lesson/);
  assert.ok(message.length < 100);
  assert.doesNotMatch(message, /game-a|lesson-a|publish_lesson|verified/);
  assert.match(message, /棋盘内/);
});

test('missing model context retains the exact request for verified read-back and detects withdrawn positions', async () => {
  let message;
  await deliverInlineLesson({ lesson, app: { getHostCapabilities: () => ({ message: {} }), async sendMessage(input) { message = input.content[0].text; return {}; } }, call() {} });
  assert.match(message, /read_lesson\(includeEvidence=true\)/);
  assert.match(message, /lesson-a/);
  assert.match(message, /publish_lesson/);
  const game = { id: 'game-a', initialFen: 'start', moves: [{ fen: 'fen-1' }, { fen: 'fen-2' }, { fen: 'fen-3' }] };
  assert.equal(sameLessonPosition(lesson, game), true);
  assert.equal(sameLessonPosition(lesson, { ...game, moves: game.moves.slice(0, 1) }), false);
  assert.equal(sameLessonPosition(lesson, { ...game, id: 'other' }), false);
});

test('an old report response cannot change another game after its tab or practice game was opened', async () => {
  let game = { id: 'game-a', version: 2, moves: [{ fen: 'fen-1' }, { fen: 'fen-2' }] };
  const pending = gate(), accepted = [];
  const loader = new ReviewLoader({ getGame: () => game, onReport: report => accepted.push(report), onStatus() {}, call: () => pending.promise });
  const request = loader.start();
  loader.stop(); game = { ...game, id: 'practice-b' };
  pending.resolve({ gameId: 'game-a', id: 'report-a', total: 2, rootFen: 'fen-2', rows: [], status: 'complete' });
  await request; assert.equal(accepted.length, 0);
});

test('review loader shows failed progress without a busy loop and reports a withdrawn history', async () => {
  const game = { id: 'game-a', version: 2, moves: [{ fen: 'fen-1' }, { fen: 'fen-2' }] };
  let calls = 0, lastReport, status;
  const report = { gameId: 'game-a', id: 'report-a', total: 2, rootFen: 'fen-2', rows: [], status: 'failed', error: 'engine stopped' };
  const loader = new ReviewLoader({ getGame: () => game, onReport: value => { lastReport = value; }, onStatus: text => { status = text; }, async call() { calls++; return report; } });
  await loader.start(); assert.equal(calls, 1); assert.equal(loader.timer, null); assert.equal(status, 'engine stopped');
  assert.equal(sameReviewPosition(report, game), true);
  assert.equal(sameReviewPosition(report, { ...game, moves: game.moves.slice(0, 1) }), false);
  report.obsolete = true; await loader.open(game.id, report.id);
  assert.equal(lastReport, null); assert.match(status, /撤回/); loader.stop();
});
