// Effects follow the real 380 ms move; impact bursts can overlap the next turn
// without blocking it. Board switches, cancellation and reduced motion clear all.
const NS = 'http://www.w3.org/2000/svg';
const point = cell => ({ x: 25 + cell.column * 50, y: 25 + cell.row * 50 });
const palette = piece => piece[0] === 'r'
  ? { color: '#ffad57', hot: '#fff0be', halo: 'star-river-fire' }
  : { color: '#59e4ff', hot: '#dfffff', halo: 'star-river-ice' };
const glide = 'cubic-bezier(.4, 0, .2, 1)';
const burst = 'cubic-bezier(.08, .5, .18, 1)';

export class BoardEffects {
  constructor({ board, enabled = () => true,
    reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches }) {
    Object.assign(this, { board, enabled, reducedMotion });
    this.nodes = new Set(); this.animations = new Set();
    this.flight = null; this.impacts = [];
    this.root = this.element('svg', { class: 'board-effects', viewBox: '0 0 450 500', 'aria-hidden': 'true' });
    const defs = this.element('defs');
    for (const piece of ['rC', 'bC']) {
      const p = palette(piece), gradient = this.element('radialGradient', { id: p.halo });
      for (const [offset, color, opacity] of [[0,p.hot,.8],[.22,p.color,.5],[.55,p.color,.19],[1,p.color,0]]) {
        gradient.append(this.element('stop', { offset, 'stop-color': color, 'stop-opacity': opacity }));
      }
      defs.append(gradient);
    }
    this.root.append(defs); board.append(this.root);
  }

  get allowed() { return this.enabled() && !this.reducedMotion(); }
  layer() { return { nodes: new Set(), animations: new Set() }; }

  element(tag, attributes = {}) {
    const node = this.board.ownerDocument.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  node(layer, tag, attributes) {
    const node = this.element(tag, attributes);
    this.root.append(node); this.nodes.add(node); layer.nodes.add(node); return node;
  }

  animate(layer, node, frames, options, remove = true) {
    if (!node.animate) {
      if (remove) { node.remove(); this.nodes.delete(node); layer.nodes.delete(node); }
      return;
    }
    const animation = node.animate(frames, { fill: 'both', ...options });
    this.animations.add(animation); layer.animations.add(animation);
    const finish = () => {
      this.animations.delete(animation); layer.animations.delete(animation);
      if (remove) { node.remove(); this.nodes.delete(node); layer.nodes.delete(node); }
      animation.cancel(); // Release finished fill animations, including board shake.
      if (!layer.nodes.size && !layer.animations.size) this.impacts = this.impacts.filter(item => item !== layer);
    };
    animation.finished.then(finish, finish);
  }

  ring(layer, x, y, { color, radius = 23, width = 2, scale = 3, duration = 650, delay = 0, dash, rotate = 0 }) {
    const ring = this.node(layer, 'circle', { class: 'vfx-ring', cx: x, cy: y, r: radius,
      stroke: color, 'stroke-width': width, fill: 'none', ...(dash ? { 'stroke-dasharray': dash } : {}) });
    ring.style.transformOrigin = `${x}px ${y}px`;
    this.animate(layer, ring, [
      { transform: 'scale(.6) rotate(0deg)', opacity: 0, offset: 0 },
      { transform: 'scale(.95) rotate(8deg)', opacity: .95, offset: .12 },
      { transform: `scale(${scale}) rotate(${rotate}deg)`, opacity: 0 },
    ], { duration, delay, easing: burst });
  }

  start(move, from, to) {
    this.cancelFlight();
    if (!this.allowed) { this.clear(); return; }
    const layer = this.flight = this.layer(), a = point(from), b = point(to), p = palette(move.piece);
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const nx = -dy / length, ny = dx / length;
    for (const [width, opacity, color] of [[22,.25,p.color],[8,.75,p.color],[2.1,1,p.hot]]) {
      const line = this.node(layer, 'line', { class: `vfx-trail${width === 22 ? ' vfx-bloom' : ''}`,
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, 'stroke-width': width, opacity,
        'stroke-dasharray': length, 'stroke-dashoffset': 0 });
      this.animate(layer, line, [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
        { duration: 380, easing: glide }, false);
    }
    // A fine lightning filament runs inside the broad comet trail.
    let path = `M${a.x} ${a.y}`;
    for (let i = 1; i <= 12; i++) {
      const t = i / 12, offset = i === 12 ? 0 : Math.sin(i * 2.8) * 5;
      path += `L${a.x + dx * t + nx * offset} ${a.y + dy * t + ny * offset}`;
    }
    const filament = this.node(layer, 'path', { class: 'vfx-filament', d: path, pathLength: 1,
      fill: 'none', stroke: p.hot, 'stroke-width': 1.2, 'stroke-dasharray': 1, opacity: .85 });
    this.animate(layer, filament, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 380, easing: glide }, false);
    this.ring(layer, a.x, a.y, { color: p.color, scale: 2.1, duration: 380, dash: '3 5', rotate: 50 });
    this.ring(layer, b.x, b.y, { color: p.hot, radius: 29, scale: 1, duration: 380, dash: '9 7', rotate: 100 });
    for (let i = 0; i < 9; i++) {
      const offset = Math.sin(i * 2.4) * 8;
      const spark = this.node(layer, 'circle', { class: 'vfx-comet', cx: a.x, cy: a.y, r: i % 3 ? 1.5 : 2.7, fill: i % 2 ? p.color : p.hot });
      this.animate(layer, spark, [
        { transform: 'translate(0px, 0px)', opacity: 0 },
        { opacity: 1, offset: .15 },
        { transform: `translate(${dx + nx * offset}px, ${dy + ny * offset}px)`, opacity: 0 },
      ], { duration: 380, delay: i * 7, easing: glide });
    }
  }

  land(move, cell) {
    this.cancelFlight();
    if (!this.allowed) { this.clear(); return; }
    // Two bounded bursts may overlap so a quick engine reply doesn't cut a
    // capture short. An old burst is removed before a third can be created.
    if (this.impacts.length >= 2) this.clearLayer(this.impacts.shift());
    const layer = this.layer(); this.impacts.push(layer);
    const { x, y } = point(cell), capture = !!move.captured, p = palette(move.piece);
    const halo = this.node(layer, 'circle', { class: 'vfx-halo', cx: x, cy: y,
      r: capture ? 100 : 52, fill: `url(#${p.halo})` });
    halo.style.transformOrigin = `${x}px ${y}px`;
    this.animate(layer, halo, [{ transform: 'scale(.25)', opacity: 0 },
      { transform: 'scale(.8)', opacity: capture ? .95 : .55, offset: .15 },
      { transform: 'scale(1.3)', opacity: 0 }], { duration: capture ? 760 : 500, easing: burst });
    this.ring(layer, x, y, { color: p.hot, width: capture ? 3 : 2, scale: capture ? 4.8 : 2.2, duration: capture ? 1000 : 650 });
    this.ring(layer, x, y, { color: p.color, radius: 26, width: 1.3, scale: capture ? 3.6 : 1.8,
      duration: capture ? 1150 : 720, delay: 90, dash: '14 5 2 5', rotate: 65 });
    if (capture) this.ring(layer, x, y, { color: p.hot, radius: 30, width: 1, scale: 2.6,
      duration: 1000, delay: 160, dash: '2 7', rotate: -100 });

    const count = capture ? 32 : 8;
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count, distance = (capture ? 75 : 35) + (i % 4) * 15;
      const cosine = Math.cos(angle), sine = Math.sin(angle), size = i % 3 ? 2 : 3.2;
      const shard = this.node(layer, 'path', { class: 'vfx-spark',
        d: `M${x} ${y-size*2}l${size} ${size*2}l${-size} ${size*2}l${-size} ${-size*2}Z`,
        fill: i % 3 ? p.color : p.hot });
      shard.style.transformOrigin = `${x}px ${y}px`;
      this.animate(layer, shard, [
        { transform: `translate(${cosine*20}px, ${sine*20}px) rotate(${i*31}deg) scale(.6)`, opacity: 0 },
        { opacity: 1, offset: .08 },
        { transform: `translate(${cosine*distance}px, ${sine*distance}px) rotate(${i*31+110}deg) scale(.15)`, opacity: 0 },
      ], { duration: (capture ? 750 : 500) + (i % 4) * 95, easing: burst });
    }
    if (!capture) return;
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6, cosine = Math.cos(angle), sine = Math.sin(angle);
      let d = `M${x+cosine*25} ${y+sine*25}`;
      for (let j = 1; j <= 4; j++) {
        const radius = 25 + j * (13 + i % 3 * 3), kink = j % 2 ? 6 : -6;
        d += `L${x+cosine*radius-sine*kink} ${y+sine*radius+cosine*kink}`;
      }
      const ray = this.node(layer, 'path', { class: 'vfx-lightning', d, fill: 'none', stroke: i % 2 ? p.color : p.hot,
        'stroke-width': i % 3 ? 1.2 : 2, pathLength: 1, 'stroke-dasharray': 1 });
      this.animate(layer, ray, [{ opacity: 0, strokeDashoffset: 1 },
        { opacity: .95, strokeDashoffset: 0, offset: .22 }, { opacity: 0, strokeDashoffset: -.2 }],
      { duration: 470 + i % 3 * 90, easing: 'ease-out' });
    }
    this.animate(layer, this.board, [
      { transform: 'translate(0, 0)' }, { transform: 'translate(-2px, 1px)' },
      { transform: 'translate(2px, -1px)' }, { transform: 'translate(-1px, .5px)' },
      { transform: 'translate(0, 0)' },
    ], { duration: 180, easing: 'ease-out' }, false);
  }

  clearLayer(layer) {
    if (!layer) return;
    for (const animation of layer.animations) { animation.cancel(); this.animations.delete(animation); }
    layer.animations.clear();
    for (const node of layer.nodes) { node.remove(); this.nodes.delete(node); }
    layer.nodes.clear();
  }
  cancelFlight() { this.clearLayer(this.flight); this.flight = null; }
  clear() {
    this.cancelFlight();
    for (const layer of this.impacts) this.clearLayer(layer);
    this.impacts = [];
  }
}
