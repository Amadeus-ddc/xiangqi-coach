import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientEvaluation, mateEvaluation, compressedEvaluation, clientMoveScore, engineScoreToClient, scoreFromLoss } from '../server/tiantian-analysis.mjs';
import { moveQuality, summarizeRows, gradeFor } from '../server/review.mjs';
import { START_FEN } from '../server/rules.mjs';
import { formatMoveScore, gradeClassFor, isCompleteCurrentReview, needsAutomaticReview } from '../web/review-panel.mjs';

// Expected numbers were produced independently by isolated, audited source
// functions from the pinned APK, before comparison with this implementation.
const fixture = JSON.parse(readFileSync(new URL('../validation/2026-10-12-tiantian-score-fixtures.json', import.meta.url)));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-10, `${label}: ${actual} != ${expected}`);

test('client conversion and compression match 69 frozen source-oracle vectors including signed rounding', () => {
  for (const vector of fixture.vectors.compression) assert.equal(compressedEvaluation(vector.input), vector.expected);
  for (const vector of fixture.vectors.engineScore) {
    const { input, expected } = vector;
    if (input.type === 'mate') assert.equal(mateEvaluation(input.value), expected.parsedScore);
    else assert.equal(clientEvaluation(input.value), expected.normalizedScore);
    assert.equal(engineScoreToClient(input), expected.normalizedScore);
  }
});

test('piecewise score matches all 39 source-oracle vectors and grades do not round across thresholds', () => {
  for (const { input, expected } of fixture.vectors.moveQuality) near(clientMoveScore(input.beforeRedScore, input.afterRedScore, input.moverColor === 2 ? 'b' : 'r'), expected.moveScore, JSON.stringify(input));
  assert.deepEqual([0, 30, 60, 120, 180, 240, 480, 960, 2000].map(scoreFromLoss), [100, 80, 60, 40, 20, 0, -100, -300, -300]);
  assert.equal(gradeFor(79.999), '良'); assert.equal(gradeFor(19.999), '错');
  assert.equal(formatMoveScore(79.999), '79.9'); assert.equal(gradeClassFor(-300), 0);
});

test('nine full UCI-to-review flows match the source oracle on either root mover', () => {
  for (const { input, expected } of fixture.vectors.reviewFlow) {
    assert.equal(engineScoreToClient(input.before), expected.clientBefore);
    assert.equal(engineScoreToClient(input.after), expected.clientAfter);
    for (const fen of [START_FEN, START_FEN.replace(' r ', ' b ')]) {
      const best = { move: 'a0a1', terminal: true, score: { ...input.before, perspective: 'side_to_move', bound: 'exact' } };
      const played = { move: 'a0a2', terminal: true, score: { ...input.after, perspective: 'side_to_move', bound: 'exact' } };
      const quality = moveQuality(best, played, fen);
      near(quality.accuracy, expected.score, `${input.before.value} -> ${input.after.value}`);
      assert.equal(quality.scoringLoss, Math.max(0, expected.loss));
    }
  }
});

test('aggregate negative scores before display clamping and distinguish zero from unentered phases', () => {
  const rows = [-300, -300, 100].map(accuracy => ({ side: 'r', stage: 'opening', quality: { accuracy, grade: gradeFor(accuracy) } }));
  rows.push({ side: 'b', stage: 'middlegame', quality: { accuracy: 0, grade: '错' } });
  const summary = summarizeRows(rows);
  assert.equal(summary.r.accuracy, -167); assert.equal(summary.r.displayAccuracy, -100);
  assert.equal(summary.r.phases.opening.displayAccuracy, -100);
  assert.equal(summary.b.phases.middlegame.displayAccuracy, 0);
  assert.equal(summary.b.phases.endgame.displayAccuracy, null);
});

test('an old complete report triggers a refresh and cannot complete a request for a fresh recording review', () => {
  const game = { id: 'one', status: 'finished', initialFen: 'start', moves: [{ fen: 'one' }] };
  const current = { gameId: game.id, status: 'complete', total: 1, rootFen: 'one', outdatedMethod: false };
  assert.equal(isCompleteCurrentReview(current, game), true);
  assert.equal(needsAutomaticReview(game, current), false);
  const old = { ...current, outdatedMethod: true };
  assert.equal(isCompleteCurrentReview(old, game), false);
  assert.equal(needsAutomaticReview(game, old), true);
  assert.equal(isCompleteCurrentReview({ ...current, status: 'running' }, game), false);
});
