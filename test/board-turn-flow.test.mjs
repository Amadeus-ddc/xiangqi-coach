import test from 'node:test';
import assert from 'node:assert/strict';
import { hintEvidence, optimisticPosition, playTurn, sendTeaching, teachingMessage } from '../web/turn-flow.mjs';

const move = { from: 'h2', to: 'e2', uci: 'h2e2', chinese: '炮二平五' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function positions({ autoReply = true, status = 'active' } = {}) {
  const initial = {
    game: { id: 'game-one', version: 7, playerSide: 'r', autoReply, status: 'active' },
    position: { turn: 'r', pieces: { e0: 'rK', h2: 'rC', h9: 'bN', e9: 'bK' }, legalMoves: [move] },
  };
  const player = {
    game: { ...initial.game, version: 8, status },
    position: { turn: 'b', pieces: { e0: 'rK', e2: 'rC', h9: 'bN', e9: 'bK' }, legalMoves: [] },
  };
  const coach = {
    game: { ...player.game, version: 9 },
    position: { turn: 'r', pieces: { e0: 'rK', e2: 'rC', g7: 'bN', e9: 'bK' }, legalMoves: [] },
  };
  return { initial, player, coach };
}
function view(initial) {
  let committed = initial, preview = null, phase = null;
  const commits = [], events = [], frames = [];
  return {
    commits, events, frames,
    get visible() { return preview?.position ?? committed.position; },
    get committed() { return committed; },
    get phase() { return phase; },
    onPreview(value) { preview = value; events.push(value ? 'preview-player' : 'clear-preview'); frames.push(preview?.position ?? committed.position); },
    onCommit(value) { committed = value; commits.push(value); events.push(`commit-${value.game.version}`); frames.push(preview?.position ?? committed.position); },
    onPhase(value) { phase = value; events.push(`phase-${value}`); },
  };
}
function options(initial, visible, call, paint = () => Promise.resolve()) {
  return {
    snapshot: initial, move, call, paint,
    onPreview: visible.onPreview, onCommit: visible.onCommit, onPhase: visible.onPhase,
    requestId: 'player-click', replyRequestId: 'coach-response',
  };
}

test('player lands before the request returns; coach waits for committed board to paint', { timeout: 2000 }, async () => {
  const { initial, player, coach } = positions();
  const visible = view(initial);
  const save = deferred(), painted = deferred(), paintStarted = deferred();
  const reply = deferred(), replyStarted = deferred(), calls = [];
  const pending = playTurn(options(initial, visible, (name, args) => {
    calls.push({ name, args });
    if (name === 'play_move') return save.promise;
    assert.equal(name, 'engine_reply', 'normal play must not call explanation or analysis tools');
    replyStarted.resolve();
    return reply.promise;
  }, () => {
    visible.events.push('paint-start');
    paintStarted.resolve();
    return painted.promise;
  }));
  // No Promise has resolved: the clicked piece must already be on its destination.
  assert.equal(visible.visible.pieces.e2, 'rC');
  assert.equal(visible.visible.pieces.h2, undefined);
  assert.equal(visible.visible.pieces.h9, 'bN');
  assert.equal(visible.phase, 'saving');
  assert.equal(visible.committed, initial);
  assert.deepEqual(visible.commits, []);
  assert.deepEqual(calls.map(call => call.name), ['play_move']);
  assert.deepEqual(calls[0].args, {
    gameId: 'game-one', expectedVersion: 7, requestId: 'player-click', move: 'h2e2', deferReply: true,
  });

  save.resolve(player);
  await paintStarted.promise;
  assert.equal(visible.committed, player);
  assert.equal(visible.visible, player.position);
  assert.equal(visible.phase, 'thinking');
  assert.deepEqual(calls.map(call => call.name), ['play_move'], 'engine cannot start before the paint boundary');
  assert.ok(visible.events.indexOf('commit-8') < visible.events.indexOf('paint-start'));
  painted.resolve();
  await replyStarted.promise;
  assert.equal(visible.visible, player.position, 'waiting for the coach must retain the committed player position');
  assert.equal(visible.visible.pieces.h9, 'bN', 'the coach piece cannot move before its response arrives');
  assert.deepEqual(calls[1].args, {
    gameId: 'game-one', expectedVersion: 8, requestId: 'coach-response', fast: true,
  });
  reply.resolve(coach);
  assert.equal(await pending, coach);
  assert.deepEqual(visible.commits, [player, coach]);
  assert.equal(visible.visible.pieces.g7, 'bN');
  assert.equal(visible.visible.pieces.h9, undefined);
  assert.equal(visible.phase, null);
  assert.deepEqual(calls.map(call => call.name), ['play_move', 'engine_reply'], 'successful play must not request teaching');
  assert.ok(visible.frames.every(frame => frame.pieces.e2 === 'rC' && !frame.pieces.h2), 'save confirmation must never flash the pre-move board between preview and commit');
  assert.equal(initial.position.pieces.h2, 'rC', 'optimistic rendering must not mutate the saved snapshot');
});

test('manual play commits the player move without starting an engine response', async () => {
  const { initial, player } = positions({ autoReply: false });
  const visible = view(initial), calls = [];
  const result = await playTurn(options(initial, visible, async name => {
    calls.push(name);
    assert.equal(name, 'play_move');
    return player;
  }, () => assert.fail('manual play must not wait for an engine paint phase')));
  assert.equal(result, player);
  assert.equal(visible.visible, player.position);
  assert.equal(visible.phase, null);
  assert.deepEqual(calls, ['play_move']);
});

test('terminal or adjudication-paused positions never request a coach move', async t => {
  for (const status of ['finished', 'review_required']) await t.test(status, async () => {
    const { initial, player } = positions({ status });
    const visible = view(initial), calls = [];
    assert.equal(await playTurn(options(initial, visible, async name => {
      calls.push(name);
      assert.equal(name, 'play_move');
      return player;
    }, () => assert.fail('a stopped game must not enter engine thinking'))), player);
    assert.deepEqual(calls, ['play_move']);
    assert.equal(visible.visible, player.position);
    assert.equal(visible.phase, null);
  });
});

test('rejected player move removes its preview and reads authoritative state before returning an error', { timeout: 2000 }, async () => {
  const { initial, coach: authoritative } = positions();
  const visible = view(initial), save = deferred(), read = deferred(), reading = deferred(), calls = [];
  const pending = playTurn(options(initial, visible, (name, args) => {
    calls.push({ name, args });
    if (name === 'play_move') return save.promise;
    assert.equal(name, 'read_game');
    reading.resolve();
    return read.promise;
  }, () => assert.fail('a rejected move must not request an engine response')));
  assert.equal(visible.visible.pieces.e2, 'rC');
  save.reject(new Error('棋局已经更新'));
  await reading.promise;
  assert.equal(visible.visible, initial.position, 'the rejected preview disappears while authoritative state is loading');
  assert.deepEqual(visible.commits, []);
  assert.deepEqual(calls[1], { name: 'read_game', args: { gameId: 'game-one' } });
  read.resolve(authoritative);
  await assert.rejects(pending, /已同步棋盘。棋局已经更新/);
  assert.equal(visible.visible, authoritative.position);
  assert.deepEqual(visible.commits, [authoritative]);
  assert.equal(visible.phase, null);
  assert.deepEqual(calls.map(call => call.name), ['play_move', 'read_game']);
});

test('failed coach response retains the committed player position during authoritative read-back', { timeout: 2000 }, async () => {
  const { initial, player } = positions();
  const visible = view(initial);
  const reply = deferred(), replying = deferred(), read = deferred(), reading = deferred(), calls = [];
  const pending = playTurn(options(initial, visible, (name, args) => {
    calls.push({ name, args });
    if (name === 'play_move') return Promise.resolve(player);
    if (name === 'engine_reply') { replying.resolve(); return reply.promise; }
    assert.equal(name, 'read_game');
    reading.resolve();
    return read.promise;
  }));
  await replying.promise;
  assert.equal(visible.visible, player.position);
  reply.reject(new Error('连接中断'));
  await reading.promise;
  assert.equal(visible.visible, player.position, 'an engine error cannot rewind a successfully saved player move');
  assert.equal(visible.committed.game.version, 8);
  assert.deepEqual(calls.at(-1), { name: 'read_game', args: { gameId: 'game-one' } });
  read.resolve(player);
  await assert.rejects(pending, error => {
    assert.match(error.message, /教练应手未完成，已同步棋盘。连接中断/);
    assert.equal(error.needsRefresh, false, 'successful read-back permits a deliberate retry');
    return true;
  });
  assert.equal(visible.visible, player.position);
  assert.deepEqual(visible.commits, [player, player]);
  assert.equal(visible.phase, null);
  assert.deepEqual(calls.map(call => call.name), ['play_move', 'engine_reply', 'read_game']);
});

test('lost coach response resolves successfully when read-back proves that reply already committed', { timeout: 2000 }, async () => {
  const { initial, player, coach } = positions();
  const visible = view(initial);
  const reply = deferred(), replying = deferred(), read = deferred(), reading = deferred(), calls = [];
  const pending = playTurn(options(initial, visible, (name, args) => {
    calls.push({ name, args });
    if (name === 'play_move') return Promise.resolve(player);
    if (name === 'engine_reply') { replying.resolve(); return reply.promise; }
    assert.equal(name, 'read_game');
    reading.resolve();
    return read.promise;
  }));
  await replying.promise;
  reply.reject(new Error('应手结果传输中断'));
  await reading.promise;
  assert.equal(visible.visible, player.position);
  assert.deepEqual(calls.at(-1), { name: 'read_game', args: { gameId: player.game.id } });
  assert.equal(coach.game.id, player.game.id);
  assert.ok(coach.game.version > player.game.version);
  assert.equal(coach.position.turn, player.game.playerSide);
  read.resolve(coach);
  assert.equal(await pending, coach, 'confirmed completion resolves without an unfinished-turn error');
  assert.equal(visible.visible, coach.position);
  assert.deepEqual(visible.commits, [player, coach]);
  assert.equal(visible.phase, null);
  assert.deepEqual(calls.map(call => call.name), ['play_move', 'engine_reply', 'read_game'], 'recovery must not duplicate the coach move');
});

test('an unconfirmed player or coach request flags needsRefresh when authoritative read-back also fails', async t => {
  for (const stage of ['play_move', 'engine_reply']) await t.test(stage, async () => {
    const { initial, player } = positions();
    const visible = view(initial), calls = [];
    await assert.rejects(playTurn(options(initial, visible, async name => {
      calls.push(name);
      if (name === stage) throw new Error('请求结果未知');
      if (name === 'play_move') return player;
      assert.equal(name, 'read_game');
      throw new Error('无法读取棋局');
    })), error => {
      assert.equal(error.needsRefresh, true, 'the UI must lock further moves until a refresh confirms the game');
      assert.match(error.message, /请先刷新棋盘/);
      return true;
    });
    assert.equal(visible.visible, stage === 'play_move' ? initial.position : player.position,
      'the fallback is the last confirmed position, never the rejected preview');
    assert.deepEqual(visible.commits, stage === 'play_move' ? [] : [player]);
    assert.equal(visible.phase, null);
    assert.deepEqual(calls, stage === 'play_move'
      ? ['play_move', 'read_game'] : ['play_move', 'engine_reply', 'read_game']);
  });
});

test('optimistic capture replaces the captured piece without changing authoritative board data', () => {
  const position = {
    turn: 'r', pieces: { h2: 'rC', h9: 'bN', e9: 'bK' },
    legalMoves: [{ from: 'h2', to: 'h9', uci: 'h2h9' }],
  };
  const before = structuredClone(position);
  const preview = optimisticPosition(position, position.legalMoves[0]);
  assert.deepEqual(preview.pieces, { h9: 'rC', e9: 'bK' });
  assert.deepEqual(preview.legalMoves, [], 'optimistic pieces cannot be used for another unconfirmed move');
  assert.deepEqual(position, before);
});

test('visible teaching request freezes its game and version without exposing the answer', () => {
  const evidence = {
    gameId: 'old-board', version: 12, fromPly: 4, toPly: 6,
    played: { chinese: '炮二平五', steps: [{ chinese: '马８进７' }, { chinese: '马二进三' }] },
    best: { chinese: '马二进三' }, observation: '中炮控制中路，七路马保护中卒。',
  };
  const message = teachingMessage('讲讲刚才这一回合。', evidence);
  // A later board switch or move must not rewrite an already queued explanation.
  evidence.gameId = 'new-board';
  evidence.version = 20;
  evidence.played.chinese = '车一平二';
  evidence.played.steps.push({ chinese: '车９平８' });
  assert.match(message, /^讲讲刚才这一回合。\n/);
  assert.ok(message.includes('棋局 old-board，版本 12'));
  assert.ok(message.includes('第 5–6 手'));
  assert.ok(!message.includes('new-board'));
  assert.ok(!message.includes('车一平二'));
  for (const hidden of ['炮二平五', '马８进７', '马二进三', '中炮控制中路', '"best"']) {
    assert.ok(!message.includes(hidden), `visible request must not reveal ${hidden}`);
  }
  assert.ok(message.includes('只讲解，不落子'));
});

function hintFixture() {
  const game = { id: 'hint-game', version: 12, fen: 'the-selected-position' };
  const result = {
    gameId: game.id, version: game.version,
    analysis: {
      rootFen: game.fen, rootTurn: 'r', ply: 6, engine: 'Pikafish fixture', requestedMs: 350,
      best: {
        chinese: '马二进三', score: { type: 'cp', value: 31 }, depth: 18,
        steps: ['马二进三', '马８进７', '车一平二', '车９平８', '兵七进一', '卒７进１']
          .map((chinese, ply) => ({ chinese, ply, captured: null })),
      },
      candidates: [{ chinese: '炮二平五' }],
    },
  };
  return { game, result };
}

test('teaching sends verified evidence through model context before the short visible request', { timeout: 2000 }, async () => {
  const { game, result } = hintFixture();
  const evidence = hintEvidence(result, game);
  const context = deferred(), events = [], contexts = [], messages = [];
  const app = {
    getHostCapabilities: () => ({ message: {}, updateModelContext: {} }),
    updateModelContext(value) {
      events.push('context-start');
      contexts.push(value);
      return context.promise;
    },
    async sendMessage(value) { events.push('message'); messages.push(value); return {}; },
  };
  const pending = sendTeaching({ app, prompt: '给我一个方向提示，先别告诉我走法。', evidence });
  assert.deepEqual(events, ['context-start']);
  assert.deepEqual(messages, [], 'the visible request cannot run before its evidence delivery settles');
  assert.equal(contexts[0].structuredContent.gameId, game.id);
  assert.equal(contexts[0].structuredContent.version, game.version);
  assert.equal(contexts[0].structuredContent.analysis.best.chinese, '马二进三');
  assert.deepEqual(contexts[0].structuredContent.analysis.best.steps, result.analysis.best.steps.slice(0, 4));
  assert.match(contexts[0].structuredContent.teachingRequest.instructions, /不公布答案或变例/);
  context.resolve({});
  await pending;
  assert.deepEqual(events, ['context-start', 'message']);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.length, 1);
  const visible = messages[0].content[0].text;
  assert.ok(visible.includes('已提供对应的验证证据'));
  assert.ok(visible.includes('棋局 hint-game，版本 12'));
  for (const step of result.analysis.best.steps) assert.ok(!visible.includes(step.chinese), 'a direction hint must not expose its solution');
  assert.ok(!visible.includes('the-selected-position'));
  assert.ok(!visible.includes('"analysis"'));
});

test('missing or failed model context tells the conversation to obtain evidence instead of claiming delivery', async t => {
  for (const failure of ['unsupported', 'throws', 'isError']) await t.test(failure, async () => {
    const { game, result } = hintFixture();
    const evidence = hintEvidence(result, game);
    const events = [], messages = [];
    const app = {
      getHostCapabilities: () => ({ message: {}, ...(failure === 'unsupported' ? {} : { updateModelContext: {} }) }),
      async updateModelContext() {
        events.push('context');
        assert.notEqual(failure, 'unsupported', 'unsupported context must not be called');
        if (failure === 'throws') throw new Error('context connection unavailable');
        return { isError: true };
      },
      async sendMessage(value) { events.push('message'); messages.push(value); return {}; },
    };
    await sendTeaching({ app, prompt: '给我一点提示。', evidence });
    assert.deepEqual(events, failure === 'unsupported' ? ['message'] : ['context', 'message']);
    const visible = messages[0].content[0].text;
    assert.ok(visible.includes('请先读取这个指定回合的工具证据'));
    assert.ok(!visible.includes('已提供'));
    assert.ok(visible.includes('棋局 hint-game，版本 12'));
    assert.ok(visible.includes('第 6 手后的局面'));
    assert.ok(!visible.includes(result.analysis.best.chinese));
    assert.ok(!visible.includes('"analysis"'));
  });
});

test('hint evidence keeps four verified Chinese moves and rejects a different game, version or position', async t => {
  const { game, result } = hintFixture();
  const before = structuredClone(result);
  const evidence = hintEvidence(result, game);
  assert.equal(evidence.gameId, game.id);
  assert.equal(evidence.version, game.version);
  assert.equal(evidence.analysis.rootFen, game.fen);
  assert.equal(evidence.analysis.ply, 6);
  assert.deepEqual(evidence.analysis.best.steps, result.analysis.best.steps.slice(0, 4));
  assert.equal(evidence.analysis.best.chinese, '马二进三');
  assert.deepEqual(evidence.analysis.best.score, { type: 'cp', value: 31 });
  assert.equal(evidence.analysis.candidates, undefined);
  assert.deepEqual(result, before, 'making compact context must not shorten the cached original analysis');
  for (const mismatch of ['gameId', 'version', 'rootFen']) await t.test(mismatch, () => {
    const stale = structuredClone(result);
    if (mismatch === 'gameId') stale.gameId = 'another-game';
    if (mismatch === 'version') stale.version--;
    if (mismatch === 'rootFen') stale.analysis.rootFen = 'a-position-before-undo';
    assert.throws(() => hintEvidence(stale, game), /棋局已改变/);
  });
});
