import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Rules } from '../server/rules.mjs';
import { Engine } from '../server/engine.mjs';
import { PUZZLES, ORIGINAL_PUZZLES, CCPD_PUZZLES, PUZZLE_CATALOG_VERSION } from '../server/puzzles.mjs';
import { CCPD_COMMIT, CCPD_REPOSITORY } from '../scripts/ccpd-pgn.mjs';

const rules = new Rules();
const sorted = values => [...values].sort();
const key = (puzzle, moves) => `${puzzle.id}:${moves.join(' ')}`;

// The shipped rule binary accepts multiple independent JSON lines in one run.
// Batch checks to exercise the real validator without a process per tree node.
function inspectBatch(requests) {
  if (!requests.length) return [];
  if (requests.length > 300) return requests.flatMap((_, index) => index % 300 === 0 ? inspectBatch(requests.slice(index, index + 300)) : []);
  const output = execFileSync(rules.binary, [], {
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  });
  const results = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(results.length, requests.length);
  results.forEach((result, index) => assert.equal(result.error, undefined, JSON.stringify(requests[index])));
  return results;
}

let tree;
function solutionTree() {
  if (tree) return tree;
  const nodes = new Map();
  for (const puzzle of PUZZLES) {
    for (const line of puzzle.solutions) {
      for (let ply = 0; ply <= line.length; ply++) {
        const moves = line.slice(0, ply), id = key(puzzle, moves);
        const node = nodes.get(id) ?? { puzzle, moves, children: new Set() };
        if (ply < line.length) node.children.add(line[ply]);
        nodes.set(id, node);
      }
    }
  }
  const entries = [...nodes.values()];
  const positions = inspectBatch(entries.map(({ puzzle, moves }) => ({ fen: puzzle.fen, moves })));
  positions.forEach((position, index) => { entries[index].position = position; });
  tree = nodes;
  return tree;
}

function symmetryKey(position) {
  const pieces = Object.entries(position.pieces).map(([square, piece]) => {
    if (position.turn === 'r') return [square, piece];
    return [square[0] + (9 - Number(square[1])), (piece[0] === 'r' ? 'b' : 'r') + piece[1]];
  });
  const plain = JSON.stringify(pieces.sort());
  const reflected = JSON.stringify(pieces.map(([square, piece]) => [String.fromCharCode(202 - square.charCodeAt(0)) + square[1], piece]).sort());
  return [plain, reflected].sort()[0];
}

test('catalog has original and attributed CCPD metadata, position variety and progressive move budgets', () => {
  assert.match(PUZZLE_CATALOG_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.ok(PUZZLES.length >= 18);
  assert.equal(ORIGINAL_PUZZLES.length, 18);
  assert.equal(CCPD_PUZZLES.length, 75);
  assert.equal(new Set(PUZZLES.map(puzzle => puzzle.id)).size, PUZZLES.length);
  assert.equal(new Set(PUZZLES.map(puzzle => puzzle.fen)).size, PUZZLES.length);
  assert.ok(new Set(PUZZLES.map(puzzle => puzzle.theme)).size >= 6);
  assert.ok(PUZZLES.filter(puzzle => puzzle.fen.endsWith(' b')).length >= 2);
  assert.ok(PUZZLES.some(puzzle => puzzle.maxPlayerMoves === 3));
  for (const puzzle of PUZZLES) {
    assert.match(puzzle.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const field of ['title', 'theme', 'hint', 'explanation']) assert.ok(puzzle[field]?.trim(), `${puzzle.id}: ${field}`);
    assert.ok(['original', 'ccpd'].includes(puzzle.source.kind));
    if (puzzle.source.kind === 'original') assert.ok(puzzle.source.note);
    else {
      assert.equal(puzzle.source.commit, CCPD_COMMIT);
      assert.equal(puzzle.source.license, 'CC-BY-4.0');
      assert.ok(puzzle.source.url.startsWith(`${CCPD_REPOSITORY}/blob/${CCPD_COMMIT}/Dataset/`));
      assert.match(puzzle.source.sha256, /^[a-f0-9]{64}$/);
      assert.ok(puzzle.source.authors && puzzle.source.changes && puzzle.source.licenseUrl);
    }
    assert.equal(puzzle.goal, 'mate');
    assert.ok([1, 2, 3].includes(puzzle.maxPlayerMoves));
    assert.equal(puzzle.difficulty, ['入门', '基础', '进阶'][puzzle.maxPlayerMoves - 1]);
    assert.ok(Number.isInteger(puzzle.rating) && puzzle.rating >= 500 && puzzle.rating <= 1800);
    assert.ok(puzzle.solutions.length > 0);
    assert.equal(new Set(puzzle.solutions.map(line => line.join(' '))).size, puzzle.solutions.length);
    for (const line of puzzle.solutions) {
      assert.ok(line.length > 0 && line.length % 2 === 1);
      assert.ok((line.length + 1) / 2 <= puzzle.maxPlayerMoves);
      line.forEach(move => assert.match(move, /^[a-i][0-9][a-i][0-9]$/));
    }
  }
});

test('every solution is legal and wins by checkmate or stalemate; initial boards are playable for both sides', () => {
  const nodes = solutionTree(), endings = new Set(), identities = new Set();
  for (const puzzle of PUZZLES) {
    const initial = nodes.get(key(puzzle, [])).position;
    assert.equal(initial.terminal, false, puzzle.id);
    assert.equal(initial.inCheck, false, puzzle.id);
    identities.add(symmetryKey(initial));
    for (const line of puzzle.solutions) {
      const end = nodes.get(key(puzzle, line)).position;
      assert.equal(end.terminal, true, `${puzzle.id}: ${line.join(' ')}`);
      assert.equal(end.winner, initial.turn, puzzle.id);
      assert.ok(['checkmate', 'stalemate'].includes(end.endReason));
      endings.add(end.endReason);
    }
  }
  assert.equal(identities.size, PUZZLES.length, 'mirrors or color-swapped duplicates are not distinct exercises');
  assert.deepEqual(sorted(endings), ['checkmate', 'stalemate']);
  const opposingTurns = inspectBatch(PUZZLES.map(puzzle => ({ fen: puzzle.fen.replace(/ [rb]$/, puzzle.fen.endsWith(' r') ? ' b' : ' r') })));
  opposingTurns.forEach((position, index) => assert.equal(position.terminal, false, `${PUZZLES[index].id}: opponent already has no legal moves`));
  for (const { puzzle, moves, children, position } of nodes.values()) {
    if (children.size) assert.equal(position.terminal, false, `${puzzle.id}: premature terminal ${moves.join(' ')}`);
  }
});

test('solution trees contain every legal defender reply and every winning final player move', () => {
  const nodes = solutionTree(), finalMoveChecks = [], finalMoves = [];
  for (const node of nodes.values()) {
    const { puzzle, moves, children, position } = node;
    if (position.terminal) continue;
    const player = puzzle.fen.split(' ')[1];
    if (position.turn !== player) {
      assert.deepEqual(sorted(children), sorted(position.legalMoves.map(move => move.uci)), `${puzzle.id}: missing defense after ${moves.join(' ')}`);
    } else if (moves.length / 2 === puzzle.maxPlayerMoves - 1) {
      const offset = finalMoves.length;
      for (const move of position.legalMoves) finalMoves.push({ fen: position.fen, moves: [move.uci] });
      finalMoveChecks.push({ node, offset, count: position.legalMoves.length });
    }
  }
  const results = inspectBatch(finalMoves);
  for (const { node, offset, count } of finalMoveChecks) {
    const wins = results.slice(offset, offset + count)
      .flatMap((position, index) => position.terminal && position.winner === node.position.turn ? [finalMoves[offset + index].moves[0]] : []);
    assert.deepEqual(sorted(node.children), sorted(wins), `${node.puzzle.id}: missing winning final move after ${node.moves.join(' ')}`);
  }
});

test('independent Pikafish search agrees with every original winning first move and the shortest budget', { timeout: 60000 }, async t => {
  const engine = new Engine(undefined, { threads: 1, hashMb: 32 });
  t.after(() => engine.close());
  const nodes = solutionTree();
  for (const puzzle of ORIGINAL_PUZZLES) {
    const initial = nodes.get(key(puzzle, [])).position;
    const result = await engine.analyze({ initialFen: puzzle.fen, multiPV: initial.legalCount, movetime: 300 });
    assert.equal(result.lines.length, initial.legalCount, `${puzzle.id}: engine omitted legal candidates`);
    const wins = result.lines.filter(line => line.score.type === 'mate' && line.score.value > 0 && line.score.value <= puzzle.maxPlayerMoves);
    assert.ok(wins.length, puzzle.id);
    wins.forEach(line => assert.equal(line.score.bound, 'exact', puzzle.id));
    assert.deepEqual(sorted(new Set(puzzle.solutions.map(line => line[0]))), sorted(wins.map(line => line.pv[0])), `${puzzle.id}: a legal winning first move is missing`);
    assert.equal(Math.min(...wins.map(line => line.score.value)), puzzle.maxPlayerMoves, `${puzzle.id}: advertised budget is not the shortest forced win`);
  }
});

test('independent Pikafish search confirms every imported position is a forced short win', { timeout: 60000 }, async t => {
  const engine = new Engine(undefined, { threads: 1, hashMb: 32 });
  t.after(() => engine.close());
  for (const puzzle of CCPD_PUZZLES) {
    const result = await engine.analyze({ initialFen: puzzle.fen, multiPV: 1, movetime: 200 });
    const best = result.lines[0];
    assert.equal(best.score.type, 'mate', puzzle.id);
    assert.equal(best.score.bound, 'exact', puzzle.id);
    assert.ok(best.score.value > 0 && best.score.value <= puzzle.maxPlayerMoves, puzzle.id);
    assert.ok(puzzle.solutions.some(line => line[0] === best.pv[0]), `${puzzle.id}: engine's winning choice is absent`);
  }
});
