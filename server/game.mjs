import { createHash } from 'node:crypto';
import { START_FEN, material } from './rules.mjs';
import { BoardInsights } from './insights.mjs';
import { BoardReview } from './review.mjs';
import { BoardTraining } from './training.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rootHistoryHash = (game, ply) => hash({ initialFen: game.initialFen, moves: game.moves.slice(0, ply).map(move => move.uci) });
const notes = [
  '分数从本次分析的行棋方视角报告；cp 是引擎单位，不等于实际多了几个兵。',
  '短时搜索是证据线索，未列入候选不代表坏棋；指定走法会单独搜索。',
  '变例说明双方按所示应对时的结果，不代表对手只能如此走。请区分引擎证据与讲解推断。',
];

export class GameService {
  constructor({ rules, engine, store, movetime = 700, scoreEngine = engine, scoreMs = 200, reviewEngine = engine, reviewMs = 800 }) {
    Object.assign(this, { rules, engine, store, movetime });
    this.lessonCache = new Map();
    this.insights = new BoardInsights(this, { scoreEngine, scoreMs });
    this.reviews = new BoardReview(this, { engine: reviewEngine, movetime: reviewMs });
    this.training = new BoardTraining(this);
  }
  async snapshot(game) {
    const position = await this.rules.inspect(game.fen);
    const { receipts, createHash, training: privateTraining, ...publicGame } = game;
    const training = privateTraining ? this.training.view(game) : null;
    return { game: { mode: 'play', ...publicGame, ...(training?.status === 'expired' ? { status: 'finished', result: null } : {}) }, position, teachingNotes: notes,
      scores: training ? [] : this.insights.scores(game), boardLesson: training ? null : this.insights.latestLesson(game), review: training ? null : this.reviews.latest(game), ...(training ? { training } : {}) };
  }
  assertAnalysisAllowed(game) {
    if (game.mode === 'training' && game.training?.status === 'active') throw new Error('请先完成本题，或使用训练提示/答案结束独立作答，再进行引擎分析。');
  }
  async newGame({ requestId, playerSide = 'r', fen = START_FEN, autoReply = true, mode = 'play', trainingOrigin }) {
    if (!['play', 'record'].includes(mode)) throw new Error('请选择人机对弈或自由录谱。');
    if (mode === 'record') autoReply = false;
    const id = hash(['new_game', requestId]).slice(0, 32);
    const signature = hash({ playerSide, fen, autoReply, ...(mode === 'record' ? { mode } : {}), ...(trainingOrigin ? { trainingOrigin } : {}) });
    return this.store.serial(id, async () => {
      if (await this.store.exists(id)) {
        const old = await this.store.load(id);
        if (old.createHash !== signature) throw new Error('此请求编号已用于另一组开局参数，请使用新编号。');
        return { ...await this.snapshot(old), duplicate: true };
      }
      const position = await this.rules.inspect(fen);
      const now = new Date().toISOString();
      const game = { id, version: 0, mode, initialFen: position.fen, fen: position.fen, playerSide, autoReply, status: 'active', moves: [], receipts: {}, createHash: signature, createdAt: now, updatedAt: now, lastLesson: null };
      if (trainingOrigin) game.trainingOrigin = trainingOrigin;
      this.updateStatus(game, position);
      if (game.status === 'active' && autoReply && position.turn !== playerSide) await this.reply(game);
      const snapshot = await this.snapshot(game);
      await this.store.save(game);
      return snapshot;
    });
  }
  async read(id) {
    const game = await this.store.load(id);
    if (!game.training || !this.training.expired(game.training)) return this.snapshot(game);
    return this.store.serial(id, async () => {
      const current = await this.store.load(id);
      if (current.training && this.training.expire(current)) {
        current.version++;
        current.updatedAt = new Date(this.training.now()).toISOString();
        await this.store.save(current);
      }
      return this.snapshot(current);
    });
  }
  updateStatus(game, position) {
    game.status = position.terminal ? 'finished' : 'active';
    game.result = position.terminal ? { winner: position.winner, reason: position.endReason } : null;
    const repetitions = [game.initialFen, ...game.moves.map(move => move.fen)].filter(fen => fen === game.fen).length;
    if (!position.terminal && repetitions >= 3) {
      game.status = 'review_required';
      game.result = { reason: 'repetition_review', message: '同一局面出现三次。长将、长捉等重复局面需要专门裁定，当前暂停对弈，可悔棋继续。' };
    }
  }
  async append(game, uci) {
    const { move, state } = await this.rules.resolveMove(game.fen, uci);
    const next = await this.rules.inspect(game.fen, [move.uci]);
    game.moves.push({ ply: game.moves.length + 1, uci: move.uci, chinese: move.chinese, side: state.turn, piece: state.pieces[move.from], captured: state.pieces[move.to] ?? null, beforeFen: game.fen, fen: next.fen });
    game.fen = next.fen;
    this.updateStatus(game, next);
    return next;
  }
  async translateLine(fen, line, maxPlies = 12) {
    const start = await this.rules.inspect(fen);
    let current = start;
    const steps = [];
    for (const uci of line.pv.slice(0, maxPlies)) {
      if (current.terminal) break;
      const legal = current.legalMoves.find(move => move.uci === uci);
      if (!legal) throw new Error('引擎变例未通过合法性复核，本次结果未用于落子。');
      const captured = current.pieces[legal.to] ?? null;
      const mover = current.turn;
      current = await this.rules.inspect(current.fen, [uci]);
      steps.push({ uci, chinese: legal.chinese, side: mover, captured, givesCheck: current.inCheck, fen: current.fen });
    }
    return { ...line, pv: steps.map(step => step.uci), move: steps[0]?.uci, chinese: steps[0]?.chinese, steps, materialBefore: material(start.pieces), materialAfter: material(current.pieces), finalFen: current.fen, terminal: current.terminal };
  }
  async evidence(game, { ply = game.moves.length, candidate, multiPV = 3, maxPlies = 12, engine = this.engine, movetime = this.movetime } = {}) {
    this.assertAnalysisAllowed(game);
    if (!Number.isInteger(ply) || ply < 0 || ply > game.moves.length) throw new Error('分析步数超出棋谱范围。');
    const fen = ply === 0 ? game.initialFen : game.moves[ply - 1].fen;
    const state = await this.rules.inspect(fen);
    if (state.terminal) return { rootFen: fen, rootTurn: state.turn, ply, terminal: true, position: state, notes };
    const specified = candidate ? (await this.rules.resolveMove(fen, candidate)).move : null;
    const base = { initialFen: game.initialFen, moves: game.moves.slice(0, ply).map(move => move.uci), movetime };
    const evaluation = await engine.analyze({ ...base, multiPV });
    const lines = await Promise.all(evaluation.lines.map(line => this.translateLine(fen, line, maxPlies)));
    const best = lines.find(line => line.move === evaluation.bestmove);
    if (!best) throw new Error('引擎首选着法与变例不一致，请重试分析。');
    let played = specified ? lines.find(line => line.move === specified.uci) : null;
    let candidateSearch = false;
    if (specified && !played) {
      const forced = await engine.analyze({ ...base, multiPV: 1, searchMoves: [specified.uci] });
      if (forced.bestmove !== specified.uci) throw new Error('指定着法搜索返回了其他走法，本次结果未采用。');
      played = await this.translateLine(fen, forced.lines[0], maxPlies);
      if (played.move !== specified.uci) throw new Error('指定着法的变例与搜索结果不一致，本次结果未采用。');
      candidateSearch = true;
    }
    const cpGap = played && best.score.type === 'cp' && played.score.type === 'cp' && best.score.bound === 'exact' && played.score.bound === 'exact'
      ? { value: best.score.value - played.score.value, unit: 'engine_cp', approximate: true } : null;
    return { rootFen: fen, rootTurn: state.turn, ply, engine: evaluation.engine, requestedMs: evaluation.requestedMs, best, candidates: lines, played, candidateSearch, cpGap, notes };
  }
  async reply(game, { fast = false } = {}) {
    if (game.mode === 'training') return this.training.reply(game);
    const evidence = await this.evidence(game, fast ? { multiPV: 1, maxPlies: 4 } : {});
    if (evidence.terminal) return;
    evidence.source = 'reply_search';
    evidence.rootHistoryHash = rootHistoryHash(game, evidence.ply);
    await this.append(game, evidence.best.move);
    game.lastLesson = { ...game.lastLesson, engineMove: evidence };
  }
  async savedReplyEvidence(game, move, maxPlies) {
    const saved = game.lastLesson?.engineMove, best = saved?.best, score = best?.score;
    if (!saved || saved.source !== 'reply_search' || saved.rootFen !== move.beforeFen || saved.rootTurn !== move.side || saved.ply !== move.ply - 1 || saved.requestedMs !== this.movetime || saved.rootHistoryHash !== rootHistoryHash(game, move.ply - 1)) return null;
    if (best?.move !== move.uci || best.chinese !== move.chinese || best.pv?.[0] !== move.uci || best.steps?.[0]?.uci !== move.uci || best.steps[0].fen !== move.fen || !saved.engine || !['cp', 'mate'].includes(score?.type) || !Number.isFinite(score.value) || !['exact', 'lowerbound', 'upperbound'].includes(score.bound) || score.perspective !== 'side_to_move') return null;
    let line;
    try { line = await this.translateLine(saved.rootFen, best, maxPlies); }
    catch { return null; }
    return { rootFen: saved.rootFen, rootTurn: saved.rootTurn, ply: saved.ply, engine: saved.engine, requestedMs: saved.requestedMs, best: line, played: line, candidates: [line], candidateSearch: false, cpGap: score.type === 'cp' && score.bound === 'exact' ? { value: 0, unit: 'engine_cp', approximate: true } : null, source: 'reply_search', sourceNote: '沿用教练落子时的搜索证据；best 是当时的首选，本次没有重新搜索这个局面。' };
  }
  async mutate({ gameId, expectedVersion, requestId }, payload, action) {
    return this.store.serial(gameId, async () => {
      const game = await this.store.load(gameId);
      const signature = hash(payload);
      if (game.receipts[requestId]) {
        if (game.receipts[requestId].hash !== signature) throw new Error('请求编号已用于其他操作，请重新读取棋局。');
        return { ...await this.snapshot(game), duplicate: true };
      }
      if (game.version !== expectedVersion) throw new Error(`棋局已经更新（当前版本 ${game.version}）。本次没有落子，请先刷新棋盘。`);
      await action(game);
      game.version++;
      game.updatedAt = new Date().toISOString();
      game.receipts[requestId] = { hash: signature, version: game.version };
      const entries = Object.entries(game.receipts);
      if (entries.length > 100) game.receipts = Object.fromEntries(entries.slice(-100));
      const snapshot = await this.snapshot(game);
      await this.store.save(game);
      return snapshot;
    });
  }
  async play(args) {
    return this.mutate(args, { action: 'play', move: args.move, expectedVersion: args.expectedVersion, ...(args.deferReply ? { deferReply: true } : {}) }, async game => {
      if (game.mode === 'training' && this.training.expire(game)) return;
      if (game.status !== 'active') throw new Error('这盘棋已结束或正在等待重复局面裁定，可以悔棋或新开一局。');
      const { state, move } = await this.rules.resolveMove(game.fen, args.move);
      const recording = game.mode === 'record';
      if (!recording && state.turn !== game.playerSide) throw new Error('现在轮到教练走棋，请调用教练应手。');
      if (game.mode === 'training') {
        await this.training.play(game, move);
        if (!args.deferReply && game.autoReply && game.status === 'active' && game.fen.split(' ')[1] !== game.playerSide) await this.training.reply(game);
        return;
      }
      const deferred = args.deferReply || recording;
      const evidence = deferred ? null : await this.evidence(game, { candidate: move.uci });
      game.lastLesson = evidence ? { userMove: evidence } : null;
      const next = await this.append(game, move.uci);
      if (deferred) {
        const played = game.moves.at(-1);
        // Facts from the committed move, not an evaluation. Detailed analysis is
        // requested separately so an unavailable engine cannot delay this save.
        game.lastLesson = { [recording ? 'recordedMove' : 'userMove']: {
          rootFen: played.beforeFen, rootTurn: played.side, ply: played.ply - 1, analysisPending: true,
          played: { move: played.uci, chinese: played.chinese, pv: [played.uci], steps: [{ uci: played.uci, chinese: played.chinese, side: played.side, captured: played.captured, givesCheck: next.inCheck, fen: next.fen }], materialBefore: material(state.pieces), materialAfter: material(next.pieces), finalFen: next.fen, terminal: next.terminal },
        } };
      }
      if (!deferred && game.autoReply && game.status === 'active') await this.reply(game);
    });
  }
  async engineReply(args) {
    return this.mutate(args, { action: 'reply', expectedVersion: args.expectedVersion, ...(args.fast ? { fast: true } : {}) }, async game => {
      if (game.mode === 'training' && this.training.expire(game)) return;
      if (game.mode === 'record') throw new Error('自由录谱由你走红黑双方，教练不会代走。摆完后可以复盘讲解。');
      const position = await this.rules.inspect(game.fen);
      if (game.status !== 'active') throw new Error('当前棋局不能继续落子。');
      if (position.turn === game.playerSide) throw new Error('现在轮到你走棋。');
      const lastMove = game.moves.at(-1), userMove = game.lastLesson?.userMove;
      const related = lastMove?.side === game.playerSide && userMove?.ply === lastMove.ply - 1 && userMove.rootFen === lastMove.beforeFen && userMove.played?.move === lastMove.uci;
      game.lastLesson = related ? { userMove } : null;
      await this.reply(game, { fast: args.fast });
    });
  }
  async undo(args) {
    return this.mutate(args, { action: 'undo', plies: args.plies ?? 2, expectedVersion: args.expectedVersion }, async game => {
      if (game.mode === 'training') throw new Error('训练题请使用“重试”，作答记录会保留。');
      if (!game.moves.length) throw new Error('已经是开局，没有可撤回的着法。');
      game.moves.splice(Math.max(0, game.moves.length - (args.plies ?? 2)));
      game.fen = game.moves.at(-1)?.fen ?? game.initialFen;
      game.lastLesson = null;
      this.updateStatus(game, await this.rules.inspect(game.fen));
    });
  }
  async analyze({ gameId, ply, candidate }) {
    const game = await this.store.load(gameId);
    return { gameId, version: game.version, analysis: await this.evidence(game, { ply, candidate }) };
  }
  async explainTurn({ gameId, expectedVersion, ply }) {
    const game = await this.store.load(gameId);
    if (expectedVersion !== undefined && game.version !== expectedVersion) throw new Error(`棋局已经更新（当前版本 ${game.version}）。请刷新棋盘后重新选择要讲解的回合。`);
    let toPly = ply ?? game.moves.length;
    if (!Number.isInteger(toPly) || toPly < 1 || toPly > game.moves.length) throw new Error('还没有这个已完成的回合可供讲解。');
    const recording = game.mode === 'record';
    if (!recording && game.moves[toPly - 1].side === game.playerSide) {
      if (toPly < game.moves.length) toPly++;
      else if (game.status === 'active') throw new Error('教练尚未应手，请等这一回合完成后再讲解。');
    }
    const last = game.moves[toPly - 1];
    const engineMove = !recording && last.side !== game.playerSide ? last : null;
    const userMove = recording ? null : last.side === game.playerSide ? last : game.moves[toPly - 2]?.side === game.playerSide ? game.moves[toPly - 2] : null;
    const fromPly = (recording ? last : userMove ?? engineMove).ply - 1;
    const search = { multiPV: 2, maxPlies: 4 };
    // Include version AND the history: an undo/replay, another process, or a
    // different search budget must never reuse evidence for a different turn.
    const key = hash({ gameId, version: game.version, initialFen: game.initialFen, playerSide: game.playerSide, moves: game.moves.map(({ uci, beforeFen, fen }) => ({ uci, beforeFen, fen })), toPly, movetime: this.movetime, replyEvidence: game.lastLesson?.engineMove, ...search });
    let pending = this.lessonCache.get(key);
    if (!pending) {
      pending = (async () => {
        const lesson = {};
        for (const [role, move] of [['userMove', userMove], ['engineMove', engineMove], ['recordedMove', recording ? last : null]]) {
          if (!move) continue;
          const saved = role === 'engineMove' ? await this.savedReplyEvidence(game, move, search.maxPlies) : null;
          const evidence = saved ?? { ...await this.evidence(game, { ply: move.ply - 1, candidate: move.uci, ...search }), source: 'on_demand_search', sourceNote: '本次讲解请求按需搜索的证据。' };
          // Explicitly select fields so this response never includes the full
          // board/history or a terminal-position object in the chat context.
          const { rootFen, rootTurn, ply, engine, requestedMs, best, candidates, played, candidateSearch, cpGap, source, sourceNote } = evidence;
          const alternatives = candidates.filter(line => line.move !== best.move && line.move !== played.move);
          lesson[role] = { rootFen, rootTurn, ply, engine, requestedMs, best, candidates: alternatives, played, candidateSearch, cpGap, source, sourceNote };
        }
        return { gameId, version: game.version, ...(recording ? { mode: 'record' } : {}), fromPly, toPly, lesson, notes };
      })();
      this.lessonCache.set(key, pending);
      while (this.lessonCache.size > 32) this.lessonCache.delete(this.lessonCache.keys().next().value);
      pending.catch(() => { if (this.lessonCache.get(key) === pending) this.lessonCache.delete(key); });
    } else {
      this.lessonCache.delete(key);
      this.lessonCache.set(key, pending);
    }
    return structuredClone(await pending);
  }
  async preview({ gameId, ply, moves }) {
    const game = await this.store.load(gameId);
    ply ??= game.moves.length;
    if (!Number.isInteger(ply) || ply < 0 || ply > game.moves.length) throw new Error('分析步数超出棋谱范围。');
    const fen = ply === 0 ? game.initialFen : game.moves[ply - 1].fen;
    let position = await this.rules.inspect(fen);
    const steps = [];
    for (const text of moves) {
      const { move } = await this.rules.resolveMove(position.fen, text);
      const captured = position.pieces[move.to] ?? null;
      position = await this.rules.inspect(position.fen, [move.uci]);
      steps.push({ ...move, captured, givesCheck: position.inCheck, fen: position.fen });
    }
    return { gameId, version: game.version, hypothetical: true, fromPly: ply, rootFen: fen, position, steps };
  }
  async export({ gameId, format = 'notebook' }) {
    const game = await this.store.load(gameId);
    const result = game.status === 'finished' && game.result?.winner ? (game.result.winner === 'r' ? '1-0' : '0-1') : '*';
    const source = game.mode === 'training' ? this.training.puzzle(game.training.puzzleId).source : null;
    const trainingTitle = source?.kind === 'ccpd' ? 'CCPD实战残局训练' : '原创残局训练';
    const headers = ['[Game "Chinese Chess"]', `[Event "${game.mode === 'training' ? trainingTitle : game.mode === 'record' ? '自由录谱' : '象棋教练'}"]`, `[Date "${game.createdAt.slice(0, 10).replaceAll('-', '.')}"]`, `[Red "${game.mode === 'record' ? '红方' : game.playerSide === 'r' ? '我' : game.mode === 'training' ? '训练防守' : 'Pikafish'}"]`, `[Black "${game.mode === 'record' ? '黑方' : game.playerSide === 'b' ? '我' : game.mode === 'training' ? '训练防守' : 'Pikafish'}"]`, `[Result "${result}"]`, `[Format "${format === 'notebook' ? 'XiangqiNotebook' : 'ICCS'}"]`, `[FEN "${game.initialFen.replace(/ r$/, ' w')}"]`];
    if (source?.kind === 'ccpd') headers.push(`[Source "${source.url}"]`, `[Copyright "${source.authors}; CC BY 4.0; adapted training position"]`, `[License "${source.licenseUrl}"]`);
    const sequence = [];
    let round = 1;
    for (const move of game.moves) {
      if (move.side === 'r') sequence.push(`${round}.`);
      else if (sequence.length === 0) sequence.push(`${round}...`);
      sequence.push(format === 'notebook' ? `${move.uci[0]}${9 - Number(move.uci[1])}${move.uci[2]}${9 - Number(move.uci[3])}` : `${move.uci.slice(0, 2).toUpperCase()}-${move.uci.slice(2).toUpperCase()}`);
      if (move.side === 'b') round++;
    }
    return { gameId, format, filename: `xiangqi-${game.id.slice(0, 8)}.pgn`, pgn: headers.join('\n') + '\n\n' + sequence.join(' ') + ' ' + result + '\n', chineseMoves: game.moves.map(move => move.chinese), saved: true };
  }
}
