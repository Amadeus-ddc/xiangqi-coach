// Undo the bundled Pikafish UCI WDL normalization, then express its internal
// evaluation relative to PawnValue=144. Source: vendor/pikafish/src/uci.cpp
// (win_rate_params/to_cp) and types.h. These are approximate material-equivalent
// points; they are not a count of pieces actually won on the board.
export const SCORE_SCALE = 'pikafish-391d491a-pawn100-v1';
export function referencePoints(cp, fen) {
  const weights = { r: 10, n: 5, c: 5, b: 3, a: 2, p: 1 };
  const material = [...fen.split(' ')[0].toLowerCase()].reduce((sum, piece) => sum + (weights[piece] ?? 0), 0);
  const m = Math.max(17, Math.min(110, material)) / 65;
  const a = ((220.59891365 * m - 810.35730430) * m + 928.68185198) * m + 79.83955423;
  return Math.round(cp * a / 144) || 0;
}
export function toReferenceScore(score, fen) {
  return score.type === 'cp' ? { ...score, value: referencePoints(score.value, fen), rawCp: score.value, scale: SCORE_SCALE } : { ...score };
}
export { clientStage as gameStage } from './tiantian-analysis.mjs';
