import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardEffects } from '../web/board-effects.mjs';

function fixture() {
  const animations = [];
  const create = tag => ({ tag, style: {}, children: [], attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    append(node) { this.children.push(node); node.parent = this; },
    remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    animate(frames, options) {
      let finish, reject;
      const animation = { frames, options, finished: new Promise((yes, no) => { finish = yes; reject = no; }),
        finish: () => finish(), cancel: () => reject(new Error('cancelled')) };
      animations.push(animation); return animation;
    },
  });
  const board = create('board'); board.ownerDocument = { createElementNS: (_, tag) => create(tag) };
  const preferences = { enabled: true, reduced: false };
  const effects = new BoardEffects({ board, enabled: () => preferences.enabled, reducedMotion: () => preferences.reduced });
  return { effects, animations, preferences };
}
const capture = { piece: 'rC', captured: 'bN' }, from = { column: 7, row: 7 }, to = { column: 7, row: 0 };

test('capture effects clean up without holding the game turn, and disabled/reduced motion stays static', async () => {
  const { effects, animations, preferences } = fixture();
  effects.start(capture, from, to);
  const beam = [...effects.nodes].find(node => node.tag === 'line');
  assert.equal(beam.attrs.y1, '375');
  assert.equal(beam.attrs.y2, '25');
  effects.land(capture, to);
  assert.ok(effects.nodes.size > 0 && effects.nodes.size <= 64, 'each burst has a bounded render cost');
  for (const animation of animations) animation.finish();
  await Promise.resolve();
  assert.equal(effects.nodes.size, 0);
  assert.deepEqual(effects.root.children.map(node => node.tag), ['defs']);
  assert.equal(effects.impacts.length, 0);
  preferences.enabled = false; effects.start(capture, from, to); effects.land(capture, to);
  assert.equal(effects.nodes.size, 0);
  preferences.enabled = true; preferences.reduced = true;
  effects.start(capture, from, to); effects.land(capture, to);
  assert.equal(effects.nodes.size, 0);
});

test('switching boards or disabling effects cancels all pending visual work without residual particles', async () => {
  const { effects } = fixture();
  effects.land(capture, to); effects.clear();
  effects.start({ piece: 'bN' }, from, to);
  const newNodes = [...effects.nodes];
  await Promise.resolve();
  assert.deepEqual([...effects.nodes], newNodes, 'old completions must not remove new effects');
  effects.clear(); await Promise.resolve();
  assert.equal(effects.animations.size, 0);
  assert.equal(effects.nodes.size, 0);
  assert.deepEqual(effects.root.children.map(node => node.tag), ['defs']);
});

test('a fast reply preserves the preceding impact, with at most two bursts and complete cancellation', async () => {
  const { effects } = fixture();
  effects.land(capture, to);
  const first = [...effects.nodes];
  effects.start({ piece: 'bR' }, to, from);
  assert.ok(first.every(node => effects.nodes.has(node)), 'reply must not abruptly erase the capture');
  effects.land({ piece: 'bR', captured: 'rC' }, from);
  const second = [...effects.nodes].filter(node => !first.includes(node));
  assert.equal(effects.impacts.length, 2);
  effects.land(capture, to); await Promise.resolve();
  assert.equal(effects.impacts.length, 2, 'bursts must not accumulate under rapid replay');
  assert.ok(first.every(node => !effects.nodes.has(node)));
  assert.ok(second.every(node => effects.nodes.has(node)));
  assert.ok(effects.nodes.size <= 128);
  effects.clear(); await Promise.resolve();
  assert.equal(effects.nodes.size, 0);
  assert.equal(effects.animations.size, 0);
  assert.equal(effects.impacts.length, 0);
});
