import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Rules, START_FEN, material } from '../server/rules.mjs';
import { Store } from '../server/store.mjs';
import { GameService } from '../server/game.mjs';
import { toolDefinitions, callTool } from '../server/mcp.mjs';

const rules = new Rules();
class FixtureEngine {
  calls = [];
  async analyze(options) {
    this.calls.push(options);
    const position = await rules.inspect(options.initialFen, options.moves);
    const selected = options.searchMoves?.length ? options.searchMoves : position.legalMoves.slice(0, options.multiPV ?? 3).map(move => move.uci);
    const lines = [];
    for (const [index, uci] of selected.entries()) {
      let current = await rules.inspect(position.fen, [uci]);
      const pv = [uci];
      // Longer lines ensure the explanation verifies and reports the shortened
      // endpoint, rather than reusing material totals from a longer variation.
      while (!current.terminal && pv.length < 6) {
        const next = current.legalMoves.find(move => current.pieces[move.to]) ?? current.legalMoves[0];
        pv.push(next.uci);
        current = await rules.inspect(current.fen, [next.uci]);
      }
      lines.push({ rank: index + 1, depth: 10, nodes: 100, score: { type: 'cp', value: 20 - index, bound: 'exact', perspective: 'side_to_move' }, pv });
    }
    return { engine: 'turn fixture', bestmove: selected[0], requestedMs: options.movetime, lines };
  }
  close() {}
}
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'xiangqi-turn-test-'));
  const store = new Store(directory), engine = new FixtureEngine();
  const service = new GameService({ rules, store, engine, movetime: 150 });
  t.after(async () => { engine.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, engine, directory };
}
const args = (game, requestId, extra = {}) => ({ gameId: game.id, expectedVersion: game.version, requestId, ...extra });
async function exchange(service, requestId = 'turn-flow', move = 'h2e2') {
  const initial = await service.newGame({ requestId });
  const user = await service.play(args(initial.game, `${requestId}-user`, { move, deferReply: true }));
  return service.engineReply(args(user.game, `${requestId}-coach`, { fast: true }));
}

test('deferred move is saved without waiting for or calling an unavailable engine', async t => {
  const { service, engine, store } = await fixture(t);
  const initial = await service.newGame({ requestId: 'deferred-move' });
  engine.analyze = () => { throw new Error('must not reach engine'); };
  const request = args(initial.game, 'deferred-user', { move: 'h2e2', deferReply: true });
  const result = await service.play(request);
  assert.equal(result.game.moves.length, 1);
  assert.equal(result.game.version, 1);
  assert.equal(result.position.turn, 'b');
  assert.equal(result.game.lastLesson.userMove.analysisPending, true);
  assert.equal(result.game.lastLesson.userMove.played.chinese, '炮二平五');
  assert.equal(result.game.lastLesson.engineMove, undefined);
  assert.equal((await store.load(initial.game.id)).fen, result.game.fen);
  assert.equal((await service.play(request)).duplicate, true);
  await assert.rejects(service.play({ ...request, deferReply: false }), /请求编号/);
  await assert.rejects(service.play(args(result.game, 'second-red', { move: 'b0c2', deferReply: true })), /轮到教练|合法走法/);
});

test('a failed fast reply leaves the user move saved and can be retried idempotently', async t => {
  const { service, engine } = await fixture(t);
  const initial = await service.newGame({ requestId: 'reply-retry' });
  const user = await service.play(args(initial.game, 'reply-retry-user', { move: 'h2e2', deferReply: true }));
  const analyze = engine.analyze.bind(engine);
  engine.analyze = async () => { throw new Error('engine temporarily unavailable'); };
  const request = args(user.game, 'retry-coach', { fast: true });
  await assert.rejects(service.engineReply(request), /temporarily unavailable/);
  assert.deepEqual((await service.read(initial.game.id)).game, user.game);
  engine.analyze = analyze;
  const replied = await service.engineReply(request);
  assert.equal(replied.game.version, 2); assert.equal(replied.game.moves.length, 2);
  assert.equal(engine.calls.length, 1); assert.equal(engine.calls[0].multiPV, 1);
  assert.deepEqual(engine.calls[0].moves, ['h2e2']);
  assert.equal(replied.game.lastLesson.userMove.ply, 0);
  assert.equal(replied.game.lastLesson.engineMove.ply, 1);
  assert.equal((await service.engineReply(request)).duplicate, true);
  assert.equal(engine.calls.length, 1);
});

test('concurrent deferred clicks and coach retries commit exactly one move each', async t => {
  const { service, engine, directory } = await fixture(t);
  const otherStore = new Store(directory);
  const other = new GameService({ rules, store: otherStore, engine, movetime: 150 });
  t.after(() => otherStore.close());
  const initial = await service.newGame({ requestId: 'split-concurrent' });
  const users = await Promise.allSettled([
    service.play(args(initial.game, 'split-user-a', { move: 'h2e2', deferReply: true })),
    other.play(args(initial.game, 'split-user-b', { move: 'b0c2', deferReply: true })),
  ]);
  assert.equal(users.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(engine.calls.length, 0);
  const user = await service.read(initial.game.id);
  assert.equal(user.game.moves.length, 1);
  const replies = await Promise.allSettled([
    service.engineReply(args(user.game, 'split-coach-a', { fast: true })),
    other.engineReply(args(user.game, 'split-coach-b', { fast: true })),
  ]);
  assert.equal(replies.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await service.read(initial.game.id)).game.moves.length, 2);
  assert.equal(engine.calls.length, 1);
});

test('explanation reuses one cached request and returns legal compact evidence for both actual moves', async t => {
  const { service, engine, store } = await fixture(t);
  const played = await exchange(service);
  const before = await store.load(played.game.id);
  const request = { gameId: played.game.id, expectedVersion: played.game.version, ply: 2 };
  const [first, concurrent] = await Promise.all([service.explainTurn(request), service.explainTurn(request)]);
  const calls = engine.calls.length;
  const cached = await service.explainTurn(request);
  assert.deepEqual(first, concurrent); assert.deepEqual(first, cached);
  assert.equal(engine.calls.length, calls);
  assert.deepEqual(Object.keys(first).sort(), ['fromPly', 'gameId', 'lesson', 'notes', 'toPly', 'version']);
  assert.equal(first.fromPly, 0); assert.equal(first.toPly, 2);
  for (const [role, expected] of [['userMove', played.game.moves[0]], ['engineMove', played.game.moves[1]]]) {
    const evidence = first.lesson[role];
    assert.equal(evidence.rootFen, expected.beforeFen);
    assert.equal(evidence.rootTurn, expected.side);
    assert.equal(evidence.ply, expected.ply - 1);
    assert.equal(evidence.played.move, expected.uci);
    assert.equal(evidence.position, undefined);
    for (const line of [...evidence.candidates, evidence.best, evidence.played]) {
      assert.ok(line.steps.length <= 4);
      const final = await rules.inspect(evidence.rootFen, line.steps.map(step => step.uci));
      assert.equal(final.fen, line.finalFen);
      assert.deepEqual(line.materialAfter, material(final.pieces));
      assert.deepEqual(line.pv, line.steps.map(step => step.uci));
    }
  }
  assert.doesNotMatch(JSON.stringify(first), /"(?:position|legalMoves|pieces|moves|receipts)":/);
  assert.deepEqual(await store.load(played.game.id), before);
  first.lesson.userMove.played.chinese = 'changed by caller';
  assert.equal((await service.explainTurn(request)).lesson.userMove.played.chinese, '炮二平五');
  await assert.rejects(service.explainTurn({ ...request, expectedVersion: 0 }), /棋局已经更新/);
  assert.equal(engine.calls.length, calls);
});

test('explanation failures are not cached and undo/replay cannot reuse the old turn', async t => {
  const { service, engine } = await fixture(t);
  const played = await exchange(service, 'cache-branch');
  const request = { gameId: played.game.id, expectedVersion: played.game.version };
  const analyze = engine.analyze.bind(engine);
  engine.analyze = async () => { throw new Error('analysis failed'); };
  await assert.rejects(service.explainTurn(request), /analysis failed/);
  engine.analyze = analyze;
  const first = await service.explainTurn(request);
  const undone = await service.undo(args(played.game, 'undo-cached-turn'));
  const user = await service.play(args(undone.game, 'branch-user', { move: 'b0c2', deferReply: true }));
  const secondTurn = await service.engineReply(args(user.game, 'branch-coach', { fast: true }));
  const calls = engine.calls.length;
  const second = await service.explainTurn({ gameId: secondTurn.game.id });
  assert.ok(engine.calls.length > calls);
  assert.equal(first.lesson.userMove.played.move, 'h2e2');
  assert.equal(second.lesson.userMove.played.move, 'b0c2');
  assert.notEqual(second.version, first.version);
});

test('an in-flight explanation remains tied to its original turn and never writes over an undo', async t => {
  const { service, engine, store } = await fixture(t);
  const played = await exchange(service, 'in-flight');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const analyze = engine.analyze.bind(engine);
  engine.analyze = async options => { entered.resolve(); await release.promise; return analyze(options); };
  t.after(() => release.resolve());
  const pending = service.explainTurn({ gameId: played.game.id, expectedVersion: played.game.version, ply: 2 });
  await entered.promise;
  const undone = await service.undo(args(played.game, 'undo-during-analysis'));
  release.resolve();
  const explanation = await pending;
  assert.equal(explanation.version, played.game.version);
  assert.equal(explanation.toPly, 2);
  assert.equal(explanation.lesson.userMove.played.move, 'h2e2');
  const stored = await store.load(played.game.id);
  assert.equal(stored.version, undone.game.version);
  assert.equal(stored.fen, START_FEN); assert.equal(stored.moves.length, 0);
  assert.equal(stored.lastLesson, null);
});

test('historical turns, black openings and terminal user moves select the correct evidence roots', async t => {
  const { service } = await fixture(t);
  const black = await service.newGame({ requestId: 'black-explanation', playerSide: 'b' });
  const opening = await service.explainTurn({ gameId: black.game.id, ply: 1 });
  assert.equal(opening.lesson.userMove, undefined);
  assert.equal(opening.lesson.engineMove.ply, 0);
  const user = await service.play(args(black.game, 'black-user', { move: black.position.legalMoves[0].uci, deferReply: true }));
  await assert.rejects(service.explainTurn({ gameId: black.game.id }), /尚未应手/);
  const replied = await service.engineReply(args(user.game, 'black-coach', { fast: true }));
  const turn = await service.explainTurn({ gameId: black.game.id, ply: 2 });
  assert.equal(turn.fromPly, 1); assert.equal(turn.toPly, 3);
  assert.equal(turn.lesson.userMove.rootTurn, 'b');
  assert.equal(turn.lesson.engineMove.rootTurn, 'r');
  assert.equal((await service.explainTurn({ gameId: black.game.id, ply: 1 })).toPly, 1);
  assert.equal(replied.game.moves.length, 3);

  const beforeMate = '4k4/3R1R1N1/9/9/9/9/9/9/9/5K3 r';
  const mating = await service.newGame({ requestId: 'terminal-explanation', fen: beforeMate });
  const ended = await service.play(args(mating.game, 'mate-user', { move: 'f8e8', deferReply: true }));
  assert.equal(ended.game.status, 'finished');
  const terminal = await service.explainTurn({ gameId: ended.game.id });
  assert.equal(terminal.lesson.engineMove, undefined);
  assert.equal(terminal.lesson.userMove.played.move, 'f8e8');
  assert.equal(terminal.toPly, 1);
});

test('MCP schemas expose opt-in split turns and read-only explanation with legacy defaults', async t => {
  const { service, engine } = await fixture(t);
  const definitions = toolDefinitions(service);
  assert.equal(definitions.find(tool => tool.name === 'explain_turn').annotations.readOnlyHint, true);
  const initial = await service.newGame({ requestId: 'schema-split' });
  const user = await callTool(definitions, 'play_move', args(initial.game, 'schema-user', { move: 'h2e2', deferReply: true }));
  assert.equal(user.structuredContent.game.moves.length, 1);
  assert.equal(engine.calls.length, 0);
  const replied = await callTool(definitions, 'engine_reply', args(user.structuredContent.game, 'schema-coach', { fast: true }));
  assert.equal(replied.structuredContent.game.moves.length, 2);
  assert.equal(engine.calls.length, 1);
  const explanation = await callTool(definitions, 'explain_turn', { gameId: initial.game.id, expectedVersion: replied.structuredContent.game.version, ply: 2 });
  assert.equal(explanation.structuredContent.toPly, 2);
  assert.equal((await callTool(definitions, 'explain_turn', { gameId: initial.game.id, ply: 0 })).isError, true);
});

test('an inconsistent forced-search variation is rejected instead of describing another played move', async t => {
  const { service, engine } = await fixture(t);
  const played = await exchange(service, 'inconsistent-pv');
  const analyze = engine.analyze.bind(engine);
  engine.analyze = async options => {
    if (!options.searchMoves?.length) return analyze(options);
    const result = await analyze({ ...options, searchMoves: [] });
    return { ...result, bestmove: options.searchMoves[0] };
  };
  await assert.rejects(service.explainTurn({ gameId: played.game.id }), /指定着法的变例与搜索结果不一致/);
  assert.equal((await service.read(played.game.id)).game.version, played.game.version);
});

test('explanation reuses the matching scored coach search, but analyzes the user and rejects mismatched or differently budgeted evidence', async t => {
  const { service, store, engine } = await fixture(t);
  const played = await exchange(service, 'reuse-coach-search');
  const stored = await store.load(played.game.id);
  const before = engine.calls.length;
  const lesson = await service.explainTurn({ gameId: played.game.id });
  const freshSearches = engine.calls.slice(before);
  assert.ok(freshSearches.some(options => options.moves.length === 0), 'pending user facts still require evaluation');
  assert.ok(freshSearches.every(options => options.moves.length === 0), 'the coach root must not be searched a second time');
  assert.equal(lesson.lesson.userMove.source, 'on_demand_search');
  assert.equal(lesson.lesson.engineMove.source, 'reply_search');
  assert.match(lesson.lesson.engineMove.sourceNote, /没有重新搜索/);
  assert.deepEqual(lesson.lesson.engineMove.played.score, stored.lastLesson.engineMove.best.score);
  assert.equal(lesson.lesson.engineMove.played.move, played.game.moves[1].uci);
  assert.deepEqual(await store.load(played.game.id), stored, 'reusing evidence remains read-only');

  for (const mismatch of [
    saved => { saved.rootFen = START_FEN; },
    saved => { saved.ply++; },
    saved => { saved.best.move = 'h2e2'; },
    saved => { saved.rootHistoryHash = 'different history'; },
    saved => { saved.requestedMs++; },
    saved => { delete saved.best.score; },
  ]) {
    const changed = structuredClone(stored);
    mismatch(changed.lastLesson.engineMove);
    await store.save(changed);
    const calls = engine.calls.length;
    const fallback = await service.explainTurn({ gameId: played.game.id });
    assert.ok(engine.calls.slice(calls).some(options => options.moves.length === 1));
    assert.equal(fallback.lesson.engineMove.source, 'on_demand_search');
  }
  await store.save(stored);
  service.movetime += 25;
  const beforeBudget = engine.calls.length;
  const changedBudget = await service.explainTurn({ gameId: played.game.id });
  assert.ok(engine.calls.slice(beforeBudget).some(options => options.moves.length === 1 && options.movetime === service.movetime));
  assert.equal(changedBudget.lesson.engineMove.source, 'on_demand_search');

  // Older combined replies contain longer lines. Reuse must recompute facts
  // for the displayed four-ply endpoint, not carry over its six-ply material.
  const opening = await service.newGame({ requestId: 'reuse-long-opening', playerSide: 'b' });
  assert.ok(opening.game.lastLesson.engineMove.best.steps.length > 4);
  const beforeOpening = engine.calls.length;
  const openingLesson = await service.explainTurn({ gameId: opening.game.id });
  assert.equal(engine.calls.length, beforeOpening);
  const line = openingLesson.lesson.engineMove.played;
  assert.equal(line.steps.length, 4);
  const endpoint = await rules.inspect(opening.game.initialFen, line.steps.map(step => step.uci));
  assert.equal(line.finalFen, endpoint.fen);
  assert.deepEqual(line.materialAfter, material(endpoint.pieces));
});
