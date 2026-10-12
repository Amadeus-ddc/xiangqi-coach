import { App } from '@modelcontextprotocol/ext-apps';
import { playTurn, replyTurn } from './turn-flow.mjs';
import { ScoreLoader, drawScoreChart, retainScores, displayedScore, updateScoreLabel } from './score-chart.mjs';
import { deliverInlineLesson, sameLessonPosition } from './inline-teaching.mjs';
import { ReviewLoader, renderReview, sameReviewPosition, isCompleteCurrentReview, needsAutomaticReview, stageNames, formatMoveScore } from './review-panel.mjs';
import { SetupDraft, START_FEN, PIECE_NAMES, piecesFromFen } from './setup-board.mjs';
import { BoardMotion } from './board-motion.mjs';
import { BoardSquares } from './board-squares.mjs';
import { BoardEffects } from './board-effects.mjs';
import { TrainingPanel, isTraining, trainingFeedback, trainingStatusLabel } from './training-panel.mjs';

const $ = id => document.getElementById(id);
const names = PIECE_NAMES;
const startFen = START_FEN;
let data = null, selected = null, busy = false, connected = false, flipped = false, preview = null, choices = [];
let pendingMove = null, phase = null, needsRefresh = false, teachingBusy = false, lessonEvidence = null;
let boardLesson = null, lessonTimer = null, lessonWatch = 0, scoreSelection = null, scoreStatus = '', displayedAnswer = null;
let boardReview = null, reviewRow = null, insightTab = 'lesson', reviewStatus = '', reviewAutoKey = '', reviewSelectionToken = 0, sandbox = null;
let hostView = {};
let setup = null, pendingReviewLesson = null;
let trainingReturnId = null;
const recording = () => data?.game.mode === 'record';
const training = () => isTraining(data);
const sentRequests = new Set();
const afterPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const roundKey = (game = data?.game) => game ? `${game.id}:${game.version}` : '';
const hasLesson = kind => sentRequests.has(`${roundKey()}:${kind}`) || boardLesson?.status === 'complete' && boardLesson.kind === kind && boardLesson.gameId === data?.game.id && boardLesson.version === data?.game.version;
const app = new App({ name: '象棋教练', version: '0.1.0' }, {});
let effectsEnabled = true;
try { effectsEnabled = localStorage.getItem('xiangqi-star-river-effects') !== 'off'; } catch {}
const motionPreference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const boardEffects = new BoardEffects({ board: $('squares').parentElement, enabled: () => effectsEnabled });
const boardSquares = new BoardSquares({ root: $('squares'), createPiece, onSelect: clickSquare });
const boardMotion = new BoardMotion({ board: $('squares').parentElement, squares: $('squares'), createPiece, effects: boardEffects, onSettled: renderBoard });
const scoreLoader = new ScoreLoader({ call, getSnapshot: () => training() ? null : data,
  onPoint: point => { data.scores[point.ply] = { ...data.scores[point.ply], ...point }; renderScores(); },
  onStatus: text => { scoreStatus = text; renderScores(); },
});
const reviewLoader = new ReviewLoader({ call, getGame: () => data?.game,
  onReport: report => { if (boardReview?.id !== report?.id) { reviewSelectionToken++; reviewRow = null; } boardReview = report; if (!report) reviewRow = null; renderReviewPanel(); renderScores(); completeRequestedReview(); },
  onStatus: text => { reviewStatus = text; renderReviewPanel(); },
});
const trainingPanel = new TrainingPanel({ root: document, call, onChange: render,
  onStart: startTraining, onAction: trainingAction, onReturn: returnFromTraining,
  onPreview: value => { preview = value; selected = null; notice('正在演示训练答案。用“下一步”逐手查看。'); render(); },
  onExpire: syncTrainingExpiry,
});

function notice(text = '', error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function unpack(result) {
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? '操作没有完成，请重试。');
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}
async function call(name, args = {}) {
  if (!connected) throw new Error('棋盘尚未连接，请稍后重试。');
  return unpack(await app.callServerTool({ name, arguments: args }));
}
function adopt(next) {
  if (!next.game) { if (next.needsNewGame) data = null; render(); return; }
  if (data?.game.id === next.game.id && next.game.version < data.game.version) return;
  if (isTraining(next) && data?.game && !training()) trainingReturnId = data.game.id;
  if (data?.game.id !== next.game.id) {
    flipped = next.game.playerSide === 'b'; boardLesson = null; scoreSelection = null;
    boardReview = null; reviewRow = null; sandbox = null; insightTab = 'lesson'; reviewStatus = ''; reviewLoader.stop(); reviewSelectionToken++;
    stopLessonWatch(); teachingBusy = false;
  }
  if (roundKey(next.game) !== roundKey()) {
    pendingReviewLesson = null;
    lessonEvidence = null;
    scoreSelection = null; sandbox = null;
    if (!teachingBusy) $('lesson-status').textContent = '';
  }
  if (isTraining(next) && data?.game.initialFen !== next.game.initialFen) flipped = next.game.playerSide === 'b';
  if (boardReview && !sameReviewPosition(boardReview, next.game)) { boardReview = null; reviewRow = null; reviewLoader.stop(); reviewSelectionToken++; }
  if (!boardLesson || !sameLessonPosition(boardLesson, next.game)) boardLesson = next.boardLesson ?? null;
  else if (next.boardLesson?.requestId === boardLesson.requestId && next.boardLesson.status === 'complete') boardLesson = next.boardLesson;
  next = { ...next, scores: retainScores(data, next) };
  data = next; selected = null; preview = null; needsRefresh = false; render();
  if (connected && !training()) scoreLoader.update();
  if (!training() && boardLesson?.status === 'pending' && !lessonTimer && !teachingBusy) watchLesson(boardLesson);
  if (connected && !training() && next.review && !boardReview) reviewLoader.open(next.game.id, next.review.id);
  if (connected && !training() && next.game.status === 'finished' && next.game.moves.length && reviewAutoKey !== roundKey()) {
    reviewAutoKey = roundKey(); insightTab = 'review';
    if (needsAutomaticReview(next.game, next.review)) reviewLoader.start();
    renderReviewPanel();
  }
}
async function run(action, message = '正在处理…') {
  if (busy) return;
  busy = true; notice(message); render();
  try { await action(); }
  catch (error) { needsRefresh ||= !!error.needsRefresh; notice(error.message, true); }
  finally { await boardMotion.whenIdle(); busy = false; render(); }
}
function mutation() { return { gameId: data.game.id, expectedVersion: data.game.version, requestId: crypto.randomUUID() }; }
function setPhase(next) {
  phase = next;
  if (next === 'saving') notice(training() ? '正在核对你的答案…' : '正在保存你的落子…');
  if (next === 'thinking') notice(training() ? '这步正确，正在摆出对方应手…' : '你的棋已落定，教练正在思考…');
  render();
}
const flow = () => ({ call, onCommit: adopt, onPhase: setPhase, paint: async () => { await boardMotion.whenIdle(); await afterPaint(); } });
function reply() {
  return run(async () => {
    await replyTurn({ ...flow(), snapshot: data, requestId: crypto.randomUUID() });
    notice(training() ? trainingFeedback(data.training) : data.game.status === 'active' ? '教练已应手，轮到你了。想听原因时再点“讲解”。' : '');
  });
}
async function teach(kind, retryLesson = null, reviewOptions = {}) {
  if (!data || training() || setup || teachingBusy || busy || needsRefresh) return;
  const game = data.game;
  if (!retryLesson && kind !== 'review' && hasLesson(kind)) return;
  teachingBusy = true;
  $('lesson-status').textContent = '正在准备讲解…你可以继续走棋，答案会留在这里。'; render();
  const generation = ++lessonWatch; clearTimeout(lessonTimer); lessonTimer = null;
  try {
    const caps = app.getHostCapabilities();
    if (!caps?.message && !caps?.sampling) throw new Error('当前入口不支持请求教练讲解。');
    if (hostView.displayMode === 'inline' && hostView.availableDisplayModes?.includes('fullscreen')) {
      try { await changeDisplayMode('fullscreen'); } catch { /* The inline answer panel is also usable. */ }
    }
    const existing = retryLesson ?? (boardLesson?.status === 'pending' && boardLesson.version === game.version && boardLesson.kind === kind && (kind !== 'review' || boardLesson.reviewId === reviewOptions.reviewId && boardLesson.reviewPly === reviewOptions.ply) ? boardLesson : null);
    const request = existing
      ? await call('read_lesson', { gameId: game.id, requestId: existing.requestId, includeEvidence: true })
      : await call('prepare_lesson', { gameId: game.id, expectedVersion: game.version, requestId: crypto.randomUUID(), kind, ...(kind === 'review' ? reviewOptions : {}) });
    if (generation !== lessonWatch) return;
    if (!sameLessonPosition(request, data?.game) || request.obsolete) { teachingBusy = false; boardLesson = null; throw new Error('这段棋谱已经改变，请重新选择讲解。'); }
    boardLesson = request;
    if (request.status === 'complete') { completeLesson(request); return; }
    if (kind === 'explain' && request.version === data?.game.version) lessonEvidence = { key: roundKey(), value: request.evidence };
    if (kind === 'position' && request.version === data?.game.version) lessonEvidence = { key: roundKey(), value: request.evidence };
    render();
    const delivered = await deliverInlineLesson({ app, lesson: request, call });
    if (generation !== lessonWatch) return;
    if (delivered.lesson) completeLesson(delivered.lesson);
    else {
      $('lesson-status').textContent = '教练正在写讲解，完成后会出现在下方。';
      watchLesson(request);
    }
  } catch (error) {
    if (generation === lessonWatch) { teachingBusy = false; $('lesson-status').textContent = `讲解尚未完成：${error.message}`; }
  } finally {
    if (generation === lessonWatch && !lessonTimer && boardLesson?.status !== 'pending') teachingBusy = false;
    render();
  }
}

function stopLessonWatch() { ++lessonWatch; clearTimeout(lessonTimer); lessonTimer = null; }
function completeLesson(lesson) {
  boardLesson = lesson; teachingBusy = false; stopLessonWatch();
  sentRequests.add(`${lesson.gameId}:${lesson.version}:${lesson.kind}`);
  while (sentRequests.size > 60) sentRequests.delete(sentRequests.values().next().value);
  $('lesson-status').textContent = '讲解已显示在这里。'; render();
}
function watchLesson(lesson) {
  stopLessonWatch(); const generation = lessonWatch, deadline = Date.now() + 180000;
  teachingBusy = true;
  const poll = async () => {
    try {
      const result = await call('read_lesson', { gameId: lesson.gameId, requestId: lesson.requestId });
      if (generation !== lessonWatch) return;
      if (result.obsolete || !sameLessonPosition(result, data?.game)) {
        stopLessonWatch(); teachingBusy = false; boardLesson = null;
        $('lesson-status').textContent = '这一段棋谱已撤回，请重新选择讲解。'; render(); return;
      }
      if (result.status === 'complete') { completeLesson(result); return; }
      boardLesson = result;
    } catch (error) {
      if (generation !== lessonWatch) return;
      $('lesson-status').textContent = `暂未收到讲解：${error.message}`;
    }
    if (generation !== lessonWatch) return;
    if (Date.now() >= deadline) {
      lessonTimer = null; teachingBusy = false;
      $('lesson-status').textContent = '讲解仍未返回。你可以查看进度或重新请求。'; render(); return;
    }
    lessonTimer = setTimeout(poll, 1200);
  };
  lessonTimer = setTimeout(poll, 500); render();
}

function renderScores() {
  if (trainingPanel.visible) return;
  const points = scorePoints(), currentPly = Math.max(0, points.length - 1);
  if (scoreSelection !== null && scoreSelection > currentPly) scoreSelection = null;
  const selected = scoreSelection ?? currentPly, point = points[selected];
  const display = displayedScore(points, { selectedPly: scoreSelection, pending: !!pendingMove });
  const scoreContext = `${data?.game.id ?? 'empty'}:${insightTab}:${scoreSelection === null ? 'live' : selected}`;
  updateScoreLabel($('red-score'), display.point?.red, scoreContext);
  updateScoreLabel($('black-score'), display.point?.black, scoreContext);
  $('score-at').textContent = !data ? '等待开局' : selected === 0 ? '开局' : `第 ${selected} 手${point?.label ? ` · ${point.label}` : ''}`;
  const status = insightTab === 'review' && boardReview ? boardReview.status === 'complete' ? '复盘分析曲线' : '复盘分析进行中…' : scoreStatus;
  $('score-status').textContent = display.stale ? `${status || '正在更新局势分…'} · 暂沿用${display.point.ply ? `第 ${display.point.ply} 手` : '开局'}评分` : status;
  $('score-retry').hidden = !scoreStatus.includes('重试');
  $('score-live').hidden = scoreSelection === null;
  const value = point?.red?.type === 'cp' ? point.red.value : null;
  $('score-verdict').textContent = value === null ? '正分红优，负分黑优；将杀单独显示。' : Math.abs(value) <= 50 ? '局势接近平衡，50分内按小波动看待。' : `${value > 0 ? '红方' : '黑方'}占优。拖动滑块可对照当时的棋盘。`;
  if (sandbox || preview?.line.steps.length && preview.index > 0) $('score-verdict').textContent = '正在自由分析或试走变化；曲线保留原实战记录。';
  $('score-scrubber').max = currentPly; $('score-scrubber').value = selected; $('score-scrubber').disabled = !data;
  drawScoreChart($('score-chart'), points, selected, selectScore);
}

function scorePoints() {
  const points = data?.scores ?? [];
  if (insightTab !== 'review' || !sameReviewPosition(boardReview, data?.game)) return points;
  return points.slice(0, boardReview.total + 1).map((point, index) => ({ ...point, ...boardReview.points?.[index] }));
}
function selectScore(ply) {
  const point = scorePoints()[ply]; if (!point || busy || setup || training()) return;
  scoreSelection = ply; sandbox = null; selected = null;
  preview = { type: 'history', rootFen: point.fen, index: 0, line: { steps: [] }, lastMove: data.game.moves[ply - 1]?.uci, title: ply ? `第 ${ply} 手后的棋盘` : '开局棋盘' };
  render();
}
function renderReviewPanel() {
  $('lesson-tab').setAttribute('aria-selected', String(insightTab === 'lesson'));
  $('review-tab').setAttribute('aria-selected', String(insightTab === 'review'));
  $('lesson-panel').hidden = trainingPanel.visible || insightTab !== 'lesson'; $('review-panel').hidden = trainingPanel.visible || insightTab !== 'review';
  $('review-tab').disabled = training() || !data?.game.moves.length;
  $('review-start').disabled = training() || busy || !data?.game.moves.length || boardReview?.status === 'running';
  $('review-start').textContent = !boardReview ? '开始复盘' : boardReview.status === 'running' ? '正在分析' : boardReview.outdatedMethod ? '更新评分' : boardReview.total < (data?.game.moves.length ?? 0) ? '更新复盘' : boardReview.status === 'complete' ? '已完成' : '继续复盘';
  if (isCompleteCurrentReview(boardReview, data?.game)) $('review-start').disabled = true;
  $('review-status').textContent = reviewStatus;
  $('review-caption').textContent = !boardReview ? recording() ? '摆完后可复盘全部已录着法，无需走到将死。' : '对局结束后自动分析；也可提前复盘已走的棋谱。' : `${boardReview.gameFinished ? '终局复盘' : recording() ? '已录棋谱复盘' : '阶段复盘'} · 截至第 ${boardReview.total} 手 · ${boardReview.outdatedMethod ? '历史评分，可更新口径' : '本局表现，满分100'}`;
  renderReview({ root: document, report: boardReview, selectedPly: reviewRow?.ply, onSelect: selectReviewMove });
  $('review-summary-lesson').disabled = busy || teachingBusy || boardReview?.status !== 'complete';
  $('review-selection').hidden = !reviewRow;
  if (reviewRow) $('review-selection-text').textContent = `第 ${reviewRow.ply} 手 · ${reviewRow.side === 'r' ? '红方' : '黑方'}${reviewRow.chinese} · ${stageNames[reviewRow.stage]}。${reviewRow.quality.grade}${reviewRow.quality.accuracy === null ? '' : ` ${formatMoveScore(reviewRow.quality.accuracy)}分`}。${reviewRow.quality.note} 推荐 ${reviewRow.best.chinese}。`;
  for (const id of ['review-played', 'review-best', 'review-retry', 'review-sandbox', 'review-explain']) $(id).disabled = busy || !reviewRow || id === 'review-explain' && teachingBusy;
}
async function selectReviewMove(ply) {
  if (!boardReview || busy || training()) return;
  const token = ++reviewSelectionToken, report = boardReview;
  try {
    const result = await call('read_review', { gameId: report.gameId, reviewId: report.id, ply });
    if (token !== reviewSelectionToken || boardReview?.id !== report.id || result.obsolete || !sameReviewPosition(result, data?.game)) return;
    boardReview = result; reviewRow = result.selected; sandbox = null; selected = null; scoreSelection = ply - 1;
    preview = { rootFen: reviewRow.beforeFen, index: 0, line: reviewRow.played, title: `第 ${ply} 手之前` };
    notice(`正在复盘第 ${ply} 手，实战棋局已保留。`); render();
  } catch (error) { if (token === reviewSelectionToken) { reviewStatus = error.message; renderReviewPanel(); } }
}
function requestReviewLesson(ply) {
  if (!boardReview || busy || teachingBusy || training()) return;
  insightTab = 'lesson'; renderReviewPanel();
  teach('review', null, { reviewId: boardReview.id, ...(ply ? { ply } : {}) });
}
function completeRequestedReview() {
  if (!pendingReviewLesson || training()) return;
  if (pendingReviewLesson !== roundKey()) { pendingReviewLesson = null; return; }
  if (busy || teachingBusy || setup || !isCompleteCurrentReview(boardReview, data.game)) return;
  const key = pendingReviewLesson;
  pendingReviewLesson = null;
  queueMicrotask(() => { if (key === roundKey()) requestReviewLesson(); });
}
function reviewRecording() {
  if (!data?.game.moves.length || busy || setup || teachingBusy) return;
  pendingReviewLesson = roundKey(); insightTab = 'review'; preview = null; sandbox = null; scoreSelection = null;
  notice('正在复盘已录棋谱，完成后会请求教练讲解。'); render();
  if (!isCompleteCurrentReview(boardReview, data.game)) reviewLoader.start();
}
async function sandboxMoves(moves) {
  const source = sandbox;
  const result = await call('preview_line', { gameId: source.gameId, ply: source.basePly, moves });
  if (sandbox !== source || result.gameId !== data?.game.id) return;
  sandbox = { ...source, moves, position: result.position }; selected = null; render();
}

function renderAnswer() {
  const lesson = sameLessonPosition(boardLesson, data?.game) ? boardLesson : null;
  $('answer-heading').textContent = !lesson ? '教练讲解' : lesson.kind === 'position' ? '当前局面讲解' : lesson.kind === 'review' ? lesson.scope === 'game' ? '本局复盘讲解' : `第 ${lesson.toPly} 手复盘讲解` : lesson.kind === 'hint' ? `第 ${lesson.toPly} 手后的提示` : lesson.fromPly + 1 === lesson.toPly ? `第 ${lesson.toPly} 手讲解` : `第 ${lesson.fromPly + 1}–${lesson.toPly} 手讲解`;
  const text = lesson?.status === 'complete' ? lesson.text : lesson?.status === 'pending' ? '教练正在准备这次回答。完成后会显示在这里，你可以继续走棋。' : '点“讲解”后，答案会显示在这里。可以边看棋盘边读，也可以继续走棋。';
  if (text !== displayedAnswer) {
    // Model text is plain text, never HTML. Long answers scroll in this panel
    // without growing the widget or pushing the board out of view.
    $('lesson-answer').textContent = text; $('lesson-answer').scrollTop = 0; displayedAnswer = text;
  }
  $('lesson-answer').classList.toggle('pending', lesson?.status === 'pending');
  $('lesson-board').hidden = !lesson || lesson.toPly === data?.game.moves.length;
  $('lesson-check').hidden = lesson?.status !== 'pending' || teachingBusy;
  $('lesson-retry').hidden = lesson?.status !== 'pending' || teachingBusy;
}

function updateHostView(changes = {}) {
  hostView = { ...app.getHostContext(), ...hostView, ...changes };
  const context = hostView;
  $('expand').hidden = !context?.availableDisplayModes?.includes('fullscreen');
  $('expand').textContent = context?.displayMode === 'fullscreen' ? '收起棋盘' : '展开棋盘';
  document.documentElement.classList.toggle('expanded', context?.displayMode === 'fullscreen');
}
async function changeDisplayMode(mode) {
  const result = await app.requestDisplayMode({ mode });
  updateHostView({ displayMode: result.mode });
}
function grid() {
  let svg = '<g fill="#cda76a" fill-opacity=".035"><path d="M175 25H275V125H175Z M175 375H275V475H175Z"/></g><g stroke="var(--grid)" stroke-width="1.1" fill="none">';
  for (let y = 0; y < 10; y++) svg += `<path d="M25 ${25 + y * 50}H425"/>`;
  for (let x = 0; x < 9; x++) {
    const at = 25 + x * 50;
    svg += x === 0 || x === 8 ? `<path d="M${at} 25V475"/>` : `<path d="M${at} 25V225 M${at} 275V475"/>`;
  }
  svg += '<path d="M175 25L275 125 M275 25L175 125 M175 375L275 475 M275 375L175 475"/></g>';
  svg += '<g stroke="var(--grid)" stroke-width=".9" fill="none" opacity=".8">';
  for (const [x, y] of [[75,125],[375,125],[75,375],[375,375], ...[25,125,225,325,425].flatMap(x => [[x,175],[x,325]])]) {
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
      if (x + dx * 10 < 25 || x + dx * 10 > 425) continue;
      svg += `<path d="M${x + dx * 10} ${y + dy * 4}H${x + dx * 4}V${y + dy * 10}"/>`;
    }
  }
  svg += '</g><g class="river-label" fill="#e6d6ad" font-size="20" font-family="Songti SC,serif" text-anchor="middle" letter-spacing="8"><text x="128" y="257">楚河</text><text x="328" y="257">汉界</text></g>';
  $('grid').innerHTML = svg;
}
function createPiece(piece) {
  const span = document.createElement('span');
  span.className = 'piece' + (piece[0] === 'r' ? ' red' : '');
  const glyph = document.createElement('span'); glyph.className = 'piece-glyph'; glyph.textContent = names[piece]; span.append(glyph);
  return span;
}
function renderBoard() {
  const position = setup ?? sandbox?.position ?? pendingMove?.position ?? (preview ? { pieces: piecesFromFen(preview.index === 0 ? preview.rootFen : preview.line.steps[preview.index - 1].fen), legalMoves: [] } : data?.position ?? { pieces: piecesFromFen(startFen), legalMoves: [] });
  const selection = setup ? setup.selected : selected;
  const allowed = new Set((position.legalMoves ?? []).filter(move => move.from === selection).map(move => move.to));
  const last = setup ? null : sandbox ? sandbox.moves.at(-1) : pendingMove?.move.uci ?? (preview ? preview.index ? preview.line.steps[preview.index - 1]?.uci : preview.lastMove : data?.game.moves.at(-1)?.uci);
  const context = `${data?.game.id ?? 'empty'}:${setup ? 'setup' : sandbox ? `sandbox:${sandbox.rootFen}` : preview ? preview.type === 'history' ? 'history' : `preview:${preview.rootFen}` : 'live'}`;
  const active = connected && !busy && !needsRefresh && (setup ? true : sandbox ? !sandbox.position.terminal : !preview && data?.game.status === 'active' && (recording() || data.position.turn === data.game.playerSide));
  boardSquares.update({ pieces: position.pieces, flipped, active, selected: selection, allowed, last });
  boardMotion.update({ pieces: position.pieces, context, flipped });
  if (boardMotion.active) for (const square of $('squares').children) square.disabled = true;
}
async function clickSquare(square) {
  if (boardMotion.active) return;
  if (setup && !busy) { setup.click(square); notice('摆好后点“分析讲解”，或保存后继续录谱。'); render(); return; }
  if (!data || busy || needsRefresh || preview && !sandbox) return;
  const position = sandbox?.position ?? data.position;
  const chosen = position.legalMoves.find(move => move.from === selected && move.to === square);
  if (chosen) {
    if (sandbox) {
      if (sandbox.moves.length >= 12) { notice('这一段已试走12手，可以悔一步或回到起点换一种走法。'); return; }
      await run(() => sandboxMoves([...sandbox.moves, chosen.uci]), '正在校验分析着法…');
      notice('只在分析棋盘试走，原棋局已保留。'); return;
    }
    const snapshot = data;
    selected = null;
    await run(async () => {
      const next = await playTurn({ ...flow(), snapshot, move: chosen,
        requestId: crypto.randomUUID(), replyRequestId: crypto.randomUUID(),
        onPreview: value => { pendingMove = value; render(); },
      });
      notice(isTraining(next) ? trainingFeedback(next.training) : next.game.status !== 'active' ? '' : recording() ? `已保存，继续录入${next.position.turn === 'r' ? '红方' : '黑方'}的着法；摆完后点“复盘讲解”。` : next.position.turn === next.game.playerSide
        ? '教练已应手，轮到你了。想听原因时再点“讲解”。' : '你的棋已保存，点击“请教练应手”继续。');
    });
    return;
  }
  selected = position.pieces[square]?.[0] === (sandbox || recording() ? position.turn : data.game.playerSide) && selected !== square ? square : null;
  notice(selected ? '选择亮起的落点，青色光点表示合法走法。' : ''); renderBoard();
}
function render() {
  const game = data?.game;
  trainingPanel.update(data, { busy, connected, hasReturn: !!trainingReturnId });
  document.documentElement.classList.toggle('has-game', !!game);
  document.documentElement.classList.toggle('setting-up', !!setup);
  document.documentElement.classList.toggle('training-game', training());
  $('training-open').disabled = busy || !connected || !!setup;
  $('training-open').setAttribute('aria-expanded', String(trainingPanel.visible));
  $('score-panel').hidden = trainingPanel.visible;
  $('insight-tabs').hidden = trainingPanel.visible;
  const coachTurn = !recording() && game?.status === 'active' && data.position.turn !== game.playerSide;
  for (const id of ['new', 'free']) $(id).disabled = busy || !connected || !!setup;
  for (const id of ['refresh', 'export']) $(id).disabled = busy || !game;
  $('recent').disabled = busy;
  $('undo').hidden = training();
  $('undo').disabled = training() || busy || needsRefresh || !!sandbox || !!preview || !game?.moves.length;
  $('explain').disabled = training() || busy || needsRefresh || !!sandbox || !!preview || teachingBusy || coachTurn || !game?.moves.length || hasLesson('explain');
  $('hint').disabled = training() || busy || needsRefresh || !!sandbox || !!preview || teachingBusy || !game || game.status !== 'active' || hasLesson('hint');
  $('hint').hidden = training() || !recording() && !!game && data.position.turn !== game.playerSide;
  $('saved').textContent = needsRefresh ? '请刷新确认' : pendingMove ? '正在保存…' : game ? '已自动保存' : '';
  $('turn').textContent = preview ? '正在试走变例' : !game ? '红方先行' : training() ? data.training.status === 'active' ? `${game.playerSide === 'r' ? '红方' : '黑方'}解题 · ${coachTurn ? '等待对方应手' : '请走出答案'}` : trainingStatusLabel(data.training.status) : game.status === 'finished' ? game.result?.winner ? `${game.result.winner === 'r' ? '红方' : '黑方'}获胜 · ${game.result.reason === 'checkmate' ? '将死' : '困毙'}` : '棋局已结束' : game.status === 'review_required' ? '重复局面 · 暂停待裁定' : data.position.turn === game.playerSide ? `轮到你走 · ${game.playerSide === 'r' ? '红方' : '黑方'}${data.position.inCheck ? '（被将军）' : ''}` : '轮到教练走';
  if (phase) $('turn').textContent = training() ? phase === 'saving' ? '正在核对答案…' : '正在摆出对方应手…' : phase === 'saving' ? '你的棋已落下 · 正在保存' : '教练正在思考…';
  $('turn').classList.toggle('thinking', phase === 'thinking');
  if (sandbox) $('turn').textContent = sandbox.position.terminal ? '分析局面已结束' : `自由分析 · ${sandbox.position.turn === 'r' ? '红方' : '黑方'}走棋`;
  else if (preview?.title) $('turn').textContent = preview.title;
  else if (recording() && game.status === 'active' && !phase) $('turn').textContent = `自由录谱 · ${data.position.turn === 'r' ? '红方' : '黑方'}走棋${data.position.inCheck ? '（被将军）' : ''}`;
  if (setup) { $('turn').textContent = '摆设局面 · 选择棋子与位置'; $('saved').textContent = '草稿未保存'; }
  $('lesson-title').textContent = game?.moves.length ? '看着棋盘，听教练讲' : '先走一步试试';
  const lesson = lessonEvidence?.key === roundKey() ? lessonEvidence.value.lesson : game?.lastLesson;
  const user = lesson?.recordedMove ?? lesson?.userMove, engine = lesson?.engineMove;
  const recent = game?.moves.slice(-2) ?? [];
  $('lesson-copy').textContent = game?.status === 'review_required' ? game.result.message : recent.length
    ? recent.map(move => `${recording() ? move.side === 'r' ? '红方' : '黑方' : move.side === game.playerSide ? '你' : '教练'}走了${move.chinese}`).join('，') + '。点讲解后在下方阅读。'
    : recording() ? '红黑双方都由你录入。可以直接分析当前局面，也可以摆完棋谱后复盘讲解。' : '点击棋子，再选择落点。你的棋先落定，教练随后应手；需要讲解时点下面的按钮。';
  $('explain').textContent = hasLesson('explain') ? '讲解已显示' : recording() ? '讲解刚才这一手' : coachTurn ? '应手后可讲解' : '讲解这一回合';
  $('undo').textContent = recording() ? '悔一步' : '悔棋';
  $('reply').hidden = !coachTurn || !!sandbox || !!preview;
  $('reply').disabled = busy || needsRefresh;
  $('reply').textContent = training() ? '继续对方应手' : phase === 'thinking' ? '正在思考…' : game?.autoReply ? '继续应手' : '请教练应手';
  choices = [];
  if (user?.played?.steps?.length) choices.push({ title: `${recording() ? '录谱实走' : '我的走法'} · ${user.played.chinese}`, rootFen: user.rootFen, line: user.played });
  if (user?.best?.steps?.length) choices.push({ title: `建议走法 · ${user.best.chinese}`, rootFen: user.rootFen, line: user.best });
  const engineLine = engine?.played ?? engine?.best;
  if (engineLine?.steps?.length) choices.push({ title: `教练应手 · ${engineLine.chinese}`, rootFen: engine.rootFen, line: engineLine });
  const positionAnalysis = lessonEvidence?.key === roundKey() ? lessonEvidence.value.analysis : null;
  if (positionAnalysis?.candidates) choices = positionAnalysis.candidates.filter(line => line.steps?.length).map(line => ({ title: `局面建议 · ${line.chinese}`, rootFen: positionAnalysis.rootFen, line }));
  if (reviewRow && (insightTab === 'review' || boardLesson?.kind === 'review')) choices = [{ title: `实走 · ${reviewRow.chinese}`, rootFen: reviewRow.beforeFen, line: reviewRow.played }, { title: `推荐 · ${reviewRow.best.chinese}`, rootFen: reviewRow.beforeFen, line: reviewRow.best }];
  const chosenIndex = $('variation').selectedIndex;
  $('variation').replaceChildren(...choices.map((choice, index) => { const option = document.createElement('option'); option.value = index; option.textContent = choice.title; return option; }));
  $('variation').selectedIndex = Math.max(0, Math.min(choices.length - 1, chosenIndex));
  $('variations').hidden = training() || !choices.length;
  $('demonstrate').disabled = busy;
  $('history').replaceChildren();
  let row;
  for (const move of game?.moves ?? []) {
    if (move.side === 'r' || !row) {
      row = document.createElement('li');
      for (const text of [String($('history').children.length + 1), '', '']) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
      row.children[1].className = 'red-text'; $('history').append(row);
    }
    row.children[move.side === 'r' ? 1 : 2].textContent = move.chinese;
  }
  $('history').scrollTop = $('history').scrollHeight;
  $('move-count').textContent = `${game?.moves.length ?? 0} 手`;
  $('empty-record').hidden = !!game?.moves.length;
  $('preview-controls').hidden = !preview;
  if (preview) {
    $('preview-step').textContent = preview.index === 0 ? preview.line.steps.length ? '变例起点' : preview.title : `${preview.index}/${preview.line.steps.length} · ${preview.line.steps[preview.index - 1].chinese}`;
    $('prev').disabled = preview.index === 0; $('next').disabled = preview.index === preview.line.steps.length;
  }
  $('sandbox-controls').hidden = !sandbox;
  if (sandbox) { $('sandbox-step').textContent = `自由试走 ${sandbox.moves.length} 手`; $('sandbox-undo').disabled = busy || !sandbox.moves.length; $('sandbox-reset').disabled = busy || !sandbox.moves.length; $('sandbox-exit').disabled = busy; }
  $('return-original').hidden = !game?.trainingOrigin; $('return-original').disabled = busy;
  $('record-controls').hidden = !recording() || !!setup;
  $('record-review').disabled = busy || needsRefresh || teachingBusy || !game?.moves.length || boardReview?.status === 'running';
  $('position-explain').disabled = training() || busy || needsRefresh || teachingBusy || !!preview || !!sandbox || hasLesson('position');
  $('live').textContent = training() ? '回到练习' : recording() ? '回到录谱' : '回到实战';
  renderSetup();
  renderBoard(); renderScores(); renderAnswer(); renderReviewPanel(); updateHostView();
  completeRequestedReview();
}

function startTraining(options) {
  return run(async () => {
    const next = await call('start_training', { requestId: crypto.randomUUID(), ...options });
    setup = null; adopt(next);
    notice(trainingFeedback(next.training) || '训练已开始，在棋盘走出你的答案。');
  }, '正在准备训练题…');
}
function trainingAction(action) {
  if (!training()) return;
  return run(async () => {
    adopt(await call('training_action', { ...mutation(), action }));
    notice(trainingFeedback(data.training));
  }, action === 'next' ? '正在准备下一题…' : action === 'retry' ? '正在重新摆题…' : '正在读取训练提示…');
}
function returnFromTraining() {
  if (!trainingReturnId) { $('recent').click(); return; }
  const gameId = trainingReturnId;
  return run(async () => {
    adopt(await call('read_game', { gameId }));
    notice('已返回原棋局，训练记录已保存。');
  });
}
async function syncTrainingExpiry(gameId) {
  if (!training() || data.game.id !== gameId) return true;
  if (busy) return false;
  await run(async () => {
    adopt(await call('read_game', { gameId }));
    notice(trainingFeedback(data.training));
  }, '时间到，正在确认挑战结果…');
  return true;
}

function renderSetup() {
  $('setup-controls').hidden = !setup; $('setup-actions').hidden = !setup;
  if (!setup) return;
  $('setup-turn').value = setup.turn; $('setup-turn').disabled = busy;
  $('setup-palette').replaceChildren(...Object.entries(names).map(([piece, name]) => {
    const button = document.createElement('button'); button.textContent = name; button.className = piece[0] === 'r' ? 'red-text' : '';
    button.setAttribute('aria-label', `放置${piece[0] === 'r' ? '红方' : '黑方'}${name}`);
    button.setAttribute('aria-pressed', String(setup.tool === piece)); button.disabled = busy;
    button.onclick = () => { setup.choose(piece); render(); }; return button;
  }));
  for (const id of ['setup-move', 'setup-erase', 'setup-clear', 'setup-standard', 'setup-analyze', 'setup-save', 'setup-cancel']) $(id).disabled = busy;
  $('setup-move').setAttribute('aria-pressed', String(setup.tool === 'move'));
  $('setup-erase').setAttribute('aria-pressed', String(setup.tool === 'erase'));
  $('setup-undo').disabled = busy || !setup.history.length; $('setup-current').disabled = busy || !data;
}
function startSetup() {
  setup = new SetupDraft(); pendingReviewLesson = null; preview = null; sandbox = null; selected = null; needsRefresh = false;
  notice('在这里自由摆子，原棋谱已保留。完成后会另存为一盘新棋。'); render();
}
async function saveSetup(explain) {
  if (!setup || busy) return;
  const fen = setup.fen; let accepted = null;
  await run(async () => {
    const next = await call('new_game', { requestId: crypto.randomUUID(), mode: 'record', autoReply: false, fen });
    setup = null; adopt(next); accepted = next;
    notice('局面已通过规则检查并保存，可以分析讲解或继续录谱。');
  }, '正在检查将帅、棋子位置和行棋方…');
  if (accepted && explain) { insightTab = 'lesson'; await teach('position'); }
}

$('expand').onclick = async () => {
  try { await changeDisplayMode(hostView.displayMode === 'fullscreen' ? 'inline' : 'fullscreen'); }
  catch { notice('当前入口暂时无法展开，仍可在棋盘旁阅读讲解。', true); }
};
$('score-live').onclick = () => { scoreSelection = null; preview = null; sandbox = null; render(); };
$('score-scrubber').oninput = event => selectScore(Number(event.target.value));
$('score-retry').onclick = () => scoreLoader.retry();
$('lesson-check').onclick = async () => {
  if (!boardLesson) return;
  const request = boardLesson;
  try {
    const result = await call('read_lesson', { gameId: request.gameId, requestId: request.requestId });
    if (boardLesson?.requestId !== request.requestId) return;
    if (result.obsolete) { boardLesson = null; stopLessonWatch(); teachingBusy = false; render(); return; }
    if (result.status === 'complete') completeLesson(result); else watchLesson(result);
  } catch (error) { $('lesson-status').textContent = error.message; }
};
$('lesson-retry').onclick = () => { if (boardLesson) teach(boardLesson.kind, boardLesson); };
$('lesson-board').onclick = () => {
  if (!sameLessonPosition(boardLesson, data?.game) || busy) return;
  preview = { rootFen: boardLesson.rootFen, index: 0, line: { steps: [] }, title: `第 ${boardLesson.toPly} 手后的棋盘` };
  selected = null; notice(`正在对照第 ${boardLesson.toPly} 手后的讲解，实战棋局已保留。`); render();
};
window.addEventListener('pagehide', () => { stopLessonWatch(); reviewLoader.stop(); trainingPanel.stop(); boardMotion.cancel(); });

function renderEffectsSetting() {
  const reduced = !!motionPreference?.matches;
  document.documentElement.dataset.effects = effectsEnabled && !reduced ? 'on' : 'off';
  $('effects-toggle').setAttribute('aria-pressed', String(effectsEnabled && !reduced));
  $('effects-toggle').textContent = reduced ? '特效 · 静态' : effectsEnabled ? '特效 · 极炫' : '特效 · 关';
  $('effects-toggle').disabled = reduced;
  $('effects-toggle').title = reduced ? '已遵循系统的减少动态效果设置' : '切换旋转阵纹、能量拖尾、冲击波与吃子爆发';
}
$('effects-toggle').onclick = () => {
  effectsEnabled = !effectsEnabled;
  try { localStorage.setItem('xiangqi-star-river-effects', effectsEnabled ? 'on' : 'off'); } catch {}
  boardEffects.clear(); renderEffectsSetting();
};
motionPreference?.addEventListener('change', () => { boardMotion.cancel(); renderEffectsSetting(); renderBoard(); });
renderEffectsSetting();
app.onhostcontextchanged = updateHostView;

$('lesson-tab').onclick = () => { insightTab = 'lesson'; render(); };
$('review-tab').onclick = () => {
  if (training()) return;
  insightTab = 'review'; render();
  if (!boardReview && data?.game.moves.length) reviewLoader.start();
};
$('review-start').onclick = () => { if (training()) return; reviewRow = null; reviewLoader.start(); };
$('review-played').onclick = () => { if (reviewRow) { sandbox = null; preview = { rootFen: reviewRow.beforeFen, index: 0, line: reviewRow.played }; render(); } };
$('review-best').onclick = () => { if (reviewRow) { sandbox = null; preview = { rootFen: reviewRow.beforeFen, index: 0, line: reviewRow.best }; render(); } };
$('review-explain').onclick = () => requestReviewLesson(reviewRow?.ply);
$('review-summary-lesson').onclick = () => requestReviewLesson();
$('review-retry').onclick = () => {
  if (!boardReview || !reviewRow) return;
  const args = { gameId: boardReview.gameId, reviewId: boardReview.id, ply: reviewRow.ply, requestId: crypto.randomUUID() };
  run(async () => { adopt(await call('retry_review_move', args)); notice('已从这一手之前开始独立练习。原局复盘已保留，可以随时返回。'); });
};
$('review-sandbox').onclick = () => {
  if (!boardReview || !reviewRow) return;
  const source = { gameId: data.game.id, basePly: reviewRow.ply - 1, rootFen: reviewRow.beforeFen, moves: [reviewRow.uci] };
  run(async () => {
    const result = await call('preview_line', { gameId: source.gameId, ply: source.basePly, moves: source.moves });
    sandbox = { ...source, position: result.position }; preview = null; selected = null;
    notice('已带入这手棋之后的局面；分析悔一步可看前一局面。双方都可自由试走，原局不受影响。');
  });
};
$('sandbox-undo').onclick = () => run(() => sandboxMoves(sandbox.moves.slice(0, -1)));
$('sandbox-reset').onclick = () => run(() => sandboxMoves([]));
$('sandbox-exit').onclick = () => run(async () => { sandbox = null; preview = null; adopt(await call('read_game', { gameId: data.game.id })); notice('已结束分析，回到原棋局。'); });
$('return-original').onclick = () => {
  const origin = data?.game.trainingOrigin; if (!origin) return;
  run(async () => { adopt(await call('read_game', { gameId: origin.gameId })); insightTab = 'review'; await reviewLoader.open(origin.gameId, origin.reviewId); notice('已回原局复盘，练习局也已保存。'); });
};

function showNewDialog(mode) {
  $('game-mode').value = mode; updateNewDialog(); $('new-dialog').returnValue = ''; $('new-dialog').showModal();
}
function updateNewDialog() {
  const mode = $('game-mode').value;
  $('play-options').hidden = mode !== 'play';
  $('mode-description').textContent = mode === 'setup' ? '添加、移动、删除棋子，选择哪方先走。原棋谱保留，完成后另存。' : mode === 'record' ? '从标准开局录入红黑双方着法。摆完后，一键复盘讲解。' : '与你的象棋教练对弈，想听原因时再点讲解。';
  $('start').textContent = mode === 'setup' ? '开始摆子' : mode === 'record' ? '开始录谱' : '开始对弈';
}
$('new').onclick = () => showNewDialog('play');
$('free').onclick = () => showNewDialog('record');
$('training-open').onclick = () => trainingPanel.open();
$('game-mode').onchange = updateNewDialog;
$('start').onclick = () => $('new-dialog').close('start');
$('cancel').onclick = () => $('new-dialog').close('cancel');
$('new-dialog').onclose = () => {
  if ($('new-dialog').returnValue !== 'start') return;
  const mode = $('game-mode').value;
  if (mode === 'setup') { startSetup(); return; }
  const args = { requestId: crypto.randomUUID(), mode, playerSide: mode === 'record' ? 'r' : $('side').value, autoReply: mode === 'play' && $('automatic').checked };
  run(async () => { adopt(await call('new_game', args)); notice(mode === 'record' ? '自由录谱已开始，红黑双方都由你走。摆完后点“复盘讲解”。' : '新局已开始。选择棋子，再选择落点；想听原因时点“讲解”。'); }, '正在摆好棋盘…');
};
$('setup-turn').onchange = () => { setup.setTurn($('setup-turn').value); render(); };
$('setup-move').onclick = () => { setup.choose('move'); render(); };
$('setup-erase').onclick = () => { setup.choose('erase'); render(); };
$('setup-undo').onclick = () => { setup.undo(); render(); };
$('setup-clear').onclick = () => { setup.replace('9/9/9/9/9/9/9/9/9/9 ' + setup.turn); render(); };
$('setup-standard').onclick = () => { setup.replace(startFen); render(); };
$('setup-current').onclick = () => { if (data) { setup.replace(data.game.fen); render(); } };
$('setup-cancel').onclick = () => { setup = null; notice('已取消摆设，原棋谱保留。'); render(); };
$('setup-save').onclick = () => saveSetup(false);
$('setup-analyze').onclick = () => saveSetup(true);
$('record-review').onclick = reviewRecording;
$('position-explain').onclick = () => { insightTab = 'lesson'; teach('position'); };
$('flip').onclick = () => { flipped = !flipped; renderBoard(); };
$('refresh').onclick = () => run(async () => { adopt(await call('read_game', { gameId: data.game.id })); if (!training()) scoreLoader.retry(); notice(training() ? trainingFeedback(data.training) : '已更新到最新棋局。'); });
$('undo').onclick = () => {
  if (training()) return;
  // If the coach has not replied, undo just the player's pending half-round.
  const args = { ...mutation(), plies: recording() || data.game.moves.at(-1)?.side === data.game.playerSide ? 1 : 2 };
  run(async () => { adopt(await call('undo_move', args)); notice('已撤回，可以换一种走法。'); });
};
$('hint').onclick = () => teach('hint');
$('explain').onclick = () => teach('explain');
$('reply').onclick = reply;
$('demonstrate').onclick = () => { const chosen = choices[Number($('variation').value)]; if (chosen) { preview = { ...chosen, index: 0 }; selected = null; notice('正在试走：实战棋局已保留。用“下一步”看具体后果。'); render(); } };
$('prev').onclick = () => { preview.index--; render(); };
$('next').onclick = () => { preview.index++; render(); };
$('live').onclick = () => { preview = null; scoreSelection = null; notice(training() ? '已回到训练棋盘。' : '已回到实战棋局。'); render(); };
$('recent').onclick = () => run(async () => {
  const { games } = await call('list_games'); $('games').hidden = false;
  $('games').replaceChildren(...games.map(game => {
    const button = document.createElement('button'); button.textContent = `${new Date(game.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${game.mode === 'training' ? '残局训练' : game.mode === 'record' ? '自由录谱' : game.playerSide === 'r' ? '执红' : '执黑'} · ${game.plies} 手`;
    button.onclick = () => run(async () => { adopt(await call('read_game', { gameId: game.id })); $('games').hidden = true; notice('棋局已恢复。'); }); return button;
  })); notice(games.length ? '选择一盘继续。' : '还没有保存的棋局。');
});
$('export').onclick = () => run(async () => {
  const result = await call('export_game', { gameId: data.game.id });
  if (app.getHostCapabilities()?.downloadFile) {
    const saved = await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${result.filename}`, mimeType: 'application/x-chess-pgn', text: result.pgn } }] });
    notice(saved.isError ? '下载已取消，棋局仍已自动保存。' : '已向对话应用提交棋谱下载。');
  } else {
    if (!app.getHostCapabilities()?.message) throw new Error('当前入口不支持下载；可以在对话里说“导出棋谱”。');
    const sent = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `请把以下棋谱作为 PGN 文件提供给我：\n${result.pgn}` }] });
    if (sent.isError) throw new Error('棋谱请求未发送，请重试。');
    notice('棋谱已发送到对话。');
  }
});
app.ontoolresult = result => {
  try {
    const next = unpack(result);
    // A repeated host render must not replace an in-flight move or switch games.
    if (busy && next.game && (next.game.id !== data?.game.id || next.game.version <= data.game.version)) return;
    adopt(next); if (!busy) notice('');
  } catch (error) { notice(error.message, true); }
};
grid(); render();
app.connect(undefined, { timeout: 15000 }).then(() => { connected = true; if (data) adopt(data); else render(); if (!training()) scoreLoader.update(); notice('棋盘已连接。'); }).catch(error => { notice(`棋盘连接未完成：${error.message}。请在支持交互棋盘的对话中打开。`, true); });
