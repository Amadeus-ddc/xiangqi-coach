import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChallengeClock, TrainingPanel, trainingGoal, trainingSolutionPreview } from '../web/training-panel.mjs';
import { playTurn } from '../web/turn-flow.mjs';

function clockFixture() {
  let now = 0, id = 0;
  const pending = new Map(), ticks = [], requests = [];
  const clock = new ChallengeClock({ now: () => now, schedule: fn => { pending.set(++id, fn); return id; },
    cancel: key => pending.delete(key), onTick: (...args) => ticks.push(args), onExpire: key => { requests.push(key); return true; } });
  return { clock, ticks, requests, pending, async advance(milliseconds) {
    now += milliseconds;
    const work = [...pending.values()]; pending.clear();
    for (const fn of work) await fn();
  } };
}

test('countdown requests one authoritative expiry read and never declares a local score', async () => {
  const view = clockFixture(), challenge = { remainingSeconds: 3, finished: false };
  view.clock.update('game-a', challenge);
  assert.deepEqual(view.ticks.at(-1), [3, false]);
  await view.advance(1100);
  assert.deepEqual(view.ticks.at(-1), [2, false]);
  await view.advance(4000);
  assert.deepEqual(view.ticks.at(-1), [0, false]);
  assert.deepEqual(view.requests, ['game-a']);
  assert.equal(challenge.finished, false, 'only the server may finish a session');
  assert.equal(view.pending.size, 0, 'do not poll the server after expiry');
  view.clock.update('game-a', { remainingSeconds: 0, finished: false });
  await Promise.resolve();
  assert.deepEqual(view.requests, ['game-a'], 'repeated host snapshots must not repeat the same expiry read');
  view.clock.update('game-b', { remainingSeconds: 0, finished: false });
  assert.deepEqual(view.requests, ['game-a', 'game-b']);
  view.clock.stop();
});

test('expiry waits for an in-flight move to settle without polling the server', async () => {
  const view = clockFixture(); let busy = true, reads = 0;
  view.clock.onExpire = () => { if (busy) return false; reads++; return true; };
  view.clock.update('game-a', { remainingSeconds: 1, finished: false });
  await view.advance(1000);
  assert.equal(reads, 0);
  assert.equal(view.pending.size, 1);
  busy = false;
  await view.advance(1000);
  assert.equal(reads, 1);
  assert.equal(view.pending.size, 0);
  view.clock.stop();
});

test('replayed MCP snapshots and next-puzzle snapshots cannot extend the same challenge clock', async () => {
  const view = clockFixture();
  view.clock.update('challenge', { remainingSeconds: 10, finished: false });
  await view.advance(6000);
  assert.deepEqual(view.ticks.at(-1), [4, false]);
  view.clock.update('challenge', { remainingSeconds: 10, finished: false });
  assert.deepEqual(view.ticks.at(-1), [4, false]);
  await view.advance(4000);
  assert.deepEqual(view.requests, ['challenge']);
  view.clock.stop();
});

test('unlimited and finished challenges never expire locally; switching games cancels the timer', async () => {
  const view = clockFixture();
  view.clock.update('unlimited', { remainingSeconds: null, finished: false });
  assert.deepEqual(view.ticks.at(-1), [null, false]);
  assert.equal(view.pending.size, 0);
  assert.deepEqual(view.requests, []);
  view.clock.update('done', { remainingSeconds: 0, finished: true });
  assert.deepEqual(view.ticks.at(-1), [0, true]);
  assert.deepEqual(view.requests, []);
  view.clock.update('running', { remainingSeconds: 20, finished: false });
  assert.equal(view.pending.size, 1);
  view.clock.stop();
  assert.equal(view.pending.size, 0);
  await view.advance(60000);
  assert.deepEqual(view.requests, []);
});

const puzzle = { id: 'p-one', title: '双车取胜', theme: '双车', difficulty: '基础', rating: 900, goal: 'mate', maxPlayerMoves: 2, source: '本项目原创', progress: { attempts: 0, solved: false } };
const catalog = { catalogVersion: 'one', puzzles: [puzzle], themes: ['双车', '车马'], summary: { total: 2, solved: 0, rating: 1200, bestStreak: 0 } };
const normal = { game: { id: 'original', mode: 'play', version: 1 } };
function exercise(overrides = {}) {
  return { game: { id: 'attempt', mode: 'training', version: 1, initialFen: 'original-exercise-fen', result: null, playerSide: 'r' },
    training: { puzzle, mode: 'learn', status: 'active', feedback: '请解题', hints: 0, mistakes: 0, playerMoves: 0, stars: 0, summary: catalog.summary, ...overrides } };
}
function documentFixture() {
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.dataset = {}; this.attributes = new Map(); this.children = []; this.textContent = ''; this.value = ''; this.hidden = false; this.classes = new Set(); this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) }; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
  }
  const html = readFileSync(new URL('../web/board.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="(training-[^"]+)"/g)].map(([, id]) => [id, new Element()]));
  return { createElement: tag => new Element(tag), getElementById(id) { assert.ok(elements.has(id), `missing training element ${id}`); return elements.get(id); } };
}
function panelFixture(t, call = async () => catalog) {
  const root = documentFixture(), events = [];
  const panel = new TrainingPanel({ root, call, onChange() {}, onStart: args => events.push(['start', args]), onAction: action => events.push(['action', action]), onReturn: () => events.push(['return']), onPreview: value => events.push(['preview', value]), onExpire: async () => true });
  t.after(() => panel.stop());
  panel.update(normal, { connected: true, busy: false });
  panel.opened = true;
  return { root, panel, events, $: id => root.getElementById(id) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('rapid filter changes ignore stale catalog responses and keep available difficulty filters', async t => {
  const reads = [], view = panelFixture(t, (name, args) => { assert.equal(name, 'list_training'); const result = deferred(); reads.push({ args, ...result }); return result.promise; });
  const first = view.panel.load();
  view.panel.filter.theme = '车马';
  const second = view.panel.load();
  assert.equal(reads[1].args.theme, '车马');
  const selected = { ...catalog, puzzles: [{ ...puzzle, id: 'p-two', theme: '车马', difficulty: '进阶' }] };
  reads[1].resolve(selected); await second;
  reads[0].resolve(catalog); await first;
  assert.equal(view.panel.catalog.puzzles[0].id, 'p-two');
  assert.equal(view.$('training-theme').value, '车马');
  const third = view.panel.load(); reads[2].resolve({ ...selected, puzzles: [] }); await third;
  assert.ok(view.$('training-difficulty').children.some(option => option.value === '进阶'));
  assert.match(view.$('training-library-status').textContent, /没有符合筛选/);
});

test('catalog modes use deliberate user actions, with explicit no-limit challenges and no automatic game writes', async t => {
  const view = panelFixture(t); await view.panel.load();
  assert.deepEqual(view.events, []);
  view.$('training-mode-challenge').onclick();
  view.$('training-duration').onchange({ target: { value: '0' } });
  assert.equal(view.$('training-challenge-start').textContent, '开始不限时挑战');
  view.$('training-challenge-start').onclick();
  assert.deepEqual(view.events, [['start', { mode: 'challenge', durationSeconds: 0 }]]);
  view.$('training-mode-rated').onclick();
  view.$('training-cards').children[0].children.at(-1).onclick();
  assert.deepEqual(view.events.at(-1), ['start', { puzzleId: puzzle.id, mode: 'rated', durationSeconds: 0 }]);
  assert.equal(view.$('training-cards').children[0].children[2].textContent, '2手内取胜（将死或困毙）');
  view.panel.update(normal, { connected: true, busy: true });
  view.panel.start(puzzle.id);
  assert.equal(view.events.length, 2, 'a pending mutation prevents a second attempt');
});

test('expanded catalog pages preserve selected puzzle identity and reset on source filtering', async t => {
  const many = { ...catalog, puzzles: Array.from({ length: 53 }, (_, i) => ({ ...puzzle, id: `p-${i}`, title: `实战 ${i}` })) };
  const calls = [], view = panelFixture(t, async (name, args) => { calls.push(args); return args.source ? { ...catalog, puzzles: [puzzle] } : many; });
  await view.panel.load();
  assert.equal(view.$('training-cards').children.length, 24);
  assert.equal(view.$('training-page-prev').disabled, true);
  view.$('training-page-next').onclick();
  assert.equal(view.$('training-page-info').textContent, '第 2 / 3 页');
  view.$('training-cards').children[0].children.at(-1).onclick();
  assert.equal(view.events.at(-1)[1].puzzleId, 'p-24');
  view.$('training-page-next').onclick();
  assert.equal(view.$('training-cards').children.length, 5);
  assert.equal(view.$('training-page-next').disabled, true);
  view.panel.filter.source = 'ccpd'; await view.panel.load();
  assert.equal(calls.at(-1).source, 'ccpd');
  assert.equal(view.panel.page, 0);
  assert.equal(view.$('training-pagination').hidden, true);
});

test('CCPD attribution includes the authors, original record, license and adaptation notice', t => {
  const view = panelFixture(t);
  const source = { kind: 'ccpd', label: 'CCPD 实战棋谱 · CC BY 4.0', authors: 'Yu-Han Tseng and Bo-Nian Chen (2026)', url: 'https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
  view.panel.update(exercise({ puzzle: { ...puzzle, source } }), { connected: true, busy: false });
  assert.match(view.$('training-source').textContent, /CCPD/);
  assert.match(view.$('training-source').children[0].textContent, /Yu-Han Tseng.*截取/);
  assert.equal(view.$('training-source').children[1].href, source.url);
  assert.equal(view.$('training-source').children[2].href, source.licenseUrl);
});

test('only disclosed solutions can be previewed; training termination needs no chess result', t => {
  const view = panelFixture(t), active = exercise();
  view.panel.update(active, { connected: true, busy: false, hasReturn: true });
  assert.equal(view.$('training-solution').hidden, true);
  assert.equal(trainingSolutionPreview(active), null);
  assert.equal(view.$('training-close').textContent, '返回原棋局');
  view.$('training-close').onclick();
  assert.deepEqual(view.events, [['return']]);
  const failed = exercise({ mode: 'rated', status: 'failed', feedback: '请对照答案', ratingChange: -15 });
  view.panel.update(failed, { connected: true, busy: false });
  assert.equal(view.$('training-hint').hidden, true);
  assert.equal(view.$('training-retry').hidden, false);
  assert.equal(view.$('training-rating-change').textContent, '本次训练分 -15');
  const solution = { steps: [{ uci: 'a0a1', chinese: '车九进一', side: 'r', fen: 'after-one' }], explanation: '双车配合。' };
  const revealed = exercise({ status: 'revealed', solution });
  view.panel.update(revealed, { connected: true, busy: false });
  assert.equal(view.$('training-solution').hidden, false);
  view.$('training-preview').onclick();
  assert.deepEqual(view.events.at(-1)[1], { rootFen: 'original-exercise-fen', line: { steps: solution.steps }, index: 0, title: '训练答案 · 逐步演示' });
  view.panel.update(normal, { connected: true, busy: false });
  assert.equal(view.$('training-panel').hidden, true, 'returning to a real game restores its ordinary side panel');
  assert.equal(trainingGoal(puzzle), '2手内取胜（将死或困毙）');
});

test('a legal wrong answer restores the authoritative board without a scripted defense or teaching request', async () => {
  const move = { from: 'a0', to: 'a1', uci: 'a0a1' };
  const initial = { ...exercise(), position: { turn: 'r', pieces: { a0: 'rR' }, legalMoves: [move] } };
  Object.assign(initial.game, { autoReply: true, status: 'active' });
  const rejected = { ...initial, game: { ...initial.game, version: 2 }, training: { ...initial.training, feedback: '这步未达到目标，请换一个落点。', mistakes: 1 } };
  const calls = [], frames = []; let committed = initial, preview = null;
  const result = await playTurn({ snapshot: initial, move, requestId: 'answer', replyRequestId: 'reply',
    call: async name => { calls.push(name); assert.equal(name, 'play_move'); return rejected; },
    onPreview(value) { preview = value; frames.push(preview?.position ?? committed.position); },
    onCommit(value) { committed = value; }, onPhase() {}, paint: () => assert.fail('wrong training answer must not ask for a defense') });
  assert.equal(result, rejected);
  assert.deepEqual(calls, ['play_move']);
  assert.equal(frames[0].pieces.a1, 'rR');
  assert.equal(frames.at(-1).pieces.a0, 'rR');
  assert.equal(committed.training.mistakes, 1);
});
