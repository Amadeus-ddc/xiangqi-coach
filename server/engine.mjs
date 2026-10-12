import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { engineFen } from './rules.mjs';

export function parseInfo(line) {
  if (!line.startsWith('info ')) return null;
  const score = line.match(/\bscore (cp|mate) (-?\d+)(?: (lowerbound|upperbound))?/);
  const pv = line.match(/\bpv ((?:[a-i][0-9][a-i][0-9] ?)+)/);
  if (!score || !pv) return null;
  const wdl = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  return {
    rank: Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1),
    depth: Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0),
    nodes: Number(line.match(/\bnodes (\d+)/)?.[1] ?? 0),
    score: { type: score[1], value: Number(score[2]), bound: score[3] ?? 'exact', perspective: 'side_to_move' },
    ...(wdl ? { wdl: { win: +wdl[1], draw: +wdl[2], loss: +wdl[3], scale: 1000 } } : {}),
    pv: pv[1].trim().split(/\s+/).slice(0, 12),
  };
}

export async function findEngine() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const candidates = [process.env.XIANGQI_ENGINE, resolve(root, 'dist/pikafish')].filter(Boolean);
  for (const binary of candidates) {
    try {
      await access(binary);
      const nnue = process.env.XIANGQI_NNUE ?? resolve(dirname(binary), 'pikafish.nnue');
      await access(nnue);
      return { binary, nnue };
    } catch {}
  }
  throw new Error('未找到皮卡鱼引擎和棋力文件。请运行 npm run setup:engine，或设置 XIANGQI_ENGINE 与 XIANGQI_NNUE。');
}

// One process, one UCI request at a time. A failed search kills the process so
// delayed output can never become the next position's evidence.
export class Engine {
  constructor(config, { threads = 2, hashMb = 64 } = {}) { this.config = config; this.threads = threads; this.hashMb = hashMb; this.queue = Promise.resolve(); this.child = null; this.listener = null; this.name = 'Pikafish'; }
  analyze(options) {
    const task = this.queue.then(() => this.search(options));
    this.queue = task.catch(() => {});
    return task;
  }
  send(line) { this.child.stdin.write(line + '\n'); }
  exchange(commands, until, onLine = () => {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('引擎分析超时，本次未修改棋局。')), timeout);
      const finish = error => {
        clearTimeout(timer);
        this.listener = null;
        if (error) reject(error); else resolve();
      };
      this.listener = { line: line => { onLine(line); if (until(line)) finish(); }, fail: finish };
      for (const command of commands) this.send(command);
    });
  }
  async start() {
    if (this.child) return;
    this.config ??= await findEngine();
    const child = spawn(this.config.binary, [], { cwd: dirname(this.config.binary), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => { if (this.child === child) this.listener?.line(line); });
    child.stderr.resume();
    child.stdin.on('error', error => { if (this.child === child) this.listener?.fail(error); });
    child.on('error', error => { if (this.child === child) { this.listener?.fail(error); this.child = null; } });
    child.on('exit', () => { if (this.child === child) { this.listener?.fail(new Error('引擎进程已退出，本次未修改棋局。')); this.child = null; } });
    await this.exchange(['uci'], line => line === 'uciok', line => { if (line.startsWith('id name ')) this.name = line.slice(8); });
    await this.exchange([
      `setoption name Threads value ${this.threads}`, `setoption name Hash value ${this.hashMb}`,
      `setoption name EvalFile value ${this.config.nnue}`, 'setoption name UCI_ShowWDL value true', 'isready',
    ], line => line === 'readyok');
  }
  async search({ initialFen, moves = [], searchMoves = [], multiPV = 3, movetime = 700 }) {
    try {
      await this.start();
      // Clear transposition history between independent requests for comparable evidence.
      await this.exchange(['ucinewgame', `setoption name MultiPV value ${multiPV}`, 'isready'], line => line === 'readyok');
      const lines = new Map(), exactLines = new Map();
      let bestmove = null;
      const start = performance.now();
      await this.exchange([
        `position fen ${engineFen(initialFen)}${moves.length ? ' moves ' + moves.join(' ') : ''}`,
        `go movetime ${movetime}${searchMoves.length ? ' searchmoves ' + searchMoves.join(' ') : ''}`,
      ], line => line.startsWith('bestmove '), line => {
        const info = parseInfo(line);
        if (info) {
          lines.set(info.rank, info);
          if (info.score.bound === 'exact') exactLines.set(`${info.rank}:${info.pv[0]}`, info);
        }
        if (line.startsWith('bestmove ')) bestmove = line.split(' ')[1];
      }, movetime + 15000);
      // A timed search often stops in an incomplete aspiration window. Prefer
      // the last complete evaluation of the SAME move over its partial bound.
      const sorted = [...lines.values()].map(line => exactLines.get(`${line.rank}:${line.pv[0]}`) ?? line).sort((a, b) => a.rank - b.rank);
      if (!/^[a-i][0-9][a-i][0-9]$/.test(bestmove) || !sorted.length) throw new Error('引擎没有返回可验证的走法。');
      return { engine: this.name, bestmove, lines: sorted, requestedMs: movetime, elapsedMs: Math.round(performance.now() - start), rootTurn: initialFen.split(' ')[1] === 'b' ? (moves.length % 2 ? 'r' : 'b') : (moves.length % 2 ? 'b' : 'r') };
    } catch (error) { this.close(); throw error; }
  }
  close() {
    const child = this.child;
    this.child = null;
    if (child) child.kill();
  }
}
