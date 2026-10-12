export const stageNames = { opening: '开局', middlegame: '中局', endgame: '残局' };
export const formatMoveScore = value => value === null ? '未定' : String(Math.floor(value * 10) / 10);
export const gradeClassFor = value => value === null ? 'unknown' : Math.max(0, Math.min(5, Math.floor(value / 20)));
export function sameReviewPosition(report, game) {
  return !!report && !!game && report.gameId === game.id && report.total <= game.moves.length && report.rootFen === (report.total ? game.moves[report.total - 1]?.fen : game.initialFen);
}
export function isCompleteCurrentReview(report, game) {
  return !!report && report.status === 'complete' && !report.outdatedMethod && sameReviewPosition(report, game) && report.total === game.moves.length;
}
export function needsAutomaticReview(game, report) {
  return game?.status === 'finished' && game.moves.length > 0 && (!sameReviewPosition(report, game) || report.total < game.moves.length || report.outdatedMethod === true);
}
export class ReviewLoader {
  constructor({ call, getGame, onReport, onStatus }) { Object.assign(this, { call, getGame, onReport, onStatus }); this.generation = 0; this.timer = null; }
  stop() { this.generation++; clearTimeout(this.timer); this.timer = null; }
  async start() {
    this.stop(); const generation = this.generation, game = this.getGame();
    if (!game) return;
    this.onStatus('正在准备逐手复盘…');
    try {
      const report = await this.call('start_review', { gameId: game.id, expectedVersion: game.version });
      this.accept(report, generation);
    } catch (error) { if (generation === this.generation) this.onStatus(error.message); }
  }
  async open(gameId, reviewId) {
    this.stop(); const generation = this.generation;
    this.onStatus('正在读取复盘…');
    await this.poll(gameId, reviewId, generation);
  }
  accept(report, generation) {
    if (generation !== this.generation) return;
    if (report.obsolete || !sameReviewPosition(report, this.getGame())) { this.stop(); this.onReport(null); this.onStatus('这段棋谱已撤回，请重新复盘。'); return; }
    this.onReport(report);
    this.onStatus(report.status === 'running' ? `正在分析第 ${Math.min(report.total, report.rows.length + 1)} / ${report.total} 手…` : report.status === 'complete' ? '复盘已完成，点击转折点或棋谱可以对照棋盘。' : report.error || '复盘尚未完成，可以继续。');
    if (report.status === 'running') this.timer = setTimeout(() => this.poll(report.gameId, report.id, generation), 900);
  }
  async poll(gameId, reviewId, generation) {
    try { this.accept(await this.call('read_review', { gameId, reviewId }), generation); }
    catch (error) { if (generation === this.generation) { this.timer = null; this.onStatus(`读取复盘暂时失败：${error.message}`); } }
  }
}

export function renderReview({ root, report, selectedPly, onSelect }) {
  const $ = id => root.querySelector(`#${id}`);
  const scrollTop = $('review-moves').scrollTop;
  $('review-progress').hidden = !report || report.status !== 'running';
  $('review-progress').max = report?.total || 1; $('review-progress').value = report?.rows?.length ?? 0;
  $('review-summary').replaceChildren(); $('review-phases').replaceChildren(); $('review-turns').replaceChildren(); $('review-moves').replaceChildren();
  $('review-details').hidden = !report?.rows?.length;
  for (const field of ['source', 'formula', 'grades', 'stages', 'mistakes', 'openingBook']) {
    const element = $(`review-method-${field}`);
    if (element) { element.textContent = report?.method?.[field] ?? ''; element.hidden = !element.textContent; }
  }
  if (!report?.rows?.length) return;
  const make = (tag, className, text) => { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; };
  for (const side of ['r', 'b']) {
    const stats = report.summary[side], card = make('div', `review-side ${side}`);
    card.append(make('span', '', side === 'r' ? '红方本局表现' : '黑方本局表现'), make('strong', '', stats.accuracy === null ? '—' : String(stats.displayAccuracy ?? stats.accuracy)), make('small', '', `失误 ${stats.mistakes} · 漏杀 ${stats.missedMates}${stats.possibleMissedMates ? ` · 疑似漏杀 ${stats.possibleMissedMates}` : ''}`));
    card.append(make('small', 'subtle', ['优', '良', '中', '差', '错'].map(grade => `${grade}${stats.counts[grade]}`).join('  ') + (stats.counts['未定'] ? `  未定${stats.counts['未定']}` : '')));
    $('review-summary').append(card);
  }
  for (const [stage, label] of Object.entries(stageNames)) {
    const row = make('div', 'review-phase'); row.append(make('span', '', label));
    for (const side of ['r', 'b']) {
      const phase = report.summary[side].phases[stage];
      row.append(make('span', side === 'r' ? 'red-text' : '', !phase.moves ? '未进入' : phase.accuracy === null ? '未定' : `${phase.displayAccuracy ?? phase.accuracy}分`));
    }
    $('review-phases').append(row);
  }
  for (const row of report.keyTurns ?? []) {
    const reason = row.quality.missedMate ? '漏杀' : row.quality.possibleMissedMate ? '疑似漏杀，需复核' : row.quality.loss === null ? row.quality.note : `损失约${row.quality.loss}分`;
    const button = make('button', 'review-key', `第${row.ply}手 ${row.chinese} · ${reason}`);
    button.onclick = () => onSelect(row.ply); $('review-turns').append(button);
  }
  if (!report.keyTurns?.length) $('review-turns').append(make('p', 'subtle', report.status === 'complete' ? '已评着法中，没有检出超过50分的损失或明确漏杀。' : '分析完成后会列出值得回看的着法。'));
  for (const row of report.rows) {
    const button = make('button', `review-move${selectedPly === row.ply ? ' selected' : ''}`);
    button.append(make('span', row.side === 'r' ? 'red-text' : '', `${row.ply}. ${row.chinese}`), make('span', `grade grade-${gradeClassFor(row.quality.accuracy)}`, `${row.quality.grade}${row.quality.accuracy === null ? '' : ` ${formatMoveScore(row.quality.accuracy)}`}`));
    button.onclick = () => onSelect(row.ply); $('review-moves').append(button);
  }
  $('review-moves').scrollTop = scrollTop;
}
