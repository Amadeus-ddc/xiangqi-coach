import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardSquares } from '../web/board-squares.mjs';
import { displayedScore, retainScores, updateScoreLabel, drawScoreChart } from '../web/score-chart.mjs';

// Minimal DOM with identity, focus and mutation counts: these regressions are
// about remounting visible elements, not just producing equivalent markup.
function documentFixture() {
  const document = { activeElement: null, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  class Element {
    constructor(tag) {
      this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = new Map();
      this.dataset = {}; this.replacements = 0; this.textContent = ''; this.animations = [];
      this.classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name) };
    }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
    remove() { if (this.parentElement) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; } }
    replaceChildren(...children) { this.replacements++; for (const child of [...this.children]) child.remove(); this.append(...children); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    focus() { document.activeElement = this; }
    animate(frames, options) { const animation = { frames, options, canceled: false, cancel() { this.canceled = true; } }; this.animations.push(animation); return animation; }
  }
  return document;
}
const score = value => ({ type: 'cp', value, bound: 'exact' });
const point = (ply, value) => ({ ply, fen: `fen-${ply}`, ...(value === undefined ? {} : { red: score(value), black: score(-value) }) });
const snapshot = (id, moves, scores) => ({ game: { id, initialFen: 'start', moves: moves.map(uci => ({ uci })) }, scores });

test('save, engine wait and score renders preserve all squares, stationary pieces and selection focus', () => {
  const document = documentFixture(), root = document.createElement('div');
  const clicked = [], ui = new BoardSquares({ root, onSelect: square => clicked.push(square), createPiece: name => Object.assign(document.createElement('span'), { textContent: name }) });
  const initial = { h2: 'rC', h9: 'bN', e0: 'rK', e9: 'bK' };
  const options = { flipped: false, active: true, selected: null, allowed: new Set() };
  ui.update({ ...options, pieces: initial });
  const squares = [...root.children], king = ui.cells.get('e0').children[0], knight = ui.cells.get('h9').children[0];
  const cannon = ui.cells.get('h2').children[0], source = ui.cells.get('h2'); source.focus();
  ui.update({ ...options, pieces: initial, selected: 'h2', allowed: new Set(['e2']) });
  assert.equal(document.activeElement, source);
  assert.equal(source.children[0], cannon);
  assert.equal(ui.cells.get('e2').classList.contains('legal'), true);
  const moved = { ...initial, e2: 'rC' }; delete moved.h2;
  for (const active of [false, false, false, true]) ui.update({ ...options, pieces: moved, active, last: 'h2e2' });
  assert.deepEqual(root.children, squares, 'none of the 90 square nodes may be remounted');
  assert.equal(root.replacements, 0);
  assert.equal(ui.cells.get('e0').children[0], king);
  assert.equal(ui.cells.get('h9').children[0], knight);
  assert.equal(ui.cells.get('e2').replacements, 1, 'the arriving piece must not be recreated on save confirmation');
  assert.equal(source.children.length, 0);
  assert.equal(source.classList.contains('last-from'), true);
  assert.equal(ui.cells.get('e2').classList.contains('last-to'), true);
  ui.cells.get('e2').onclick(); assert.deepEqual(clicked, ['e2']);
  ui.update({ ...options, pieces: initial });
  assert.equal(source.children[0].textContent, 'rC', 'undo restores the original square');
  assert.equal(ui.cells.get('e2').children.length, 0);
});

test('flipping retains cell identity and updates arrow-key navigation to visual order', () => {
  const document = documentFixture(), root = document.createElement('div');
  const ui = new BoardSquares({ root, onSelect() {}, createPiece: () => document.createElement('span') });
  const cells = [...root.children];
  ui.update({ pieces: {}, flipped: true, active: true, selected: null, allowed: new Set() });
  assert.deepEqual(root.children, cells.toReversed());
  assert.equal(root.children[0].dataset.square, 'i0');
  root.children[0].onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(document.activeElement.dataset.square, 'h0');
  document.activeElement.onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(document.activeElement.dataset.square, 'h1');
});

test('live score survives pending moves and evaluation gaps, including real zero, mate and failure/retry waits', () => {
  const points = [point(0, 0), point(1, 320), point(2)];
  assert.deepEqual(displayedScore(points), { point: points[1], stale: true });
  assert.deepEqual(displayedScore(points.slice(0, 2), { pending: true }), { point: points[1], stale: true });
  assert.deepEqual(displayedScore(points, { selectedPly: 2 }), { point: points[2], stale: false }, 'history must not display a neighboring turn');
  points[2] = point(2, 0);
  assert.deepEqual(displayedScore(points), { point: points[2], stale: false }, 'a genuine zero is a completed evaluation');
  points[2].red = { type: 'mate', value: -3 };
  points.push(point(3));
  assert.equal(displayedScore(points).point.red.type, 'mate');
  assert.equal(displayedScore([point(0)]).point, undefined, 'an unscored game must not manufacture a zero');
});

test('save responses retain evaluated history but reject other games, undone moves and diverged prefixes', () => {
  const before = snapshot('a', ['h2e2', 'h9g7'], [point(0, 20), point(1, 320), point(2, 120)]);
  const next = snapshot('a', ['h2e2', 'h9g7', 'h0g2'], [0, 1, 2, 3].map(ply => point(ply)));
  const merged = retainScores(before, next);
  assert.deepEqual(merged.map(p => p.red?.value), [20, 320, 120, undefined]);
  assert.equal(next.scores[1].red, undefined, 'retaining data does not mutate a server response');
  assert.equal(retainScores(before, { ...next, game: { ...next.game, id: 'b' } })[1].red, undefined);
  const branch = snapshot('a', ['b2e2', 'h9g7'], [point(0), point(1), point(2)]);
  assert.deepEqual(retainScores(before, branch).map(p => p.red?.value), [20, undefined, undefined], 'even a matching FEN cannot reuse a diverged repetition history');
  const undo = snapshot('a', ['h2e2'], [point(0), point(1)]);
  assert.equal(retainScores(before, undo).length, 2);
  const scored = { ...next, scores: [point(0, 90), point(1, 400)] };
  assert.equal(retainScores(before, scored)[1].red.value, 400, 'new authoritative scores take precedence');
});

test('score labels transition between actual results once and respect reduced motion and new games', () => {
  const document = documentFixture(), label = document.createElement('strong');
  updateScoreLabel(label, score(320), 'a', false);
  updateScoreLabel(label, score(320), 'a', false);
  assert.equal(label.animations.length, 0);
  updateScoreLabel(label, score(180), 'a', false);
  assert.equal(label.textContent, '+180');
  assert.equal(label.animations.length, 1);
  updateScoreLabel(label, score(180), 'a', false);
  assert.equal(label.animations.length, 1, 'save/status renders must not restart a score transition');
  updateScoreLabel(label, score(0), 'a', true);
  assert.equal(label.animations[0].canceled, true);
  assert.equal(label.textContent, '0');
  assert.equal(label.animations.length, 1);
  updateScoreLabel(label, undefined, 'b', false);
  assert.equal(label.textContent, '—', 'a new game clears the previous game score');
});

test('pending evaluations preserve curve geometry and SVG identity; updates keep focused history points', () => {
  const document = documentFixture(), svg = document.createElement('svg'), selections = [];
  const points = [point(0, 50), point(1, 300)];
  drawScoreChart(svg, points, 1, ply => selections.push(ply));
  const path = svg.children.find(node => node.getAttribute('class') === 'score-line red');
  const dot = svg.children.filter(node => node.tagName === 'g')[1]; dot.focus();
  const nodes = [...svg.children], geometry = path.getAttribute('d');
  drawScoreChart(svg, [...points, point(2)], 2, ply => selections.push(ply));
  assert.deepEqual(svg.children, nodes);
  assert.equal(path.getAttribute('d'), geometry, 'the existing curve must not collapse or shrink during evaluation');
  drawScoreChart(svg, [...points, point(2, -100)], 2, ply => selections.push(ply));
  assert.ok(svg.children.includes(path)); assert.ok(svg.children.includes(dot));
  assert.equal(document.activeElement, dot);
  dot.onclick(); assert.deepEqual(selections, [1]);
  assert.notEqual(path.getAttribute('d'), geometry);
  drawScoreChart(svg, [points[0]], 0, () => {});
  assert.equal(svg.children.filter(node => node.tagName === 'g').length, 1, 'undo removes only withdrawn points');
  assert.equal(svg.replacements, 0);
});
