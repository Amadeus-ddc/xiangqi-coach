// Keep the visible player move and the engine request in separate phases.
export function optimisticPosition(position, move) {
  const pieces = { ...position.pieces };
  pieces[move.to] = pieces[move.from];
  delete pieces[move.from];
  return { ...position, pieces, legalMoves: [] };
}

const canReply = state => state.game.mode !== 'record' && state.game.status === 'active' && state.position.turn !== state.game.playerSide;

async function reconcile(call, gameId, onCommit) {
  try { const state = await call('read_game', { gameId }); onCommit(state); return state; }
  catch { return null; }
}

export async function replyTurn({ snapshot, call, onCommit, onPhase, paint, requestId }) {
  onPhase('thinking');
  await paint();
  try {
    const next = await call('engine_reply', {
      gameId: snapshot.game.id, expectedVersion: snapshot.game.version, requestId, fast: true,
    });
    onCommit(next);
    return next;
  } catch (error) {
    const synced = await reconcile(call, snapshot.game.id, onCommit);
    if (synced && synced.game.version > snapshot.game.version && !canReply(synced)) return synced;
    throw Object.assign(new Error(synced
      ? `教练应手未完成，已同步棋盘。${error.message}可点击“继续应手”重试。`
      : `暂时无法确认教练是否已应手，请先刷新棋盘。${error.message}`), { needsRefresh: !synced });
  } finally { onPhase(null); }
}

export async function playTurn({ snapshot, move, call, onPreview, onCommit, onPhase, paint, requestId, replyRequestId }) {
  onPhase('saving');
  onPreview({ position: optimisticPosition(snapshot.position, move), move });
  let next;
  try {
    next = await call('play_move', {
      gameId: snapshot.game.id, expectedVersion: snapshot.game.version,
      requestId, move: move.uci, deferReply: true,
    });
  } catch (error) {
    onPreview(null);
    const synced = await reconcile(call, snapshot.game.id, onCommit);
    onPhase(null);
    throw Object.assign(new Error(synced ? `已同步棋盘。${error.message}` : `落子结果尚未确认，请先刷新棋盘。${error.message}`), { needsRefresh: !synced });
  }
  onCommit(next);
  // Commit before clearing the preview so a rendering client never flashes the old board.
  onPreview(null);
  if (next.game.autoReply && canReply(next)) {
    return replyTurn({ snapshot: next, call, onCommit, onPhase, paint, requestId: replyRequestId });
  }
  onPhase(null);
  return next;
}

export function teachingMessage(prompt, evidence, contextDelivered = true) {
  if (evidence.boardDelivery) {
    const visible = `${prompt}请把回答放在棋盘内的讲解栏，我要边看棋边读。`;
    return contextDelivered ? visible : `${visible}\n请先用 read_lesson(includeEvidence=true) 读取棋局 ${evidence.gameId}、讲解请求 ${evidence.requestId}，再用 publish_lesson 写回原棋盘。`;
  }
  const location = evidence.fromPly !== undefined
    ? `第 ${evidence.fromPly + 1}–${evidence.toPly} 手`
    : `第 ${evidence.analysis?.ply ?? 0} 手后的局面`;
  return `${prompt}\n针对这次点选的${location}回答。棋局 ${evidence.gameId}，版本 ${evidence.version}。` +
    (contextDelivered ? '已提供对应的验证证据，请直接简短回答。' : '请先读取这个指定回合的工具证据，再简短回答。') +
    '只讲解，不落子；即使我已继续走棋，也不要混入后来的局面。';
}

export function hintEvidence(result, game) {
  if (result.gameId !== game.id || result.version !== game.version || result.analysis.rootFen !== game.fen) {
    throw new Error('棋局已改变，请重新选择想要提示的局面。');
  }
  const { rootFen, rootTurn, ply, engine, requestedMs, best, terminal } = result.analysis;
  const line = best && { chinese: best.chinese, score: best.score, depth: best.depth, steps: best.steps.slice(0, 4) };
  return { gameId: game.id, version: game.version, analysis: { rootFen, rootTurn, ply, engine, requestedMs, best: line, terminal } };
}

export async function sendTeaching({ app, prompt, evidence }) {
  const caps = app.getHostCapabilities();
  if (!caps?.message) throw new Error('当前入口不能从棋盘发送消息，可以在对话里直接问原因。');
  let contextDelivered = false;
  if (caps.updateModelContext) {
    try {
      const update = await app.updateModelContext({ structuredContent: {
        ...evidence,
        teachingRequest: {
          prompt,
          instructions: '这些是本地规则与皮卡鱼已校验的固定局面证据。双方实走看 played，best 是分析建议。先给原因，再举2–4个中文着法，默认100–180字。只要提示时仅给观察方向，不公布答案或变例。证据充分时不要重复读取或分析；额外变化才用工具验证。',
        },
      } });
      contextDelivered = !update?.isError;
    } catch { /* Hosts without context support can fetch evidence through tools. */ }
  }
  const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: teachingMessage(prompt, evidence, contextDelivered) }] });
  if (result.isError) throw new Error('对话没有接受讲解请求，请重试。');
}
