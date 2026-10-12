import { createHash } from 'node:crypto';

export const CCPD_COMMIT = '368a47a947773dd8692c026e286dd19b6277b993';
export const CCPD_REPOSITORY = 'https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset';
export const CCPD_DIRECTORIES = ['殘局', '殺局_殺法_練習題'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function parsePgn(bytes) {
  const text = new TextDecoder('big5', { fatal: true }).decode(bytes);
  const headers = Object.fromEntries([...text.matchAll(/^\[(\w+) "([^"\r\n]*)"\]\s*$/gm)].map(match => [match[1], match[2]]));
  if (!headers.FEN || !headers.Result) throw new Error('Missing FEN or Result header');
  const fields = headers.FEN.trim().split(/\s+/);
  if (!['w', 'r', 'b'].includes(fields[1])) throw new Error('Invalid FEN side');
  const fen = `${fields[0]} ${fields[1] === 'b' ? 'b' : 'r'}`;
  // This import accepts a single recorded line. Reject unfamiliar constructs
  // instead of silently deleting branches, moves, or editorial annotations.
  const body = text.replace(/^\[.*\]\s*$/gm, '').normalize('NFKC');
  const tokens = body.split(/\s+/).filter(Boolean);
  const notations = [];
  let result;
  for (const token of tokens) {
    if (/^\d+\.(?:\.\.)?$/.test(token)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) { if (result) throw new Error('Repeated result'); result = token; continue; }
    if (result || !/^[前後后中一二三四五12345車车馬马炮砲兵卒相象仕士帥帅將将][一二三四五六七八九1-9車车馬马炮砲兵卒][進进退平][一二三四五六七八九1-9]$/.test(token)) throw new Error(`Unsupported PGN token: ${token}`);
    notations.push(token);
  }
  if (result !== headers.Result || !notations.length) throw new Error('Missing/mismatched game result or no moves');
  return { headers, fen, notations, sha256: sha256(bytes) };
}

// Collapse mirror images and red/black transpositions to one exercise identity.
export function symmetryKey(fen) {
  const [board, turn] = fen.split(' ');
  let rows = board.split('/').map(row => [...row].flatMap(c => /[1-9]/.test(c) ? Array(Number(c)).fill('.') : [c]));
  if (turn === 'b') rows = rows.reverse().map(row => row.map(c => c === '.' ? c : c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  return [rows.flat().join(''), rows.map(row => [...row].reverse()).flat().join('')].sort()[0];
}
