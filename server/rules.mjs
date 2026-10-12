import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r';
const normalizedNotation = text => String(text).normalize('NFKC').trim().replaceAll(' ', '').replaceAll('馬', '马').replaceAll('車', '车').replaceAll('進', '进').replaceAll('後', '后').replace(/[一二三四五六七八九]/g, numeral => String('一二三四五六七八九'.indexOf(numeral) + 1));

export class Rules {
  constructor(binary = fileURLToPath(new URL('../dist/xiangqi-rules', import.meta.url))) { this.binary = binary; }
  inspect(fen, moves = [], includeLegal = true) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.binary, [], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error(`规则校验未完成：${error.code ?? error.message}`));
        try {
          const result = JSON.parse(stdout);
          if (result.error) throw new Error(result.error);
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ fen, moves, includeLegal }) + '\n');
    });
  }
  async resolveMove(fen, text) {
    const state = await this.inspect(fen);
    const normalized = normalizedNotation(text);
    const matches = state.legalMoves.filter(move => move.uci === normalized || normalizedNotation(move.chinese) === normalized);
    if (matches.length !== 1) throw new Error(`“${text}”不能唯一对应当前局面的合法走法。请读取棋盘后重新选择。`);
    return { move: matches[0], state };
  }
}

export function material(pieces) {
  const counts = { r: {}, b: {} };
  for (const piece of Object.values(pieces)) counts[piece[0]][piece[1]] = (counts[piece[0]][piece[1]] ?? 0) + 1;
  return counts;
}

export function engineFen(fen) {
  const [board, turn] = fen.split(' ');
  return `${board} ${turn === 'r' ? 'w' : 'b'} - - 0 1`;
}
