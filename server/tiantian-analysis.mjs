// Independently expressed numeric rules observed in the 4.4.6.2 client.
// Evidence and input-scale limitations: TIANTIAN_RESEARCH.md. No Tencent
// executable, asset, source module, or engine weights are shipped here.
export const TIANTIAN_ANALYSIS_VERSION = 'tiantian-4.4.6.2-client-v1';

export function clientEvaluation(cp) {
  const magnitude = Math.abs(cp);
  if (magnitude <= 15 || magnitude > 29000) return cp;
  if (magnitude > 700) return Math.round(2.9 * cp);
  const a = 0.670377;
  const converted = Math.round((a - Math.sqrt(a * a - 0.00064 * (1.15414 + magnitude))) / 0.00032);
  return cp < 0 ? -converted : converted;
}

export function mateEvaluation(mate) {
  return mate > 0 ? 30000 - 2 * mate : -29999 - 2 * mate;
}

export function compressedEvaluation(value) {
  const magnitude = Math.abs(value);
  let scaled = 0;
  if (magnitude <= 500) scaled = magnitude;
  else if (magnitude <= 1000) scaled = 500 + Math.floor((magnitude - 500) * 100 / 250);
  else if (magnitude <= 2500) scaled = 700 + Math.floor((magnitude - 1000) * 100 / 750);
  else if (magnitude <= 30000) scaled = 900 + Math.floor((magnitude - 2500) * 100 / 27500);
  return value < 0 ? 0 - scaled : scaled;
}

export function scoreFromLoss(loss) {
  if (loss <= 0) return 100;
  if (loss <= 30) return 100 - 20 * loss / 30;
  if (loss <= 60) return 80 - 20 * (loss - 30) / 30;
  if (loss <= 120) return 60 - 20 * (loss - 60) / 60;
  if (loss <= 180) return 40 - 20 * (loss - 120) / 60;
  if (loss <= 240) return 20 - 20 * (loss - 180) / 60;
  return Math.max(-300, -100 * (loss - 240) / 240);
}

// Inputs are the client's red-side evaluations. Black reverses both signs.
export function clientMoveScore(before, after, side = 'r') {
  if (Math.abs(after) === 30000) return 100;
  const direction = side === 'b' ? -1 : 1;
  return scoreFromLoss(compressedEvaluation(direction * before) - compressedEvaluation(direction * after));
}

export function engineScoreToClient(score) {
  return clientEvaluation(score.type === 'mate' ? mateEvaluation(score.value) : score.value);
}

export function clientEndgame(pieces) {
  const majors = side => Object.values(pieces).filter(piece => piece[0] === side && ['R', 'N', 'C'].includes(piece[1])).length;
  return majors('r') <= 2 && majors('b') <= 2;
}

export function clientStage(pieces, plyBefore) {
  // The client gives the first 20 plies priority, even for a sparse start FEN.
  if (plyBefore < 20) return 'opening';
  return clientEndgame(pieces) ? 'endgame' : 'middlegame';
}
