const boundPrefix = { lowerbound: '≥', upperbound: '≤', exact: '' };
export function scoreLabel(score) {
  if (!score) return '—';
  if (score.type === 'result') return score.value > 0 ? '胜' : '负';
  if (score.type === 'mate') return `${boundPrefix[score.bound] ?? ''}${score.value >= 0 ? '将杀' : '被将杀'} ${Math.abs(score.value)}`;
  if (score.type !== 'cp' || !Number.isFinite(score.value)) return '—';
  return `${boundPrefix[score.bound] ?? ''}${score.value > 0 ? '+' : ''}${Math.round(score.value)}`;
}

// A save response can predate a score response. Keep only scores whose complete
// history prefix still belongs to this game, including after undo or branching.
export function retainScores(previous, next) {
  const points = next.scores ?? [];
  if (!previous?.game || previous.game.id !== next.game.id || previous.game.initialFen !== next.game.initialFen) return points;
  let sharedPly = 0;
  const oldMoves = previous.game.moves, moves = next.game.moves;
  while (sharedPly < Math.min(oldMoves.length, moves.length) && oldMoves[sharedPly].uci === moves[sharedPly].uci) sharedPly++;
  return points.map(point => {
    const cached = previous.scores?.[point.ply];
    return !point.red && cached?.red && point.ply <= sharedPly && cached.fen === point.fen
      ? { ...point, ...cached } : point;
  });
}

export function displayedScore(points, { selectedPly = null, pending = false } = {}) {
  const ply = selectedPly ?? Math.max(0, points.length - 1), current = points[ply];
  // History selection must show that exact position, never another turn's score.
  if (selectedPly !== null) return { point: current, stale: false };
  const point = current?.red ? current : points.slice(0, ply).findLast(point => point?.red);
  return { point, stale: !!point?.red && (pending || point !== current) };
}

const scoreLabels = new WeakMap();
export function updateScoreLabel(element, score, context, reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
  const text = scoreLabel(score), previous = scoreLabels.get(element);
  if (previous?.text === text && previous.context === context) return;
  previous?.animation?.cancel();
  if (element.textContent !== text) element.textContent = text;
  // Cross-fade the actual result; do not invent intermediate engine scores.
  const animation = previous?.context === context && previous.text !== '—' && text !== '—' && !reducedMotion
    ? element.animate?.([{ opacity: .65, transform: 'translateY(2px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, easing: 'ease-out' }) : null;
  scoreLabels.set(element, { text, context, animation });
}
export function chartGeometry(points, { width = 440, height = 110, limit } = {}) {
  const measured = points.filter(point => point?.red?.type === 'cp').map(point => Math.abs(point.red.value));
  limit ??= Math.max(200, Math.min(5000, Math.ceil(Math.max(0, ...measured) / 100) * 100));
  const left = 42, right = width - 9, top = 12, bottom = height - 23;
  const last = Math.max(1, points.length - 1);
  const x = ply => left + ply / last * (right - left);
  const value = score => !score ? null : score.type === 'cp' ? score.value : score.value >= 0 ? limit : -limit;
  const clamp = value => Math.max(-limit, Math.min(limit, value));
  const y = value => top + (limit - clamp(value)) / (limit * 2) * (bottom - top);
  const lines = { red: '', black: '' };
  const add = (side, a, b) => { lines[side] += `M${a.x.toFixed(2)},${a.y.toFixed(2)} L${b.x.toFixed(2)},${b.y.toFixed(2)} `; };
  let previous = null;
  const dots = [];
  for (const point of points) {
    if (!point?.red) { previous = null; continue; }
    const raw = value(point.red), current = { ply: point.ply, value: raw, x: x(point.ply), y: y(raw), capped: point.red.type !== 'cp' || Math.abs(raw) > limit };
    dots.push(current);
    if (previous) {
      if (previous.value * raw < 0) {
        const ratio = Math.abs(clamp(previous.value)) / (Math.abs(clamp(previous.value)) + Math.abs(clamp(raw)));
        const zero = { x: previous.x + ratio * (current.x - previous.x), y: y(0) };
        add(previous.value > 0 ? 'red' : 'black', previous, zero);
        add(raw > 0 ? 'red' : 'black', zero, current);
      } else add((raw || previous.value) >= 0 ? 'red' : 'black', previous, current);
    }
    previous = current;
  }
  return { width, height, left, right, top, bottom, middle: y(0), noiseTop: y(50), noiseBottom: y(-50), limit, lines, dots };
}
const scoreCharts = new WeakMap();
export function drawScoreChart(svg, points, selectedPly, onSelect) {
  // Do not compress the existing curve for an as-yet unmeasured move.
  const lastMeasured = points.findLastIndex(point => point?.red);
  const geometry = chartGeometry(points.slice(0, Math.max(1, lastMeasured + 1))), ns = 'http://www.w3.org/2000/svg';
  let chart = scoreCharts.get(svg);
  if (!chart) { chart = { nodes: new Map() }; scoreCharts.set(svg, chart); }
  chart.onSelect = onSelect;
  const seen = new Set();
  const make = (key, tag, attributes, text, parent = svg) => {
    seen.add(key);
    let element = chart.nodes.get(key);
    if (!element) {
      element = svg.ownerDocument.createElementNS(ns, tag);
      chart.nodes.set(key, element); parent.append(element);
    }
    for (const [name, value] of Object.entries(attributes)) if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value));
    if (text !== undefined && element.textContent !== text) element.textContent = text;
    return element;
  };
  svg.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`);
  make('noise', 'rect', { x: geometry.left, y: geometry.noiseTop, width: geometry.right - geometry.left, height: geometry.noiseBottom - geometry.noiseTop, class: 'score-noise' });
  for (const [y, label] of [[geometry.top, `+${geometry.limit}`], [geometry.middle, '0'], [geometry.bottom, `−${geometry.limit}`]]) {
    const key = label === '0' ? 'zero' : label[0] === '+' ? 'top' : 'bottom';
    make(`grid-${key}`, 'line', { x1: geometry.left, x2: geometry.right, y1: y, y2: y, class: label === '0' ? 'score-zero' : 'score-grid' });
    make(`label-${key}`, 'text', { x: geometry.left - 5, y: y + 4, 'text-anchor': 'end', class: 'chart-label' }, label);
  }
  for (const side of ['red', 'black']) make(`line-${side}`, 'path', { d: geometry.lines[side], class: `score-line ${side}`, fill: 'none' });
  for (const dot of geometry.dots) {
    const point = points[dot.ply];
    const key = `dot-${dot.ply}`;
    const group = make(key, 'g', { class: `score-dot ${dot.value < 0 ? 'black' : 'red'}`, role: 'button', tabindex: '0', 'aria-label': `${point.ply ? `第${point.ply}手 ${point.label ?? ''}` : '开局'}，局面分${scoreLabel(point.red)}` });
    make(`${key}-hit`, 'circle', { cx: dot.x, cy: dot.y, r: 8, fill: 'transparent' }, undefined, group);
    make(`${key}-point`, 'circle', { cx: dot.x, cy: dot.y, r: dot.ply === selectedPly ? 4.5 : 2.6, class: dot.capped ? 'capped' : 'point' }, undefined, group);
    make(`${key}-title`, 'title', {}, `${point.ply ? `第 ${point.ply} 手 · ${point.label ?? ''}` : '开局'}  局面分 ${scoreLabel(point.red)}`, group);
    group.onclick = () => chart.onSelect(dot.ply);
    group.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chart.onSelect(dot.ply); } };
  }
  make('start', 'text', { x: geometry.left, y: geometry.height - 3, class: 'chart-label' }, '开局');
  if (lastMeasured > 0) make('end', 'text', { x: geometry.right, y: geometry.height - 3, 'text-anchor': 'end', class: 'chart-label' }, `第 ${lastMeasured} 手`);
  for (const [key, element] of chart.nodes) if (!seen.has(key)) { element.remove(); chart.nodes.delete(key); }
}

// One short evaluation at a time; when the board advances, its newest position
// takes priority over backfilling missing historical points.
export class ScoreLoader {
  constructor({ call, getSnapshot, onPoint, onStatus }) { Object.assign(this, { call, getSnapshot, onPoint, onStatus }); this.running = false; this.failed = new Set(); }
  retry() { this.failed.clear(); return this.update(); }
  async update() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const snapshot = this.getSnapshot();
        if (!snapshot?.game) return;
        const key = `${snapshot.game.id}:${snapshot.game.version}`;
        if (this.failed.has(key)) return;
        const point = [...(snapshot.scores ?? [])].reverse().find(point => !point.red);
        if (!point) { this.onStatus(''); return; }
        this.onStatus(point.ply === snapshot.game.moves.length ? '正在更新局势分…' : '正在补齐前面的评分…');
        try {
          const result = await this.call('evaluate_position', { gameId: snapshot.game.id, expectedVersion: snapshot.game.version, ply: point.ply });
          const current = this.getSnapshot();
          if (current?.game.id === result.gameId && current.game.version === result.version && current.scores?.[point.ply]?.fen === result.point.fen) this.onPoint(result.point);
        } catch {
          const current = this.getSnapshot();
          if (`${current?.game.id}:${current?.game.version}` !== key) continue;
          this.failed.add(key);
          while (this.failed.size > 20) this.failed.delete(this.failed.values().next().value);
          this.onStatus('评分暂未完成，可以重试。'); return;
        }
      }
    } finally { this.running = false; }
  }
}
