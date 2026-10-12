import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardMotion, movedPiece } from '../web/board-motion.mjs';

const initial = { h2: 'rC', h9: 'bN', e0: 'rK', e9: 'bK' };
const player = { e2: 'rC', h9: 'bN', e0: 'rK', e9: 'bK' };
const coach = { e2: 'rC', g7: 'bN', e0: 'rK', e9: 'bK' };

function fixture(reducedMotion = false, effects) {
  const layers = new Set(), animations = [], cells = new Map();
  let settled = 0;
  const squares = { querySelector(selector) {
    const square = selector.match(/"(.*?)"/)[1];
    if (!cells.has(square)) {
      const classes = new Set();
      cells.set(square, { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } });
    }
    return cells.get(square);
  } };
  const board = { append: layer => layers.add(layer), ownerDocument: { createElement() {
    return {
      style: {}, setAttribute() {}, append(piece) { this.piece = piece; }, remove() { layers.delete(this); },
      animate(keyframes, options) {
        let finish, reject;
        const finished = new Promise((yes, no) => { finish = yes; reject = no; });
        const animation = { finished, finish, cancel: () => reject(new Error('canceled')), keyframes, options };
        animations.push(animation); return animation;
      },
    };
  } } };
  const motion = new BoardMotion({ board, squares, createPiece: piece => piece, effects, reducedMotion: () => reducedMotion, onSettled: () => settled++ });
  const update = (pieces, options = {}) => motion.update({ pieces, context: 'game:live', flipped: false, ...options });
  return { motion, update, layers, animations, cells, settled: () => settled };
}

test('motion identifies a single move or capture and ignores jumps and unrelated placements', () => {
  assert.deepEqual(movedPiece(initial, player), { from: 'h2', to: 'e2', piece: 'rC', captured: null });
  assert.deepEqual(movedPiece({ h2: 'rC', h9: 'bN' }, { h9: 'rC' }), { from: 'h2', to: 'h9', piece: 'rC', captured: 'bN' });
  assert.equal(movedPiece(initial, coach), null);
  assert.equal(movedPiece(initial, { ...initial, a4: 'rP' }), null);
  assert.equal(movedPiece(initial, initial), null);
});

test('saving and repeated board renders preserve one continuous flight and reveal the destination on landing', async () => {
  const ui = fixture();
  ui.update(initial); ui.update(player);
  assert.equal(ui.motion.active, true);
  assert.equal(ui.layers.size, 1);
  assert.equal(ui.cells.get('e2').classList.contains('motion-target'), true);
  const flight = ui.motion.whenIdle();
  ui.cells.clear(); // A score or save update rebuilt every square.
  ui.update({ ...player }); ui.update(player);
  assert.equal(ui.animations.length, 1, 'confirmation must not restart the glide');
  assert.equal(ui.motion.whenIdle(), flight);
  assert.equal(ui.cells.get('e2').classList.contains('motion-target'), true);
  ui.animations[0].finish(); await flight;
  assert.equal(ui.motion.active, false);
  assert.equal(ui.cells.get('e2').classList.contains('motion-target'), false);
  assert.equal(ui.layers.size, 0);
  assert.equal(ui.settled(), 1);
  ui.update(coach);
  assert.equal(ui.animations.length, 2, 'the opponent gets its own flight');
  ui.motion.cancel(); await ui.motion.whenIdle();
});

test('a captured piece stays until arrival, then both overlay pieces are removed', async () => {
  const ui = fixture();
  ui.update({ h2: 'rC', h9: 'bN' }); ui.update({ h9: 'rC' });
  assert.deepEqual([...ui.layers].map(layer => layer.piece), ['rC', 'bN']);
  const landing = ui.motion.whenIdle(); ui.animations[0].finish(); await landing;
  assert.equal(ui.layers.size, 0);
  assert.equal(ui.cells.get('h9').classList.contains('motion-target'), false);
});

test('flipping or switching games cancels motion and cannot animate between unrelated boards', async () => {
  const ui = fixture();
  ui.update(initial); ui.update(player);
  const oldFlight = ui.motion.whenIdle();
  ui.update(player, { flipped: true }); await oldFlight;
  assert.equal(ui.layers.size, 0);
  assert.equal(ui.motion.active, false);
  assert.equal(ui.settled(), 0, 'an obsolete completion must not repaint the new board');
  ui.update(coach, { context: 'another-game:live', flipped: true });
  assert.equal(ui.animations.length, 1);
  ui.update(initial, { context: 'another-game:live', flipped: true });
  assert.equal(ui.animations.length, 1, 'a multi-move jump is not one fabricated glide');
});

test('flipped views use the correct travel direction and rapid replacement leaves no old overlay', async () => {
  const ui = fixture();
  ui.update(initial, { flipped: true }); ui.update(player, { flipped: true });
  assert.equal(ui.animations[0].keyframes[0].transform, 'translate(-300%, 0%)');
  const first = ui.motion.whenIdle();
  ui.update(coach, { flipped: true }); await first;
  assert.equal(ui.layers.size, 1);
  assert.equal(ui.animations[1].keyframes[0].transform, 'translate(-100%, 200%)');
  assert.equal(ui.cells.get('e2').classList.contains('motion-target'), false);
  assert.equal(ui.cells.get('g7').classList.contains('motion-target'), true);
  const last = ui.motion.whenIdle(); ui.animations[1].finish(); await last;
  assert.equal(ui.layers.size, 0);
  assert.equal(ui.settled(), 1);
});

test('reduced motion reveals the final position immediately without overlay or pending waits', async () => {
  const ui = fixture(true);
  ui.update(initial); ui.update(player); ui.update(coach);
  assert.equal(ui.animations.length, 0);
  assert.equal(ui.layers.size, 0);
  assert.equal(ui.motion.active, false);
  await ui.motion.whenIdle();
});

test('effects land only for a completed flight, never repeat on save, and clear on cancellation', async () => {
  const events = [];
  const effects = { clear: () => events.push('clear'), start: move => events.push(`start:${move.to}`), land: move => events.push(`land:${move.to}`) };
  const ui = fixture(false, effects);
  ui.update(initial); ui.update(player); ui.update({ ...player });
  assert.equal(events.filter(value => value.startsWith('start:')).length, 1);
  const landing = ui.motion.whenIdle(); ui.animations[0].finish(); await landing;
  assert.equal(events.filter(value => value === 'land:e2').length, 1);
  ui.update(coach);
  const cancelled = ui.motion.whenIdle(); ui.update(coach, { flipped: true }); await cancelled;
  assert.equal(events.at(-1), 'clear');
  assert.equal(events.includes('land:g7'), false, 'cancelled moves cannot produce a phantom impact');
  const reducedEvents = [];
  const reduced = fixture(true, { clear() {}, start: () => reducedEvents.push('start'), land: () => reducedEvents.push('land') });
  reduced.update(initial); reduced.update(player);
  assert.deepEqual(reducedEvents, []);
});

test('the next settled move preserves impact effects, while a flip clears them', async () => {
  const events = [];
  const ui = fixture(false, { clear: () => events.push('clear'), cancelFlight: () => events.push('flight-clear'),
    start: () => events.push('start'), land: () => events.push('land') });
  ui.update(initial); ui.update(player);
  const landed = ui.motion.whenIdle(); ui.animations[0].finish(); await landed;
  events.length = 0;
  ui.update(coach);
  assert.deepEqual(events, ['flight-clear', 'start']);
  ui.update(coach, { flipped: true });
  assert.equal(events.at(-1), 'clear');
});
