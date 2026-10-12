import { createHash, randomUUID } from 'node:crypto';
import { positionKey, normalizeScore } from './insights.mjs';
import { SCORE_SCALE, toReferenceScore, referencePoints, gameStage } from './score-scale.mjs';
import { TIANTIAN_ANALYSIS_VERSION, engineScoreToClient, compressedEvaluation, clientMoveScore } from './tiantian-analysis.mjs';

const MODEL = TIANTIAN_ANALYSIS_VERSION;
export const REVIEW_METHOD = {
  version: MODEL, scale: SCORE_SCALE, scoringScale: 'tiantian-pikafish-client-compressed',
  source: '已还原天天象棋4.4.6.2客户端的分数转换、逐手公式、等级阈值与阶段规则，并由公开H5代码交叉核对。插件使用本地皮卡鱼与相同预算的候选着比较；引擎版本、开局库及搜索路径不同，同一棋谱不保证与官方同分。',
  formula: '先按客户端规则转换并压缩局势分，再将压缩损失0/30/60/120/180/240映射为100/80/60/40/20/0，区间内线性计算，超过240继续扣分，最低−300。红黑分别对有效着法取平均并四舍五入；总分和阶段分显示最低−100。上下界或明显搜索分歧仍不打分。',
  grades: '优≥80，良≥60，中≥40，差≥20，错<20。100表示本次搜索未发现明显损失，不是棋力等级。',
  stages: '前20手（10回合）优先归开局，包括自定义残局起点；之后，走子前双方各自剩余的车、马、炮合计不超过2枚为残局，其余为中局。双方无车不单独构成残局条件。未进入的阶段不评分。',
  mistakes: '失误统计“错”的数量。漏杀只统计引擎检出的明确杀棋机会丢失；未验证到杀棋终点的另列为疑似。',
  openingBook: '当前未接入经典开局库，不标记官着。',
};
export const gradeFor = value => value === null ? '未定' : value >= 80 ? '优' : value >= 60 ? '良' : value >= 40 ? '中' : value >= 20 ? '差' : '错';
export function moveQuality(best, played, fen) {
  const uncertain = note => ({ accuracy: null, grade: '未定', loss: null, missedMate: false, possibleMissedMate: false, note });
  const result = (accuracy, loss, note, extra = {}) => ({ accuracy, grade: gradeFor(accuracy), loss, missedMate: false, possibleMissedMate: false, note, ...extra });
  const b = best?.score, p = played?.score;
  if (!b || !p || !Number.isFinite(b.value) || !Number.isFinite(p.value) || b.perspective !== 'side_to_move' || p.perspective !== 'side_to_move') return uncertain('未取得可比的评分。');
  if (best.move === played.move) return result(100, 0, '与本次引擎推荐一致。');
  if (b.bound !== 'exact' || p.bound !== 'exact') return uncertain('当前评分只有上下界，暂不按分差打分。');
  const before = engineScoreToClient(b), after = engineScoreToClient(p);
  const scoringLoss = Math.max(0, compressedEvaluation(before) - compressedEvaluation(after));
  const accuracy = clientMoveScore(before, after);
  const numeric = (loss, note, extra = {}) => result(accuracy, loss, note, { scoringLoss, ...extra });
  if (b.type === 'cp' && p.type === 'cp') {
    const difference = referencePoints(b.value - p.value, fen);
    if (difference < -50) return uncertain('两次搜索结果有分歧，需要更深入分析。');
    const loss = Math.max(0, difference);
    return numeric(loss, `相对推荐着法损失约${loss}局势分；评分按客户端压缩差值${scoringLoss}计算。`);
  }
  if (b.type === 'mate' && b.value > 0) {
    if (p.type === 'mate' && p.value > 0) return numeric(0, '实走仍保留引擎检出的杀棋。');
    if (best.terminal) return numeric(null, '引擎检出漏杀，推荐变例已核验到终局。', { missedMate: true });
    return { ...uncertain('疑似错过杀棋；当前短变例未核验到终局，未计入漏杀次数。'), possibleMissedMate: true };
  }
  if (b.type === 'cp' && p.type === 'mate' && p.value < 0 && played.terminal) return numeric(null, '实走进入引擎检出的被将杀变化。');
  return uncertain('将杀分与普通局面分不能直接相减。');
}
export function summarizeRows(rows) {
  const summarize = selected => {
    const scored = selected.filter(row => row.quality.accuracy !== null);
    const counts = Object.fromEntries(['优', '良', '中', '差', '错', '未定'].map(grade => [grade, selected.filter(row => row.quality.grade === grade).length]));
    const accuracy = scored.length ? Math.round(scored.reduce((sum, row) => sum + row.quality.accuracy, 0) / scored.length) : null;
    return { moves: selected.length, scored: scored.length, accuracy, displayAccuracy: accuracy === null ? null : Math.max(-100, accuracy), counts, mistakes: counts['错'], missedMates: selected.filter(row => row.quality.missedMate).length, possibleMissedMates: selected.filter(row => row.quality.possibleMissedMate).length };
  };
  return Object.fromEntries(['r', 'b'].map(side => {
    const selected = rows.filter(row => row.side === side);
    return [side, { ...summarize(selected), phases: Object.fromEntries(['opening', 'middlegame', 'endgame'].map(stage => [stage, summarize(selected.filter(row => row.stage === stage))])) }];
  }));
}
const rowSummary = row => ({ ply: row.ply, side: row.side, chinese: row.chinese, beforeFen: row.beforeFen, fen: row.fen, stage: row.stage, quality: row.quality, recommended: row.best.chinese, depth: row.depth });
export const keyTurnsFor = rows => [...rows]
  .filter(row => row.quality.missedMate || row.quality.possibleMissedMate || row.quality.grade === '错' || (row.quality.loss ?? 0) > 50)
  .sort((a, b) => Number(b.quality.missedMate) - Number(a.quality.missedMate) || (a.quality.accuracy ?? 101) - (b.quality.accuracy ?? 101) || (b.quality.loss ?? 0) - (a.quality.loss ?? 0))
  .slice(0, 5).map(rowSummary);
const publicReview = (review, { rows = true } = {}) => {
  if (!review) return null;
  const { owner, leaseUntil, historyKey, frozenGame, ...visible } = review;
  return { ...visible, outdatedMethod: review.method?.version !== MODEL, rows: rows ? review.rows.map(rowSummary) : undefined, points: rows ? review.points : undefined };
};

export class BoardReview {
  constructor(service, { engine, movetime = 800 }) { Object.assign(this, { service, store: service.store, engine, movetime }); this.jobs = new Map(); }
  belongs(review, game) { return review.total <= game.moves.length && review.historyKey === positionKey(game, review.total); }
  latest(game) {
    const matching = this.store.reviews(game.id).filter(review => this.belongs(review, game));
    return publicReview(matching.find(review => review.method?.version === MODEL) ?? matching[0], { rows: false });
  }
  async start({ gameId, expectedVersion }) {
    const game = await this.store.load(gameId);
    this.service.assertAnalysisAllowed(game);
    if (expectedVersion !== game.version) throw new Error('棋局已更新，请刷新后开始复盘。');
    if (!game.moves.length) throw new Error('走过至少一手棋后才能复盘。');
    const historyKey = positionKey(game, game.moves.length);
    const id = createHash('sha256').update(`${gameId}:${historyKey}:${this.movetime}:${MODEL}:${SCORE_SCALE}`).digest('hex').slice(0, 32);
    const owner = randomUUID();
    const review = await this.store.serial(gameId, async () => {
      const old = this.store.review(gameId, id);
      if (old && (old.status === 'complete' || old.status === 'running' && old.leaseUntil > Date.now())) return old;
      const next = old ?? { id, gameId, version: game.version, historyKey, frozenGame: game, total: game.moves.length, rootFen: game.fen, result: game.result, gameFinished: game.status === 'finished', rows: [], points: [], createdAt: new Date().toISOString(), requestedMs: this.movetime, method: REVIEW_METHOD };
      Object.assign(next, { owner, leaseUntil: Date.now() + 90000, status: 'running', error: null });
      this.store.saveReview(next); return next;
    });
    if (review.owner === owner) {
      const running = this.run(review);
      this.jobs.set(id, running);
      running.finally(() => this.jobs.delete(id)).catch(() => {});
    }
    return publicReview(review);
  }
  async persist(review) {
    return this.store.serial(review.gameId, async () => {
      if (this.store.review(review.gameId, review.id)?.owner !== review.owner) throw new Error('复盘已由另一个进程接续。');
      review.leaseUntil = Date.now() + 90000;
      this.store.saveReview(review);
    });
  }
  point(score, fen, turn, ply, label, rootFen = fen) {
    const normalized = normalizeScore(score, turn);
    return { ply, fen, label, red: toReferenceScore(normalized.red, rootFen), black: toReferenceScore(normalized.black, rootFen), source: 'review' };
  }
  async run(review) {
    try {
      const game = review.frozenGame;
      for (let index = review.rows.length; index < game.moves.length; index++) {
        if (this.closing) throw new Error('复盘已中断，可以继续分析。');
        if (!this.belongs(review, await this.store.load(game.id))) throw new Error('原棋谱已撤回，本次复盘已停止。');
        const move = game.moves[index];
        const analysis = await this.service.evidence(game, { ply: index, candidate: move.uci, multiPV: 1, maxPlies: 12, engine: this.engine, movetime: this.movetime });
        if (!analysis.played || analysis.played.steps[0]?.fen !== move.fen) throw new Error('复盘实走与保存棋谱不一致。');
        const state = await this.service.rules.inspect(move.beforeFen);
        const quality = moveQuality(analysis.best, analysis.played, analysis.rootFen);
        const row = { ...move, stage: gameStage(state.pieces, index), quality, best: analysis.best, played: analysis.played, rootTurn: analysis.rootTurn, engine: analysis.engine, requestedMs: analysis.requestedMs, depth: Math.min(analysis.best.depth, analysis.played.depth) };
        review.rows.push(row);
        if (!index) review.points.push(this.point(analysis.best.score, game.initialFen, analysis.rootTurn, 0, '开局'));
        const after = await this.service.rules.inspect(move.fen);
        review.points.push(after.terminal ? { ply: move.ply, fen: move.fen, label: move.chinese, red: { type: 'result', value: after.winner === 'r' ? 1 : -1 }, black: { type: 'result', value: after.winner === 'b' ? 1 : -1 }, source: 'rules' } : this.point(analysis.played.score, move.fen, analysis.rootTurn, move.ply, move.chinese, move.beforeFen));
        review.summary = summarizeRows(review.rows);
        review.keyTurns = keyTurnsFor(review.rows);
        await this.persist(review);
      }
      review.status = 'complete'; review.completedAt = new Date().toISOString();
      await this.persist(review);
    } catch (error) {
      review.status = 'failed'; review.error = error.message;
      try { await this.persist(review); } catch { /* Another worker owns the derived report now. */ }
    }
  }
  close() { this.closing = true; this.engine.close?.(); }
  async read({ gameId, reviewId, ply }) {
    const game = await this.store.load(gameId), review = this.store.review(gameId, reviewId);
    if (!review) throw new Error('没有找到这份复盘。');
    const obsolete = !this.belongs(review, game);
    const result = publicReview(review);
    if (review.status === 'running' && review.leaseUntil < Date.now()) { result.status = 'paused'; result.error = '上次复盘已中断，可以继续分析。'; }
    if (ply !== undefined) {
      const row = review.rows.find(row => row.ply === ply);
      if (!row) throw new Error('这一手尚未完成复盘。');
      result.selected = structuredClone(row);
    }
    return { ...result, obsolete };
  }
  async practice({ gameId, reviewId, ply, requestId }) {
    const review = await this.read({ gameId, reviewId, ply });
    if (review.obsolete) throw new Error('原棋谱已撤回，请重新选择练习局面。');
    return this.service.newGame({ requestId, fen: review.selected.beforeFen, playerSide: review.selected.side, autoReply: true, trainingOrigin: { gameId, reviewId, ply } });
  }
  async lessonEvidence({ gameId, reviewId, ply }) {
    const report = await this.read({ gameId, reviewId, ply });
    if (report.obsolete) throw new Error('原棋谱已撤回，请重新选择讲解。');
    if (ply === undefined && report.status !== 'complete') throw new Error('整局复盘尚未完成。');
    const stored = this.store.review(gameId, reviewId);
    const keyRows = stored.rows.filter(row => report.keyTurns.some(turn => turn.ply === row.ply));
    const rows = ply === undefined ? (keyRows.length ? keyRows : stored.rows).slice(0, 3) : [report.selected];
    return { gameId, reviewId, scope: ply === undefined ? 'game' : 'move', fromPly: ply === undefined ? 0 : ply - 1, toPly: ply ?? report.total, summary: report.summary, gameFinished: report.gameFinished, method: report.method, moves: rows.map(row => ({ ply: row.ply, side: row.side, chinese: row.chinese, rootFen: row.beforeFen, rootTurn: row.rootTurn, quality: row.quality, best: row.best, played: row.played })), notes: ['用本局表现评分，不等同于真实棋力。失误与漏杀以字段中的已验证结论为准。没有官着库，不编造官着标签。'] };
  }
}
