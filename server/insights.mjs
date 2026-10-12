import { createHash } from 'node:crypto';
import { SCORE_SCALE, toReferenceScore } from './score-scale.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const positionKey = (game, ply) => hash({ initialFen: game.initialFen, moves: game.moves.slice(0, ply).map(move => move.uci) });
const atFen = (game, ply) => ply === 0 ? game.initialFen : game.moves[ply - 1].fen;
const invertBound = bound => bound === 'lowerbound' ? 'upperbound' : bound === 'upperbound' ? 'lowerbound' : bound;

export function normalizeScore(score, rootTurn) {
  if (!score || !['cp', 'mate'].includes(score.type) || !Number.isFinite(score.value) || !['exact', 'lowerbound', 'upperbound'].includes(score.bound) || score.perspective !== 'side_to_move') throw new Error('未取得可靠的局势分。');
  const redValue = (rootTurn === 'r' ? 1 : -1) * score.value;
  const redBound = rootTurn === 'r' ? score.bound : invertBound(score.bound);
  return {
    red: { type: score.type, value: redValue || 0, bound: redBound },
    black: { type: score.type, value: -redValue || 0, bound: invertBound(redBound) },
  };
}

const publicLesson = (lesson, includeEvidence = false) => {
  if (!lesson) return null;
  const { historyKey, evidence, ...visible } = lesson;
  return { ...visible, ...(includeEvidence ? { evidence } : {}) };
};

export class BoardInsights {
  constructor(service, { scoreEngine, scoreMs = 200 }) {
    this.service = service;
    this.store = service.store;
    this.scoreEngine = scoreEngine;
    this.scoreMs = scoreMs;
    this.scoreRequests = new Map();
    this.scoreMemory = new Map();
    this.lessonRequests = new Map();
  }
  scoreKey(game, ply) { return `${positionKey(game, ply)}:${SCORE_SCALE}:${this.scoreMs}`; }
  scores(game) {
    return Array.from({ length: game.moves.length + 1 }, (_, ply) => ({
      ply, fen: atFen(game, ply), label: ply ? game.moves[ply - 1].chinese : '开局',
      ...(this.scoreMemory.get(`${game.id}:${this.scoreKey(game, ply)}`) ?? this.store.score(game.id, this.scoreKey(game, ply))),
    }));
  }
  belongs(lesson, game) { return lesson.toPly <= game.moves.length && lesson.historyKey === positionKey(game, lesson.toPly); }
  latestLesson(game) { return publicLesson(this.store.lessons(game.id).find(lesson => this.belongs(lesson, game))); }
  async evaluate({ gameId, expectedVersion, ply }) {
    const game = await this.service.store.load(gameId);
    this.service.assertAnalysisAllowed(game);
    if (expectedVersion !== undefined && expectedVersion !== game.version) throw new Error('棋局已更新，请重新读取局势分。');
    ply ??= game.moves.length;
    if (!Number.isInteger(ply) || ply < 0 || ply > game.moves.length) throw new Error('评分步数超出棋谱范围。');
    const key = this.scoreKey(game, ply), requestKey = `${gameId}:${key}`;
    let point = this.scoreMemory.get(requestKey) ?? this.store.score(gameId, key);
    if (!point) {
      let request = this.scoreRequests.get(requestKey);
      if (!request) {
        request = (async () => {
          const fen = atFen(game, ply), state = await this.service.rules.inspect(fen);
          let result;
          if (state.terminal) {
            result = { red: { type: 'result', value: state.winner === 'r' ? 1 : -1 }, black: { type: 'result', value: state.winner === 'b' ? 1 : -1 }, reason: state.endReason, depth: null, source: 'rules' };
          } else {
            const analysis = await this.scoreEngine.analyze({ initialFen: game.initialFen, moves: game.moves.slice(0, ply).map(move => move.uci), movetime: this.scoreMs, multiPV: 1 });
            const best = analysis.lines.find(line => line.pv?.[0] === analysis.bestmove);
            if (!best || !state.legalMoves.some(move => move.uci === analysis.bestmove)) throw new Error('引擎评分未通过局面校验。');
            const normalized = normalizeScore(best.score, state.turn);
            result = { red: toReferenceScore(normalized.red, fen), black: toReferenceScore(normalized.black, fen), depth: best.depth, source: 'engine', engine: analysis.engine, requestedMs: analysis.requestedMs };
          }
          const evaluated = { ply, fen, ...result, evaluatedAt: new Date().toISOString() };
          // A derived cache has its own row. It never rewrites an older game
          // snapshot over a move, undo, or another process's pending response.
          this.scoreMemory.set(requestKey, evaluated);
          while (this.scoreMemory.size > 512) this.scoreMemory.delete(this.scoreMemory.keys().next().value);
          // The engine may still be committing its reply. Show the evaluation
          // now; persist this rebuildable cache once that write lock is free.
          this.store.serial(gameId, async () => this.store.saveScore(gameId, key, evaluated)).catch(() => {});
          return evaluated;
        })();
        this.scoreRequests.set(requestKey, request);
        request.finally(() => this.scoreRequests.delete(requestKey)).catch(() => {});
      }
      point = await request;
    }
    return { gameId, version: game.version, point: structuredClone(point) };
  }
  async prepare({ gameId, expectedVersion, requestId, kind = 'explain', reviewId, ply }) {
    const game = await this.store.load(gameId);
    this.service.assertAnalysisAllowed(game);
    if (game.version !== expectedVersion) throw new Error('棋局已更新，请重新选择要讲解的回合。');
    const old = this.store.lesson(gameId, requestId);
    if (old) {
      if (old.version !== expectedVersion || old.kind !== kind || old.reviewId !== reviewId || old.reviewPly !== ply || !this.belongs(old, game)) throw new Error('讲解请求编号已用于另一局面。');
      return publicLesson(old, true);
    }
    const key = `${gameId}:${requestId}`, signature = `${expectedVersion}:${kind}:${reviewId ?? ''}:${ply ?? ''}`;
    const existing = this.lessonRequests.get(key);
    if (existing && existing.signature !== signature) throw new Error('讲解请求编号已用于另一局面。');
    if (existing) return structuredClone(await existing.promise);
    const promise = (async () => {
      let evidence;
      if (kind === 'review') {
        if (!reviewId) throw new Error('请选择要讲解的复盘报告。');
        evidence = await this.service.reviews.lessonEvidence({ gameId, reviewId, ply });
      } else if (kind === 'position') {
        const analysis = await this.service.evidence(game, { multiPV: 3, maxPlies: 6 });
        evidence = { gameId, version: game.version, mode: game.mode ?? 'play', fromPly: game.moves.length, toPly: game.moves.length, analysis,
          notes: ['只分析给定局面的优劣、威胁、计划和已验证变化。没有此前棋谱，不能编造之前的失误或整局表现。'] };
      } else if (kind === 'explain') evidence = await this.service.explainTurn({ gameId, expectedVersion, ply: game.moves.length });
      else {
        if (game.status !== 'active' || game.mode !== 'record' && game.fen.split(' ')[1] !== game.playerSide) throw new Error('请在轮到你走棋时请求提示。');
        const analysis = await this.service.evidence(game, { ply: game.moves.length, multiPV: 1, maxPlies: 4 });
        const { rootFen, rootTurn, ply, engine, requestedMs, best } = analysis;
        evidence = { gameId, version: game.version, fromPly: game.moves.length, toPly: game.moves.length, analysis: { rootFen, rootTurn, ply, engine, requestedMs, best }, notes: ['只给观察方向，不公布最佳着法或完整变例。'] };
      }
      const toPly = evidence.toPly, lesson = {
        gameId, requestId, kind, version: game.version, fromPly: evidence.fromPly, toPly,
        rootFen: atFen(game, toPly), historyKey: positionKey(game, toPly),
        status: 'pending', text: '', createdAt: new Date().toISOString(), evidence,
        ...(kind === 'review' ? { reviewId, ...(ply !== undefined ? { reviewPly: ply } : {}), scope: evidence.scope } : {}),
      };
      const stored = await this.store.serial(gameId, async () => {
        if (!this.belongs(lesson, await this.store.load(gameId))) throw new Error('这段棋谱已撤回，请重新选择讲解。');
        const duplicate = this.store.lesson(gameId, requestId);
        if (duplicate) {
          if (duplicate.version !== expectedVersion || duplicate.kind !== kind || duplicate.reviewId !== reviewId || duplicate.reviewPly !== ply) throw new Error('讲解请求编号已用于另一局面。');
          return duplicate;
        }
        this.store.saveLesson(lesson);
        return lesson;
      });
      return publicLesson(stored, true);
    })();
    this.lessonRequests.set(key, { signature, promise });
    promise.finally(() => this.lessonRequests.delete(key)).catch(() => {});
    return structuredClone(await promise);
  }
  async readLesson({ gameId, requestId, includeEvidence = false }) {
    const game = await this.store.load(gameId), lesson = this.store.lesson(gameId, requestId);
    if (!lesson) throw new Error('没有找到这个棋盘讲解请求。');
    return { ...publicLesson(lesson, includeEvidence), obsolete: !this.belongs(lesson, game) };
  }
  async publish({ gameId, requestId, text }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new Error('讲解正文须为 1–6000 个字符。');
    return this.store.serial(gameId, async () => {
      const game = await this.store.load(gameId), lesson = this.store.lesson(gameId, requestId);
      if (!lesson) throw new Error('请先准备对应的棋盘讲解请求。');
      if (!this.belongs(lesson, game)) throw new Error('讲解对应的棋谱已撤回，本次未写入。');
      if (lesson.status === 'complete' && lesson.text !== text.trim()) throw new Error('这条讲解已经完成，不能被重复请求覆盖。');
      lesson.status = 'complete'; lesson.text = text.trim(); lesson.completedAt ??= new Date().toISOString();
      this.store.saveLesson(lesson);
      return { gameId, requestId, saved: true, lesson: publicLesson(lesson) };
    });
  }
}
