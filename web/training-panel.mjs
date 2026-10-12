const modeLabels = { learn: '学习模式', rated: '本地评测', challenge: '限时挑战' };
const statusLabels = { active: '正在练习', solved: '解题成功', failed: '本题未通过', revealed: '已查看答案', expired: '本次挑战结束' };
const difficultyLabels = { beginner: '入门', easy: '基础', medium: '进阶', hard: '挑战', advanced: '高阶' };

export const isTraining = snapshot => snapshot?.game?.mode === 'training';
export const trainingModeLabel = mode => modeLabels[mode] ?? '残局训练';
export const trainingStatusLabel = status => statusLabels[status] ?? '残局训练';
export const difficultyLabel = value => difficultyLabels[value] ?? String(value ?? '未分级');
export const trainingFeedback = training => typeof training?.feedback === 'string' ? training.feedback : training?.feedback?.message ?? '';
export const trainingGoal = puzzle => puzzle.goal === 'mate' ? `${puzzle.maxPlayerMoves}手内取胜（将死或困毙）` : puzzle.goal;
export function trainingTimeLabel(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function trainingSolutionPreview(snapshot) {
  const solution = snapshot?.training?.solution;
  // Only an explicitly disclosed server solution is available to the board.
  if (!isTraining(snapshot) || !solution?.steps?.length) return null;
  return { rootFen: snapshot.game.initialFen, line: { steps: solution.steps }, index: 0, title: '训练答案 · 逐步演示' };
}

// The display advances locally; only the server may finish or score a challenge.
// At zero request one authoritative refresh, with no background polling loop.
export class ChallengeClock {
  constructor({ onTick, onExpire, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer) }) {
    Object.assign(this, { onTick, onExpire, now, schedule, cancel });
    this.generation = 0; this.expiredKey = null;
  }
  update(key, challenge) {
    this.stop();
    if (!challenge) { this.key = null; this.expiredKey = null; return; }
    const sameSession = this.key === key;
    if (!sameSession) this.expiredKey = null;
    this.key = key;
    if (challenge.remainingSeconds === null) { this.onTick(null, !!challenge.finished); return; }
    const deadline = this.now() + Math.max(0, Number(challenge.remainingSeconds) || 0) * 1000;
    // MCP hosts can replay the same result; a replay must never add time.
    this.deadline = sameSession && Number.isFinite(this.deadline) ? Math.min(this.deadline, deadline) : deadline;
    const generation = this.generation;
    const tick = async () => {
      if (generation !== this.generation) return;
      const remaining = Math.max(0, Math.ceil((this.deadline - this.now()) / 1000));
      this.onTick(remaining, !!challenge.finished);
      if (challenge.finished) return;
      if (!remaining) {
        if (this.expiredKey === key) return;
        this.expiredKey = key;
        // A pending move may need to settle before the expiry read is safe.
        const handled = await this.onExpire(key);
        if (generation !== this.generation) return;
        if (handled === false) { this.expiredKey = null; this.timer = this.schedule(tick, 1000); }
        return;
      }
      this.timer = this.schedule(tick, Math.min(1000, this.deadline - this.now()));
    };
    tick();
  }
  stop() { this.generation++; this.cancel(this.timer); this.timer = null; }
}

export class TrainingPanel {
  constructor({ root, call, onChange, onStart, onAction, onReturn, onPreview, onExpire }) {
    Object.assign(this, { root, call, onChange, onStart, onAction, onReturn, onPreview });
    this.$ = id => root.getElementById(id);
    this.opened = false; this.browsing = true; this.catalog = null; this.loading = false; this.error = '';
    this.filter = { theme: '', difficulty: '', source: '', mistakesOnly: false }; this.mode = 'learn'; this.durationSeconds = 180;
    this.page = 0; this.pageSize = 24;
    this.request = 0; this.snapshot = null; this.busy = false; this.connected = false;
    this.clock = new ChallengeClock({ onTick: (remaining, finished) => {
      this.$('training-time').textContent = remaining === null ? '∞' : trainingTimeLabel(remaining);
      this.$('training-clock-caption').textContent = finished ? '挑战已结束' : remaining === null ? '不限时挑战' : remaining ? '剩余时间' : '时间到 · 等待确认';
      this.$('training-challenge').classList.toggle('ending', !finished && remaining !== null && remaining <= 30);
    }, onExpire });
    this.$('training-close').onclick = () => {
      if (isTraining(this.snapshot)) this.onReturn(); else this.close();
    };
    this.$('training-browse').onclick = () => { this.browsing = !this.browsing; this.render(); if (this.browsing) this.load(); };
    for (const mode of Object.keys(modeLabels)) this.$(`training-mode-${mode}`).onclick = () => { this.mode = mode; this.render(); };
    this.$('training-theme').onchange = event => { this.filter.theme = event.target.value; this.load(); };
    this.$('training-difficulty').onchange = event => { this.filter.difficulty = event.target.value; this.load(); };
    this.$('training-source-filter').onchange = event => { this.filter.source = event.target.value; this.load(); };
    this.$('training-mistakes').onchange = event => { this.filter.mistakesOnly = event.target.checked; this.load(); };
    this.$('training-duration').onchange = event => { this.durationSeconds = Number(event.target.value); this.render(); };
    this.$('training-load').onclick = () => this.load();
    for (const [name, delta] of [['prev', -1], ['next', 1]]) this.$(`training-page-${name}`).onclick = () => {
      this.page += delta; this.render(); this.$('training-cards').scrollTop = 0;
    };
    this.$('training-challenge-start').onclick = () => this.start();
    for (const action of ['hint', 'answer', 'retry', 'next']) this.$(`training-${action}`).onclick = () => this.onAction(action);
    this.$('training-preview').onclick = () => { const value = trainingSolutionPreview(this.snapshot); if (value) this.onPreview(value); };
  }
  open() { this.opened = true; this.browsing = !isTraining(this.snapshot); this.onChange(); this.load(); }
  close() { if (isTraining(this.snapshot)) return; this.opened = false; this.onChange(); }
  get visible() { return this.opened || isTraining(this.snapshot); }
  update(snapshot, { busy, connected, hasReturn = false } = {}) {
    const previous = this.snapshot;
    this.busy = busy; this.connected = connected; this.hasReturn = hasReturn; this.snapshot = snapshot;
    if (isTraining(snapshot)) {
      if (snapshot !== previous) {
        if (snapshot.game.id !== previous?.game?.id || snapshot.training?.puzzle.id !== previous?.training?.puzzle.id) this.browsing = false;
        this.clock.update(snapshot.game.id, snapshot.training?.challenge);
      }
      this.opened = true;
    } else if (isTraining(previous)) { this.clock.stop(); this.opened = false; }
    this.render();
  }
  async load() {
    if (!this.connected) return;
    this.page = 0;
    const request = ++this.request;
    this.loading = true; this.error = ''; this.render();
    try {
      const catalog = await this.call('list_training', {
        ...(this.filter.theme ? { theme: this.filter.theme } : {}),
        ...(this.filter.difficulty ? { difficulty: this.filter.difficulty } : {}),
        ...(this.filter.source ? { source: this.filter.source } : {}),
        ...(this.filter.mistakesOnly ? { mistakesOnly: true } : {}),
      });
      if (request !== this.request) return;
      this.catalog = catalog;
      // Keep options stable when the server returns a filtered list.
      this.difficulties = [...new Set([...(this.difficulties ?? []), ...(catalog.puzzles ?? []).map(puzzle => puzzle.difficulty)])];
    } catch (error) { if (request === this.request) this.error = error.message; }
    finally { if (request === this.request) { this.loading = false; this.render(); } }
  }
  start(puzzleId) {
    if (this.busy || !this.connected || this.loading || this.error) return;
    this.onStart({ ...(puzzleId ? { puzzleId } : {}), mode: this.mode, durationSeconds: this.mode === 'challenge' ? this.durationSeconds : 0 });
  }
  render() {
    const $ = this.$, training = isTraining(this.snapshot) ? this.snapshot.training : null;
    $('training-panel').hidden = !this.visible;
    if (!this.visible) return;
    $('training-close').textContent = training ? this.hasReturn ? '返回原棋局' : '打开最近棋局' : '回到棋局';
    $('training-close').disabled = this.busy;
    const summary = training?.summary ?? this.catalog?.summary;
    $('training-rating').textContent = summary?.rating ?? '—';
    $('training-completed').textContent = summary ? `${summary.solved ?? 0}/${summary.total ?? this.catalog?.summary?.total ?? 0}` : '—';
    $('training-streak').textContent = summary?.bestStreak ?? '—';
    const method = training?.method ?? this.catalog?.method;
    if (method) for (const field of ['judging', 'stars', 'rating', 'challenge', 'source']) {
      const element = $(`training-method-${field}`); element.textContent = method[field] ?? ''; element.hidden = !method[field];
    }
    $('training-current').hidden = !training;
    $('training-library').hidden = !!training && !this.browsing;
    $('training-browse').hidden = !training;
    $('training-browse').disabled = this.busy;
    $('training-browse').setAttribute('aria-expanded', String(!training || this.browsing));
    $('training-browse').textContent = this.browsing ? '收起题库' : '选题 / 切换模式';
    if (training) this.renderAttempt(training);
    this.renderLibrary();
  }
  renderAttempt(training) {
    const $ = this.$, puzzle = training.puzzle, active = training.status === 'active';
    $('training-mode-label').textContent = trainingModeLabel(training.mode);
    $('training-title').textContent = puzzle.title;
    $('training-goal').textContent = trainingGoal(puzzle);
    $('training-puzzle-meta').textContent = `${puzzle.theme} · ${difficultyLabel(puzzle.difficulty)} · 参考难度 ${puzzle.rating}`;
    $('training-attempt-status').textContent = trainingStatusLabel(training.status);
    $('training-attempt-status').dataset.status = training.status;
    $('training-feedback').textContent = trainingFeedback(training) || `在棋盘走出你的答案。你执${this.snapshot.game.playerSide === 'r' ? '红' : '黑'}方。`;
    $('training-feedback').dataset.status = training.status;
    $('training-attempt-stats').textContent = `已走 ${training.playerMoves ?? 0}/${puzzle.maxPlayerMoves} 手 · 失误 ${training.mistakes ?? 0} 次 · 提示 ${training.hints ?? 0} 次${active ? '' : ` · 用时 ${trainingTimeLabel(training.elapsedSeconds)}`}`;
    $('training-stars').hidden = active;
    const stars = Math.min(3, Math.max(0, Number(training.stars) || 0));
    $('training-stars').textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
    $('training-stars').setAttribute('aria-label', `本题获得 ${stars} 星，满星 3 星`);
    $('training-rating-change').hidden = training.ratingChange === undefined;
    $('training-rating-change').textContent = training.ratingChange === undefined ? '' : `本次训练分 ${training.ratingChange > 0 ? '+' : ''}${training.ratingChange}`;
    $('training-challenge').hidden = !training.challenge;
    if (training.challenge) $('training-challenge-stats').textContent = `答对 ${training.challenge.correct ?? 0} 题 · ${training.challenge.finished ? '最高连对' : '连对'} ${training.challenge.finished ? training.challenge.bestStreak ?? 0 : training.challenge.streak ?? 0} 题 · 错题 ${training.challenge.mistakes ?? 0} 题${training.challenge.finished && training.challenge.reason ? ` · ${training.challenge.reason}` : ''}`;
    $('training-hint').hidden = !active;
    $('training-answer').hidden = !!training.solution;
    $('training-retry').hidden = active || training.mode === 'challenge' && !training.challenge?.finished;
    $('training-next').hidden = active || !!training.challenge?.finished;
    $('training-retry').textContent = training.mode === 'rated' ? '重新学习本题' : training.mode === 'challenge' ? '学习本题' : '重试本题';
    $('training-next').textContent = training.mode === 'challenge' ? '继续挑战' : '下一题';
    $('training-answer').textContent = active && training.mode !== 'learn' ? '结束本题 · 看答案' : '查看答案';
    $('training-hint').textContent = training.mode === 'rated' ? '结束评测 · 看提示' : training.mode === 'challenge' ? '结束本题 · 看提示' : '给点提示';
    for (const action of ['hint', 'answer', 'retry', 'next']) $(`training-${action}`).disabled = this.busy || !this.connected;
    const solution = training.solution;
    $('training-solution').hidden = !solution;
    if (solution) {
      $('training-solution-copy').textContent = solution.explanation ?? '';
      const key = `${this.snapshot.game.id}:${puzzle.id}:${solution.steps?.map(step => step.uci).join(' ')}`;
      if (key !== this.solutionKey) {
        this.solutionKey = key;
        $('training-line').replaceChildren(...(solution.steps ?? []).map((step, index) => {
          const item = this.root.createElement('li'); item.textContent = `${index + 1}. ${step.side === 'r' ? '红方' : '黑方'} ${step.chinese}`; return item;
        }));
      }
      $('training-preview').hidden = !solution.steps?.length;
      $('training-preview').disabled = this.busy;
    }
    const source = puzzle.source;
    $('training-source').textContent = typeof source === 'string' ? source : source?.label ?? source?.title ?? '本地编排训练题';
    if (source?.kind === 'ccpd') {
      const credit = this.root.createElement('span'); credit.textContent = ` · ${source.authors} · 已截取局面并重新验证答案。`;
      const link = this.root.createElement('a'); link.textContent = '原棋谱'; link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const license = this.root.createElement('a'); license.textContent = ' CC BY 4.0'; license.href = source.licenseUrl; license.target = '_blank'; license.rel = 'noopener noreferrer';
      $('training-source').append(credit, link, license);
    }
  }
  renderLibrary() {
    const $ = this.$;
    for (const mode of Object.keys(modeLabels)) {
      $(`training-mode-${mode}`).setAttribute('aria-pressed', String(mode === this.mode));
      $(`training-mode-${mode}`).disabled = this.busy;
    }
    $('training-mode-copy').textContent = this.mode === 'learn' ? '按主题练习，遇到难处可看提示，完成后对照答案。'
      : this.mode === 'rated' ? '每道题首次评测计入本地训练分。使用提示或答案会结束本次评测。'
      : this.durationSeconds ? '在限定时间内连续解题，累计三题失败结束。切换题库也不会暂停计时。' : '不限时连续解题，每题只出现一次，累计三题失败或题库用尽后结束。';
    $('training-duration-label').hidden = this.mode !== 'challenge';
    $('training-challenge-start').hidden = this.mode !== 'challenge';
    $('training-challenge-start').textContent = this.durationSeconds ? `开始 ${this.durationSeconds / 60} 分钟挑战` : '开始不限时挑战';
    $('training-challenge-start').disabled = this.busy || !this.connected || this.loading || !!this.error || !this.catalog?.summary?.total;
    $('training-duration').disabled = this.busy;
    $('training-library-status').textContent = this.loading ? '正在读取题库与练习记录…' : this.error ? `题库暂时不可用：${this.error}`
      : this.catalog ? this.catalog.puzzles.length ? `当前 ${this.catalog.puzzles.length} 题${this.mode === 'challenge' ? ' · 挑战从完整题库自动选题' : ''}` : this.filter.mistakesOnly ? '还没有符合筛选的错题。' : '没有符合筛选的题目，试试其他主题或难度。' : '连接后可打开本地题库。';
    $('training-load').hidden = !this.error;
    $('training-load').disabled = this.loading || this.busy;
    const themes = this.catalog?.themes ?? [];
    this.options('training-theme', themes.map(theme => typeof theme === 'string' ? { value: theme, label: theme } : { value: theme.id ?? theme.name, label: theme.label ?? theme.name ?? theme.id }), this.filter.theme, '全部主题');
    this.options('training-difficulty', (this.difficulties ?? []).map(value => ({ value, label: difficultyLabel(value) })), this.filter.difficulty, '全部难度');
    $('training-source-filter').value = this.filter.source;
    for (const id of ['training-theme', 'training-difficulty', 'training-source-filter', 'training-mistakes']) $(id).disabled = this.busy || this.loading;
    const puzzles = this.catalog?.puzzles ?? [], pages = Math.ceil(puzzles.length / this.pageSize);
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    $('training-pagination').hidden = pages <= 1;
    $('training-page-info').textContent = `第 ${this.page + 1} / ${pages || 1} 页`;
    $('training-page-prev').disabled = this.busy || this.loading || this.page === 0;
    $('training-page-next').disabled = this.busy || this.loading || this.page >= pages - 1;
    const key = JSON.stringify([this.catalog?.catalogVersion, puzzles, this.page, this.mode, this.loading, this.error, this.busy, this.connected]);
    if (key === this.cardsKey) return;
    this.cardsKey = key;
    $('training-cards').replaceChildren(...puzzles.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize).map(puzzle => {
      const card = this.root.createElement('article'); card.className = 'training-card';
      const title = this.root.createElement('h3'); title.textContent = puzzle.title;
      const badge = this.root.createElement('span'); badge.className = 'training-card-badge'; badge.textContent = `${puzzle.theme} · ${difficultyLabel(puzzle.difficulty)} · ${puzzle.source?.kind === 'ccpd' ? 'CCPD 实战' : '本地原创'}`;
      const goal = this.root.createElement('p'); goal.textContent = trainingGoal(puzzle);
      const progress = this.root.createElement('span'); progress.className = 'training-card-progress';
      const stars = Math.min(3, Math.max(0, Number(puzzle.progress?.bestStars) || 0));
      progress.textContent = puzzle.progress?.solved ? `${'★'.repeat(stars)} 已解出` : puzzle.progress?.attempts ? `已练 ${puzzle.progress.attempts} 次${puzzle.progress.mistakes ? ` · 失误 ${puzzle.progress.mistakes} 次` : ''}` : '尚未练习';
      if (this.mode === 'rated' && puzzle.progress?.ratedCompleted) progress.textContent += ' · 已评测';
      const button = this.root.createElement('button'); button.className = 'training-card-start';
      button.textContent = this.mode === 'rated' ? puzzle.progress?.ratedCompleted ? '复练 · 不计分' : '开始评测' : this.mode === 'challenge' ? '从这题挑战' : '开始练习';
      button.setAttribute('aria-label', `${button.textContent}：${puzzle.title}`);
      button.disabled = this.busy || !this.connected || this.loading || !!this.error;
      button.onclick = () => this.start(puzzle.id);
      card.append(badge, title, goal, progress, button); return card;
    }));
  }
  options(id, values, selected, placeholder) {
    const select = this.$(id), key = JSON.stringify(values);
    if (select.dataset.options !== key) {
      select.dataset.options = key;
      select.replaceChildren(...[{ value: '', label: placeholder }, ...values].map(({ value, label }) => {
        const option = this.root.createElement('option'); option.value = value; option.textContent = label; return option;
      }));
    }
    select.value = selected;
  }
  stop() { this.request++; this.clock.stop(); }
}
