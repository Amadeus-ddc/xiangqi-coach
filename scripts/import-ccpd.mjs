// Reproducible offline import from a pinned, locally checked-out upstream.
// No downloaded code is executed. Raw PGNs and caches stay outside the release.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../server/engine.mjs';
import { PUZZLES } from '../server/puzzles.mjs';
import { CCPD_COMMIT, CCPD_REPOSITORY, CCPD_DIRECTORIES, parsePgn, sha256, symmetryKey } from './ccpd-pgn.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const upstream = resolve(process.argv[2] ?? resolve(root, '.runtime/ccpd/upstream'));
const stage = process.argv[3] ?? 'all';
if (!['all', 'replay', 'screen', 'prove'].includes(stage)) throw new Error('stage: all | replay | screen | prove');
const work = resolve(root, '.runtime/ccpd');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (commit !== CCPD_COMMIT) throw new Error(`Expected pinned upstream ${CCPD_COMMIT}, got ${commit}`);
if (execFileSync('git', ['status', '--porcelain'], { cwd: upstream, encoding: 'utf8' }).trim()) throw new Error('Upstream checkout has local modifications');
await mkdir(resolve(work, 'build'), { recursive: true });
const source = (await readFile(resolve(root, 'native/main.swift'), 'utf8')).split('\nwhile let line = readLine()')[0]
  + '\n' + await readFile(resolve(root, 'scripts/ccpd-tools.swift'), 'utf8');
await writeFile(resolve(work, 'build/main.swift'), source);
const binary = resolve(work, 'build/ccpd-tools');
execFileSync('xcrun', ['swiftc', '-O', ...['BoardUtils', 'MoveRules', 'Move', 'FenObject', 'PathConfig'].map(n => resolve(root, `native/core/${n}.swift`)), resolve(work, 'build/main.swift'), '-o', binary], { stdio: 'inherit' });
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = [];
createInterface({ input: child.stdout }).on('line', line => { const next = pending.shift(); try { next?.resolve(JSON.parse(line)); } catch (error) { next?.reject(error); } });
child.on('exit', code => { for (const task of pending.splice(0)) task.reject(new Error(`Proof helper exited ${code}`)); });
child.stdin.on('error', () => {});
const request = input => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(input) + '\n'); });
const save = (name, value) => writeFile(resolve(work, name), JSON.stringify(value, null, 2) + '\n');
const load = name => readFile(resolve(work, name), 'utf8').then(JSON.parse);
const engine = new Engine(undefined, { threads: 1, hashMb: 32 });
try {
  if (stage === 'all' || stage === 'replay') {
    const records = [];
    for (const folder of CCPD_DIRECTORIES) {
      const directory = resolve(upstream, 'Dataset', folder);
      for (const filename of (await readdir(directory)).filter(n => n.endsWith('.pgn')).sort()) {
        const path = `Dataset/${folder}/${filename}`, bytes = await readFile(resolve(upstream, path));
        const record = { path, sha256: sha256(bytes) };
        try {
          const parsed = parsePgn(bytes);
          Object.assign(record, { headers: parsed.headers, initialFen: parsed.fen, plies: parsed.notations.length });
          const result = await request({ id: path, fen: parsed.fen, notations: parsed.notations });
          if (result.error) throw new Error(result.error);
          Object.assign(record, { positions: result.positions, moves: result.moves });
        } catch (error) { record.error = error.message; }
        records.push(record);
        if (records.length % 25 === 0) console.log(`Replayed ${records.length} records; rejected ${records.filter(r => r.error).length}`);
      }
    }
    await save('replay.json', { commit, records });
    console.log(`Replay: ${records.length} records, ${records.filter(r => !r.error).length} valid`);
  }
  if (stage === 'all' || stage === 'screen') {
    const { records } = await load('replay.json'), candidates = [], seen = new Set();
    const previous = await load('screen.json').catch(() => ({ candidates: [] }));
    const cached = new Map(previous.candidates.filter(c => !c.error).map(c => [`${c.sourceSha256}:${c.ply}:${c.fen}`, c]));
    for (const record of records.filter(r => !r.error && ['1-0', '0-1'].includes(r.headers.Result))) {
      const winner = record.headers.Result === '1-0' ? 'r' : 'b';
      const positions = record.positions.map((p, ply) => ({ ...p, ply })).filter(p => p.turn === winner && !p.terminal && !p.inCheck);
      const selected = positions.slice(-5);
      if (positions[0]?.ply === 0 && !selected.includes(positions[0])) selected.unshift(positions[0]);
      for (const position of selected) {
        const identity = symmetryKey(position.fen);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const candidate = { path: record.path, sourceSha256: record.sha256, headers: record.headers, ply: position.ply, fen: position.fen, legalCount: position.legalCount };
        try {
          const old = cached.get(`${candidate.sourceSha256}:${candidate.ply}:${candidate.fen}`);
          if (old) Object.assign(candidate, { score: old.score, pv: old.pv, depth: old.depth, engine: old.engine });
          else {
            const result = await engine.analyze({ initialFen: position.fen, multiPV: 1, movetime: 70 });
            const best = result.lines[0];
            Object.assign(candidate, { score: best.score, pv: best.pv, depth: best.depth, engine: result.engine });
          }
        } catch (error) { candidate.error = error.message; }
        candidates.push(candidate);
        if (candidates.length % 100 === 0) { await save('screen.json', { commit, candidates }); console.log(`Screened ${candidates.length}; short wins ${candidates.filter(c => c.score?.type === 'mate' && c.score.value > 0 && c.score.value <= 3).length}`); }
      }
    }
    await save('screen.json', { commit, candidates });
    console.log(`Screen: ${candidates.length} candidate positions`);
  }
  if (stage === 'all' || stage === 'prove') {
    const { records } = await load('replay.json'), { candidates } = await load('screen.json');
    const proofs = [], imported = [], usedGames = new Set(), seen = new Set(PUZZLES.filter(p => p.source.kind === 'original').map(p => symmetryKey(p.fen)));
    const eligible = candidates.filter(c => c.score?.type === 'mate' && c.score.bound === 'exact' && c.score.value > 0 && c.score.value <= 3)
      .sort((a, b) => a.path.localeCompare(b.path, 'en') || b.score.value - a.score.value || a.ply - b.ply);
    // One position per source game, prefer the longest proved short exercise.
    for (const candidate of eligible) {
      if (usedGames.has(candidate.path) || seen.has(symmetryKey(candidate.fen))) continue;
      const maxPlayerMoves = candidate.score.value;
      const proof = await request({ operation: 'proof', id: `${candidate.path}:${candidate.ply}`, fen: candidate.fen, maxPlayerMoves, nodeLimit: 120000 });
      proofs.push({ path: candidate.path, ply: candidate.ply, fen: candidate.fen, maxPlayerMoves, ...proof });
      if (proof.error || proof.truncated || !proof.win || !proof.solutions?.length) {
        console.log(`Skipped unproved ${candidate.path}:${candidate.ply} (${proof.nodes ?? proof.error})`); continue;
      }
      usedGames.add(candidate.path); seen.add(symmetryKey(candidate.fen));
      const folder = candidate.path.split('/')[1], number = candidate.path.match(/(\d+)\.pgn$/)[1];
      const sourceUrl = `${CCPD_REPOSITORY}/blob/${commit}/${candidate.path.split('/').map(encodeURIComponent).join('/')}`;
      const side = candidate.fen.endsWith(' r') ? '红' : '黑';
      const attackerPieces = candidate.fen.split(' ')[0].replace(/[1-9/]/g, '').split('').filter(c => side === '红' ? c === c.toUpperCase() : c === c.toLowerCase()).join('').toUpperCase();
      const theme = attackerPieces.includes('R') ? attackerPieces.includes('N') ? '车马' : attackerPieces.includes('C') ? '车炮' : (attackerPieces.match(/R/g)?.length ?? 0) === 2 ? '双车' : '车兵'
        : attackerPieces.includes('N') ? attackerPieces.includes('C') ? '马炮' : '马兵' : attackerPieces.includes('C') ? (attackerPieces.match(/C/g)?.length ?? 0) === 2 ? '双炮' : '炮兵' : '兵卒';
      imported.push({ id: `ccpd-${folder === '殘局' ? 'endgame' : 'tactics'}-${Number(number)}-p${candidate.ply}`, title: `实战${folder === '殘局' ? '残局' : '杀法'} ${Number(number)} · ${side}先`,
        theme, difficulty: ['入门','基础','进阶'][maxPlayerMoves - 1], rating: [850,1200,1550][maxPlayerMoves - 1], fen: candidate.fen, goal: 'mate', maxPlayerMoves,
        hint: `先检查将军、吃子和封住将帅退路的着法。你需要在${maxPlayerMoves}手内取胜，并考虑对方的所有合法应对。`,
        explanation: `这是从CCPD实战棋谱截取的局面。展示的是重新验证的${maxPlayerMoves}手内必胜变化，可能与原棋谱续着不同；将死或困毙均计胜。题目难度为本地估计。`,
        source: { kind: 'ccpd', label: 'CCPD 实战棋谱 · CC BY 4.0', authors: 'Yu-Han Tseng and Bo-Nian Chen (2026)', url: sourceUrl, repository: CCPD_REPOSITORY, commit, path: candidate.path, sha256: candidate.sourceSha256,
          sourcePly: candidate.ply, event: candidate.headers.Event, red: candidate.headers.Red, black: candidate.headers.Black, date: candidate.headers.Date,
          license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: 'Big5解码、完整合法性回放、截取局面、镜像/换色去重、重新穷举全部限手必胜变化；中文题目、提示和难度为本项目新增。' },
        solutions: proof.solutions });
      console.log(`Accepted ${imported.length}: ${candidate.path}:${candidate.ply}, ${maxPlayerMoves} moves, ${proof.solutions.length} paths, ${proof.nodes} nodes`);
      await save('proofs.json', { commit, proofs });
    }
    const dataset = { version: '2026-10-12.1', repository: CCPD_REPOSITORY, commit, puzzles: imported };
    await writeFile(resolve(root, 'server/ccpd-puzzles.json'), JSON.stringify(dataset, null, 2) + '\n');
    const report = { commit, repository: CCPD_REPOSITORY, encoding: 'Big5', directories: CCPD_DIRECTORIES, sourceRecords: records.length, replayValid: records.filter(r => !r.error).length,
      rejectedRecords: records.filter(r => r.error).map(({ path, sha256, error }) => ({ path, sha256, error })), screenedPositions: candidates.length, shortWinCandidates: eligible.length,
      proofAttempts: proofs.length, rejectedProofs: proofs.filter(p => p.error || p.truncated || !p.win || !p.solutions?.length).map(({ solutions, ...proof }) => proof), imported: imported.length,
      totalSolutionPaths: imported.reduce((sum, p) => sum + p.solutions.length, 0), byMoveBudget: Object.fromEntries([1,2,3].map(n => [n, imported.filter(p => p.maxPlayerMoves === n).length])), blackToMove: imported.filter(p => p.fen.endsWith(' b')).length,
      acceptedProofs: imported.map(p => { const q = proofs.find(q => q.path === p.source.path && q.ply === p.source.sourcePly && q.win && !q.truncated); return { id: p.id, path: q.path, sourceSha256: p.source.sha256, sourcePly: q.ply, maxPlayerMoves: q.maxPlayerMoves, proofNodes: q.nodes, proofStates: q.states, paths: q.solutions.length, truncated: q.truncated }; }),
      datasetSha256: sha256(await readFile(resolve(root, 'server/ccpd-puzzles.json'))), ruleSourceSha256: sha256(source), engine: candidates.find(c => c.engine)?.engine,
      method: 'One position per replay-valid source game; engine screening at 70ms is only a candidate selector. Accepted trees are exhaustive finite-horizon AND/OR proofs, including every winning player move and all legal defenses. Truncated proofs are rejected. Checkmate and stalemate both win.' };
    await writeFile(resolve(root, 'validation/2026-10-12-ccpd-import.json'), JSON.stringify(report, null, 2) + '\n');
    await save('proofs.json', { commit, proofs });
    console.log(JSON.stringify({ imported: report.imported, totalSolutionPaths: report.totalSolutionPaths, byMoveBudget: report.byMoveBudget, rejectedRecords: report.rejectedRecords.length, proofAttempts: report.proofAttempts }));
  }
} finally { engine.close(); child.stdin.end(); }
