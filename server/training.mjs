import { createHash } from 'node:crypto';
import { PUZZLES, PUZZLE_CATALOG_VERSION } from './puzzles.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modes = ['learn', 'rated', 'challenge'];
const blankProgress = () => ({ attempts: 0, solved: false, bestStars: 0, mistakes: 0, needsReview: false, lastOutcome: null });
const publicPuzzle = puzzle => {
  const { id, title, theme, difficulty, rating, fen, goal, maxPlayerMoves, source } = puzzle;
  return { id, title, theme, difficulty, rating, fen, goal, maxPlayerMoves, source };
};
export const TRAINING_METHOD = {
  version: 'local-training-v1',
  source: '题库包含本地原创题与CCPD实战棋谱改编题（CC BY 4.0），每题标注来源。训练流程参考天天象棋可核实的功能；题分、星级和等级分为本地规则。',
  judging: '在目标手数内取胜（将死或困毙，每手指自己的一次落子）；正确着法及防守分支由象棋规则穷举核验。合法但不能在目标手数内完成的着法判为未达目标，棋盘保留在落子前。',
  stars: '独立无错完成3星；有错但未用提示完成2星；使用提示后完成1星；查看答案不算独立完成。',
  rating: '本地训练分初始1200，采用 Elo 更新：round(32 × (结果 − 1/(1+10^((题分−训练分)/400))))。同一版本同一题仅首次评分作答计分。题分为编者标注，不能换算为天天象棋段位。',
  challenge: '挑战支持3分钟、5分钟和不限时；本场每题只出现一次，累计3题失败、时间到或题库用尽后结束。提示或答案计本题失败；挑战不改变训练等级分。',
};

export class BoardTraining {
  constructor(service, { puzzles = PUZZLES, now = () => Date.now() } = {}) {
    Object.assign(this, { service, store: service.store, puzzles, now });
    this.byId = new Map(puzzles.map(puzzle => [puzzle.id, puzzle]));
  }
  puzzle(id) {
    const puzzle = this.byId.get(id);
    if (!puzzle) throw new Error('没有找到这道训练题，请重新打开题库。');
    return puzzle;
  }
  // Catalog additions must not reset existing stars, mistakes, or first-rating
  // eligibility. The original release used this date as its progress namespace.
  progressKey(puzzle) { return `${puzzle.revision ?? '2026-10-12.1'}:${puzzle.id}`; }
  summary(profile = this.store.trainingProfile()) {
    return { total: this.puzzles.length, solved: this.puzzles.filter(p => profile.progress[this.progressKey(p)]?.solved).length,
      attempts: profile.attempts, correct: profile.correct, rating: profile.rating, streak: profile.streak, bestStreak: profile.bestStreak };
  }
  async list({ theme, difficulty, source, mistakesOnly = false } = {}) {
    // Opening the catalog also settles challenges abandoned while the app was
    // closed. Each game is rechecked inside the shared SQLite transaction.
    for (const id of this.store.pendingChallenges(this.now())) await this.service.read(id);
    const profile = this.store.trainingProfile();
    const puzzles = this.puzzles.map(p => ({ ...publicPuzzle(p), progress: { ...blankProgress(), ...profile.progress[this.progressKey(p)] } }))
      .filter(p => (!theme || p.theme === theme) && (!difficulty || p.difficulty === difficulty) && (!source || p.source.kind === source) && (!mistakesOnly || p.progress.needsReview));
    return { catalogVersion: PUZZLE_CATALOG_VERSION, puzzles, themes: [...new Set(this.puzzles.map(p => p.theme))],
      summary: this.summary(profile), recent: profile.recent.slice(0, 30), challenges: profile.challenges.slice(0, 10), method: TRAINING_METHOD };
  }
  expired(training) {
    return !!(!training.session?.finished && training.session?.durationSeconds && this.now() >= training.session.startedAt + training.session.durationSeconds * 1000);
  }
  view(game) {
    const t = game.training;
    if (!t) return null;
    const session = t.session, expired = this.expired(t);
    return { puzzle: publicPuzzle(this.puzzle(t.puzzleId)), mode: t.mode, status: expired && t.status === 'active' ? 'expired' : t.status,
      feedback: expired && t.status === 'active' ? '挑战时间已到，本场结束。' : t.feedback, hints: t.hints, mistakes: t.mistakes,
      playerMoves: game.moves.filter(m => m.side === game.playerSide).length,
      elapsedSeconds: Math.max(0, Math.floor(((t.completedAt ?? this.now()) - t.startedAt) / 1000)), stars: t.stars ?? 0,
      ...(t.solution ? { solution: t.solution } : {}), ...(t.ratingChange !== undefined ? { ratingChange: t.ratingChange } : {}),
      ...(session ? { challenge: { durationSeconds: session.durationSeconds,
        remainingSeconds: session.durationSeconds ? Math.max(0, Math.ceil((session.startedAt + session.durationSeconds * 1000 - this.now()) / 1000)) : null,
        correct: session.correct, mistakes: session.mistakes, streak: session.streak, bestStreak: session.bestStreak,
        finished: session.finished || expired, reason: session.reason ?? (expired ? '时间到' : undefined), seen: session.seen.length } } : {}),
      summary: this.summary(), method: TRAINING_METHOD };
  }
  async start({ requestId, puzzleId, mode = 'learn', durationSeconds = 180 }) {
    if (!modes.includes(mode) || ![0, 180, 300].includes(durationSeconds)) throw new Error('请选择学习、评分或挑战，以及有效的挑战时长。');
    const id = digest(['start_training', requestId]).slice(0, 32);
    const signature = digest({ puzzleId, mode, durationSeconds });
    return this.store.serial(id, async () => {
      if (await this.store.exists(id)) {
        const game = await this.store.load(id);
        if (game.createHash !== signature) throw new Error('此请求编号已用于其他训练参数。');
        return { ...await this.service.snapshot(game), duplicate: true };
      }
      const profile = this.store.trainingProfile();
      const selected = puzzleId ? this.puzzle(puzzleId) : this.select(profile, mode);
      const now = this.now(), timestamp = new Date(now).toISOString();
      const game = { id, version: 0, mode: 'training', autoReply: true, receipts: {}, createHash: signature,
        createdAt: timestamp, updatedAt: timestamp, lastLesson: null };
      const session = mode === 'challenge' ? { id, startedAt: now, durationSeconds, correct: 0, mistakes: 0, streak: 0, bestStreak: 0, seen: [], finished: false } : null;
      await this.begin(game, selected, mode, session);
      await this.store.save(game);
      return this.service.snapshot(game);
    });
  }
  select(profile, mode, seen = []) {
    const available = this.puzzles.filter(p => !seen.includes(p.id));
    if (!available.length) return null;
    if (mode === 'rated') {
      const fresh = available.filter(p => !profile.progress[this.progressKey(p)]?.ratedCompleted);
      return (fresh.length ? fresh : available).sort((a, b) => Math.abs(a.rating - profile.rating) - Math.abs(b.rating - profile.rating))[0];
    }
    return available.find(p => !profile.progress[this.progressKey(p)]?.solved) ?? available[0];
  }
  async begin(game, puzzle, mode, session) {
    if (!puzzle) throw new Error('题库中没有可用的下一题。');
    const position = await this.service.rules.inspect(puzzle.fen);
    if (position.terminal) throw new Error('这道题的初始局面已经结束，暂不能训练。');
    game.initialFen = position.fen; game.fen = position.fen; game.playerSide = position.turn;
    game.moves = []; game.lastLesson = null; game.status = 'active'; game.result = null;
    game.training = { puzzleId: puzzle.id, mode, status: 'active', startedAt: this.now(), hints: 0, mistakes: 0, stars: 0,
      finalized: false, feedback: `你执${position.turn === 'r' ? '红' : '黑'}，请在${puzzle.maxPlayerMoves}手内取胜（将死或困毙）。`, ...(session ? { session } : {}) };
    if (session && !session.seen.includes(puzzle.id)) session.seen.push(puzzle.id);
    const profile = this.store.trainingProfile(), key = this.progressKey(puzzle);
    const progress = profile.progress[key] ??= blankProgress();
    progress.attempts++; progress.lastOutcome = 'active'; profile.attempts++;
    this.store.saveTrainingProfile(profile);
  }
  continuations(game) {
    const history = game.moves.map(m => m.uci);
    return this.puzzle(game.training.puzzleId).solutions.filter(line => history.every((move, index) => line[index] === move));
  }
  markMistake(game) {
    const t = game.training, profile = this.store.trainingProfile(), key = this.progressKey(this.puzzle(t.puzzleId));
    const progress = profile.progress[key] ??= blankProgress();
    t.mistakes++; progress.mistakes++; progress.needsReview = true;
    this.store.saveTrainingProfile(profile);
  }
  finishSession(t, reason) {
    const session = t.session;
    if (!session || session.finished) return;
    session.finished = true; session.reason = reason; session.completedAt = this.now();
    const profile = this.store.trainingProfile();
    if (!profile.challenges.some(s => s.id === session.id)) {
      profile.challenges.unshift({ ...session, seen: session.seen.length });
      profile.challenges = profile.challenges.slice(0, 30);
      this.store.saveTrainingProfile(profile);
    }
  }
  finish(game, status) {
    const t = game.training;
    if (t.finalized) return;
    t.status = status; t.finalized = true; t.completedAt = this.now();
    const solved = status === 'solved';
    t.stars = solved ? (t.hints ? 1 : t.mistakes ? 2 : 3) : 0;
    game.status = 'finished';
    const profile = this.store.trainingProfile(), puzzle = this.puzzle(t.puzzleId), key = this.progressKey(puzzle);
    const progress = profile.progress[key] ??= blankProgress();
    progress.lastOutcome = status;
    progress.solved ||= solved;
    progress.bestStars = Math.max(progress.bestStars, t.stars);
    progress.needsReview = !solved || t.mistakes > 0 || t.hints > 0;
    profile.correct += Number(solved);
    profile.streak = solved && t.stars === 3 ? profile.streak + 1 : 0;
    profile.bestStreak = Math.max(profile.bestStreak, profile.streak);
    if (t.mode === 'rated') {
      t.ratingChange = 0;
      if (!progress.ratedCompleted) {
        const expected = 1 / (1 + 10 ** ((puzzle.rating - profile.rating) / 400));
        t.ratingChange = Math.round(32 * (Number(solved && !t.hints && !t.mistakes) - expected));
        profile.rating = Math.max(0, profile.rating + t.ratingChange);
        progress.ratedCompleted = true;
      }
    }
    profile.recent.unshift({ gameId: game.id, puzzleId: puzzle.id, title: puzzle.title, mode: t.mode, status, stars: t.stars,
      elapsedSeconds: Math.max(0, Math.floor((t.completedAt - t.startedAt) / 1000)), completedAt: new Date(t.completedAt).toISOString(), ratingChange: t.ratingChange ?? null });
    profile.recent = profile.recent.slice(0, 100);
    this.store.saveTrainingProfile(profile);
    if (t.session) {
      const s = t.session;
      s.correct += Number(solved); s.mistakes += Number(!solved);
      s.streak = solved ? s.streak + 1 : 0; s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (this.expired(t)) this.finishSession(t, '时间到');
      else if (s.mistakes >= 3) this.finishSession(t, '累计3题未完成');
      else if (s.seen.length >= this.puzzles.length) this.finishSession(t, '本场题库已完成');
    }
  }
  expire(game) {
    if (!this.expired(game.training)) return false;
    if (game.training.status === 'active') this.finish(game, 'expired');
    else this.finishSession(game.training, '时间到');
    game.training.feedback = '挑战时间已到，本场结束。'; return true;
  }
  async solution(game) {
    const puzzle = this.puzzle(game.training.puzzleId);
    const lines = this.continuations(game);
    const line = [...(lines.length ? lines : puzzle.solutions)].sort((a, b) => b.length - a.length)[0];
    let fen = game.initialFen;
    const steps = [];
    for (const uci of line) {
      const { move, state } = await this.service.rules.resolveMove(fen, uci);
      const next = await this.service.rules.inspect(fen, [uci]);
      steps.push({ uci, chinese: move.chinese, side: state.turn, fen: next.fen }); fen = next.fen;
    }
    return { steps, explanation: puzzle.explanation };
  }
  async play(game, move) {
    if (this.expire(game)) return;
    const t = game.training;
    if (t.status !== 'active') throw new Error('本题已结束，可以查看答案、重试或进入下一题。');
    const index = game.moves.length;
    if (!this.continuations(game).some(line => line[index] === move.uci)) {
      this.markMistake(game);
      t.feedback = `这步未达到${this.puzzle(t.puzzleId).maxPlayerMoves}手内取胜的目标。${t.mode === 'learn' ? '棋盘已保留，请再试一次。' : '本题结束，可查看答案或进入下一题。'}`;
      if (t.mode !== 'learn') this.finish(game, 'failed');
      return;
    }
    const state = await this.service.append(game, move.uci);
    if (state.terminal) {
      if (state.winner !== game.playerSide) throw new Error('题目答案校验不一致，本次未保存。');
      this.finish(game, 'solved'); t.feedback = `完成！${state.endReason === 'checkmate' ? '将死' : '获胜终局'}已由棋规验证。`;
      t.solution = await this.solution(game);
    } else t.feedback = '正确，继续观察对方的应手。';
  }
  async reply(game) {
    if (this.expire(game)) return;
    if (game.training.status !== 'active') throw new Error('本题已结束。');
    const line = [...this.continuations(game)].sort((a, b) => b.length - a.length)[0];
    const move = line?.[game.moves.length];
    if (!move) throw new Error('没有通过验证的防守应手，本次未保存。');
    const state = await this.service.append(game, move);
    if (state.terminal) throw new Error('训练防守线路意外终止，本次未保存。');
    game.training.feedback = '对方已应手，请继续争取获胜。';
  }
  async action(args) {
    if (!['hint', 'answer', 'retry', 'next'].includes(args.action)) throw new Error('未知的训练操作。');
    return this.service.mutate(args, { action: 'training', operation: args.action, expectedVersion: args.expectedVersion }, async game => {
      if (game.mode !== 'training' || !game.training) throw new Error('当前棋局不是训练题。');
      const expired = this.expire(game);
      const t = game.training, puzzle = this.puzzle(t.puzzleId);
      if (args.action === 'hint') {
        if (expired) return;
        if (t.status !== 'active') throw new Error('本题已结束，请重试或查看答案。');
        t.hints++;
        if (t.mode !== 'learn') this.finish(game, 'revealed');
        const choices = this.continuations(game);
        const next = choices[0]?.[game.moves.length];
        t.feedback = t.hints === 1 || !next ? puzzle.hint : `可考虑：${(await this.service.rules.resolveMove(game.fen, next)).move.chinese}。`;
        if (t.mode !== 'learn') t.feedback += ' 本次评分/挑战作答已结束；可重试进入学习。';
      } else if (args.action === 'answer') {
        if (t.status === 'active') this.finish(game, 'revealed');
        t.solution = await this.solution(game);
        t.feedback = '以下是一条已核验的解法，可以重试看是否能独立完成。';
      } else if (args.action === 'retry') {
        if (t.status === 'active') this.finish(game, 'failed');
        this.finishSession(t, '转入学习重练');
        await this.begin(game, puzzle, 'learn', null);
      } else {
        if (t.status === 'active') this.finish(game, 'failed');
        if (t.session?.finished || this.expired(t)) {
          this.finishSession(t, '时间到');
          t.feedback = `本场挑战结束：答对${t.session.correct}题，最长连对${t.session.bestStreak}题。`;
          return;
        }
        const profile = this.store.trainingProfile();
        let selected;
        if (t.session) selected = this.select(profile, t.mode, t.session.seen);
        else if (t.mode === 'rated') selected = this.select(profile, t.mode);
        else selected = this.puzzles[(this.puzzles.findIndex(p => p.id === puzzle.id) + 1) % this.puzzles.length];
        if (!selected) { this.finishSession(t, '本场题库已完成'); return; }
        await this.begin(game, selected, t.mode, t.session ?? null);
      }
    });
  }
}
