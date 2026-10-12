import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { Rules } from '../server/rules.mjs';
import { GameService } from '../server/game.mjs';
import { PUZZLES } from '../server/puzzles.mjs';
import { toolDefinitions, callTool } from '../server/mcp.mjs';

const rules = new Rules();
const args = (state, requestId, extra = {}) => ({ gameId: state.game.id, expectedVersion: state.game.version, requestId, ...extra });
const one = () => PUZZLES.find(p => p.maxPlayerMoves === 1);
const multi = () => PUZZLES.find(p => p.maxPlayerMoves > 1);
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-training-'));
  const store = new Store(directory);
  const engine = { analyze() { throw new Error('Training must not invoke the engine'); }, close() {} };
  const service = new GameService({ rules, store, engine });
  t.after(async () => { await store.queue; store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, directory };
}
async function solve(service, state, puzzle, line = puzzle.solutions[0]) {
  for (let i = state.game.moves.length; i < line.length; i++) {
    state = i % 2 === 0
      ? await service.play(args(state, `solve-user-${i}-${state.game.version}`, { move: line[i], deferReply: true }))
      : await service.engineReply(args(state, `solve-reply-${i}-${state.game.version}`));
    // Defense selection may choose a longer legal continuation than this line.
    line = puzzle.solutions.find(candidate => state.game.moves.every((m, index) => candidate[index] === m.uci));
    assert.ok(line);
  }
  return state;
}

test('catalog and active snapshots withhold hints and solution; normal games are preserved', async t => {
  const { service } = await fixture(t);
  const normal = await service.newGame({ requestId: 'normal-before-training', autoReply: false });
  const before = JSON.stringify(await service.read(normal.game.id));
  const catalog = await service.training.list();
  assert.ok(catalog.puzzles.length >= 12);
  assert.equal(catalog.summary.rating, 1200);
  for (const p of catalog.puzzles) { assert.equal(p.solutions, undefined); assert.equal(p.hint, undefined); assert.equal(p.explanation, undefined); }
  const state = await service.training.start({ requestId: 'start-withheld-answer', puzzleId: one().id });
  assert.equal(state.game.mode, 'training'); assert.equal(state.game.training, undefined);
  assert.equal(state.training.solution, undefined); assert.equal(state.training.hints, 0);
  assert.deepEqual(state.scores, []); assert.equal(state.review, null);
  assert.equal(JSON.stringify(await service.read(normal.game.id)), before);
  await assert.rejects(service.analyze({ gameId: state.game.id }), /先完成本题/);
  await assert.rejects(service.insights.evaluate({ gameId: state.game.id }), /先完成本题/);
  await assert.rejects(service.insights.prepare(args(state, 'forbidden-training-hint', { kind: 'hint' })), /先完成本题/);
  await assert.rejects(service.undo(args(state, 'forbidden-training-undo')), /重试/);
});

test('verified alternate wins are accepted; scoring commits once and persists across connections', async t => {
  const { service, store, directory } = await fixture(t);
  const puzzle = PUZZLES.find(p => p.maxPlayerMoves === 1 && new Set(p.solutions.map(line => line[0])).size > 1) ?? one();
  let state = await service.training.start({ requestId: 'rated-first-attempt', puzzleId: puzzle.id, mode: 'rated' });
  const first = state;
  const request = args(state, 'rated-correct-move', { move: puzzle.solutions.at(-1)[0], deferReply: true });
  state = await service.play(request);
  assert.equal(state.training.status, 'solved'); assert.equal(state.training.stars, 3);
  assert.equal(state.position.winner, state.game.playerSide);
  assert.ok(state.training.ratingChange > 0);
  const profile = store.trainingProfile();
  const duplicate = await service.play(request);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(store.trainingProfile(), profile);
  const duplicateStart = await service.training.start({ requestId: 'rated-first-attempt', puzzleId: puzzle.id, mode: 'rated' });
  assert.equal(duplicateStart.duplicate, true); assert.equal(duplicateStart.game.id, first.game.id);
  await assert.rejects(service.training.start({ requestId: 'rated-first-attempt', puzzleId: puzzle.id, mode: 'learn' }), /其他训练参数/);
  state = await service.training.start({ requestId: 'rated-repeat-puzzle', puzzleId: puzzle.id, mode: 'rated' });
  state = await solve(service, state, puzzle);
  assert.equal(state.training.ratingChange, 0); assert.equal(state.training.summary.rating, profile.rating);
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.trainingProfile(), store.trainingProfile());
    const restored = new GameService({ rules, store: reopened, engine: {} });
    assert.equal((await restored.read(state.game.id)).training.status, 'solved');
  } finally { reopened.close(); }
});

test('catalog expansion preserves the original progress and prevents re-awarding old rated puzzles', async t => {
  const { service, store } = await fixture(t), puzzle = one();
  const profile = store.trainingProfile();
  profile.progress[`2026-10-12.1:${puzzle.id}`] = { attempts: 2, solved: true, bestStars: 3, mistakes: 1, needsReview: true, ratedCompleted: true };
  profile.rating = 1234; store.saveTrainingProfile(profile);
  const original = await service.training.list({ source: 'original' });
  assert.equal(original.puzzles.length, 18);
  const restored = original.puzzles.find(p => p.id === puzzle.id);
  assert.equal(restored.progress.bestStars, 3); assert.equal(restored.progress.needsReview, true);
  let state = await service.training.start({ requestId: 'old-rated-after-expansion', puzzleId: puzzle.id, mode: 'rated' });
  state = await solve(service, state, puzzle);
  assert.equal(state.training.ratingChange, 0); assert.equal(state.training.summary.rating, 1234);
});

test('imported CCPD exercises can be filtered, solved from both sides and retain attribution', async t => {
  const { service } = await fixture(t);
  const imported = await service.training.list({ source: 'ccpd' });
  assert.ok(imported.puzzles.length >= 30);
  assert.ok(imported.puzzles.every(p => p.source.kind === 'ccpd' && !p.solutions && !p.hint));
  const selections = [' r',' b'].map(side => PUZZLES.find(p => p.source.kind === 'ccpd' && p.fen.endsWith(side) && p.maxPlayerMoves > 1));
  for (const puzzle of selections) {
    assert.ok(puzzle);
    let state = await service.training.start({ requestId: `imported-${puzzle.id}`, puzzleId: puzzle.id });
    assert.equal(state.training.puzzle.source.license, 'CC-BY-4.0');
    state = await solve(service, state, puzzle);
    assert.equal(state.training.status, 'solved'); assert.equal(state.training.stars, 3);
    assert.equal(state.position.winner, state.game.playerSide);
    assert.equal(state.training.puzzle.source.url, puzzle.source.url);
    const exported = await service.export({ gameId: state.game.id });
    assert.match(exported.pgn, /CCPD实战残局训练/); assert.ok(exported.pgn.includes(puzzle.source.url));
    assert.ok(exported.pgn.includes('CC BY 4.0')); assert.ok(!exported.pgn.includes('原创残局训练'));
  }
});

test('wrong legal learning move retains board, tracks wrong book, and clean retry clears review need', async t => {
  const { service } = await fixture(t), puzzle = one();
  let state = await service.training.start({ requestId: 'learn-wrong-move', puzzleId: puzzle.id });
  const winning = new Set(puzzle.solutions.map(line => line[0]));
  const wrong = state.position.legalMoves.find(move => !winning.has(move.uci));
  assert.ok(wrong);
  const initialFen = state.game.fen, old = state;
  state = await service.play(args(state, 'wrong-once-request', { move: wrong.uci, deferReply: true }));
  assert.equal(state.game.fen, initialFen); assert.equal(state.game.moves.length, 0);
  assert.equal(state.training.status, 'active'); assert.equal(state.training.mistakes, 1);
  assert.equal((await service.training.list({ mistakesOnly: true })).puzzles[0].id, puzzle.id);
  await assert.rejects(service.play(args(old, 'stale-training-version', { move: puzzle.solutions[0][0] })), /已经更新/);
  state = await solve(service, state, puzzle);
  assert.equal(state.training.stars, 2);
  state = await service.training.action(args(state, 'retry-for-three-stars', { action: 'retry' }));
  state = await solve(service, state, puzzle);
  assert.equal(state.training.stars, 3); assert.equal((await service.training.list({ mistakesOnly: true })).puzzles.length, 0);
});

test('multi-turn puzzle uses verified defense and both deferred and combined play work without engine', async t => {
  const { service } = await fixture(t), puzzle = multi();
  let state = await service.training.start({ requestId: 'multi-turn-training', puzzleId: puzzle.id });
  state = await service.play(args(state, 'combined-puzzle-play', { move: puzzle.solutions[0][0] }));
  assert.equal(state.game.moves.length, 2); assert.equal(state.position.turn, state.game.playerSide);
  state = await solve(service, state, puzzle);
  assert.equal(state.training.status, 'solved'); assert.equal(state.position.terminal, true);
  assert.ok(state.training.playerMoves <= puzzle.maxPlayerMoves);
  assert.equal(state.training.solution.steps.at(-1).fen, state.game.fen);
});

test('hint-assisted solve has one star and revealing answer never gives completion credit', async t => {
  const { service } = await fixture(t), puzzle = one();
  let state = await service.training.start({ requestId: 'hint-learning', puzzleId: puzzle.id });
  state = await service.training.action(args(state, 'learn-hint-first', { action: 'hint' }));
  assert.equal(state.training.hints, 1); assert.equal(state.training.solution, undefined);
  assert.equal(state.training.feedback, puzzle.hint);
  state = await solve(service, state, puzzle);
  assert.equal(state.training.stars, 1);
  state = await service.training.start({ requestId: 'reveal-rated', puzzleId: puzzle.id, mode: 'rated' });
  const correct = state.training.summary.correct;
  const request = args(state, 'reveal-answer-once', { action: 'answer' });
  state = await service.training.action(request);
  assert.equal(state.training.status, 'revealed'); assert.equal(state.training.stars, 0);
  assert.equal(state.training.summary.correct, correct); assert.ok(state.training.ratingChange < 0);
  assert.ok(state.training.solution.steps.length); assert.equal(state.game.result, null);
  assert.equal((await service.training.action(request)).duplicate, true);
  assert.ok((await service.export({ gameId: state.game.id })).pgn.includes('[Result "*"]'));
});

test('challenge deadline is server-authoritative; timeout cannot move or award rating', async t => {
  const { service, store, directory } = await fixture(t), puzzle = one();
  let now = 1000000; service.training.now = () => now;
  let state = await service.training.start({ requestId: 'challenge-expiring', puzzleId: puzzle.id, mode: 'challenge', durationSeconds: 180 });
  assert.equal(state.training.challenge.remainingSeconds, 180);
  now += 180001;
  const expired = await service.read(state.game.id);
  const reopened = new Store(directory);
  try {
    assert.equal((await reopened.load(state.game.id)).training.status, 'expired');
    assert.equal(reopened.trainingProfile().challenges.length, 1);
    assert.equal(reopened.trainingProfile().recent.length, 1);
  } finally { reopened.close(); }
  assert.equal((await service.read(state.game.id)).game.version, expired.game.version);
  assert.equal(store.trainingProfile().challenges.length, 1);
  state = expired;
  assert.equal(expired.training.status, 'expired'); assert.equal(expired.training.challenge.finished, true);
  await assert.rejects(service.play(args(state, 'expired-correct-move', { move: puzzle.solutions[0][0], deferReply: true })), /已结束/);
  assert.equal(state.training.status, 'expired'); assert.equal(state.game.moves.length, 0);
  assert.equal(state.training.summary.rating, 1200); assert.equal(store.trainingProfile().correct, 0);
  assert.equal(store.trainingProfile().challenges.length, 1);
  assert.equal((await service.training.action(args(state, 'expired-next', { action: 'next' }))).game.initialFen, state.game.initialFen);
});

test('catalog settles abandoned challenges, including the pause between solved puzzles', async t => {
  const { service, store } = await fixture(t), puzzle = one();
  let now = 1000000; service.training.now = () => now;
  let state = await service.training.start({ requestId: 'challenge-between-items', puzzleId: puzzle.id, mode: 'challenge', durationSeconds: 180 });
  state = await solve(service, state, puzzle);
  assert.equal(state.training.challenge.finished, false);
  now += 180001;
  const catalog = await service.training.list();
  assert.equal(catalog.challenges[0].correct, 1);
  assert.equal(catalog.challenges[0].reason, '时间到');
  assert.equal(store.trainingProfile().recent.length, 1);
  assert.equal((await service.read(state.game.id)).training.status, 'solved');
});

test('hint at the deadline persists timeout and a finished session keeps its original reason', async t => {
  const { service, store } = await fixture(t), puzzle = one();
  let now = 1000000; service.training.now = () => now;
  let state = await service.training.start({ requestId: 'challenge-timeout-hint', puzzleId: puzzle.id, mode: 'challenge', durationSeconds: 180 });
  now += 180001;
  state = await service.training.action(args(state, 'hint-after-timeout', { action: 'hint' }));
  assert.equal(state.training.status, 'expired');
  assert.equal(store.trainingProfile().challenges.length, 1);
  service.training.puzzles = [puzzle];
  state = await service.training.start({ requestId: 'challenge-one-puzzle', puzzleId: puzzle.id, mode: 'challenge', durationSeconds: 180 });
  state = await solve(service, state, puzzle);
  assert.equal(state.training.challenge.reason, '本场题库已完成');
  now += 180001;
  assert.equal((await service.read(state.game.id)).training.challenge.reason, '本场题库已完成');
  assert.equal((await service.training.list()).challenges.length, 2);
});

test('challenge never repeats a puzzle and finishes after three failed items', async t => {
  const { service, store } = await fixture(t);
  let state = await service.training.start({ requestId: 'challenge-three-errors', mode: 'challenge', durationSeconds: 0 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(state.training.puzzle.id);
    state = await service.training.action(args(state, `challenge-answer-${i}`, { action: 'answer' }));
    assert.equal(state.training.challenge.mistakes, i + 1);
    state = await service.training.action(args(state, `challenge-next-${i}`, { action: 'next' }));
  }
  assert.equal(new Set(ids).size, 3); assert.equal(state.training.challenge.finished, true);
  assert.equal(store.trainingProfile().challenges.length, 1); assert.equal(state.training.summary.rating, 1200);
});

test('new training tool schemas reject bad inputs and keep existing board contract', async t => {
  const { service } = await fixture(t), tools = toolDefinitions(service);
  assert.ok((await callTool(tools, 'list_training')).structuredContent.puzzles.length);
  assert.equal((await callTool(tools, 'start_training', { requestId: 'invalid-duration', durationSeconds: 45 })).isError, true);
  assert.equal((await callTool(tools, 'start_training', { requestId: 'invalid-puzzle-id', puzzleId: 'missing' })).isError, true);
  const result = await callTool(tools, 'start_training', { requestId: 'tool-training-start', puzzleId: one().id });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.game.mode, 'training');
  const read = await callTool(tools, 'show_board', { gameId: result.structuredContent.game.id });
  assert.equal(read.structuredContent.training.status, 'active');
});
