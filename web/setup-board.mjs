export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r';
export const PIECE_NAMES = { rK: '帅', rA: '仕', rB: '相', rN: '马', rR: '车', rC: '炮', rP: '兵', bK: '将', bA: '士', bB: '象', bN: '马', bR: '车', bC: '炮', bP: '卒' };

export function piecesFromFen(fen) {
  const pieces = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let x = 0;
    for (const char of row) {
      if (/\d/.test(char)) { x += Number(char); continue; }
      pieces[String.fromCharCode(97 + x) + (9 - i)] = (char === char.toUpperCase() ? 'r' : 'b') + char.toUpperCase();
      x++;
    }
  });
  return pieces;
}

export function fenFromPieces(pieces, turn) {
  const rows = [];
  for (let y = 9; y >= 0; y--) {
    let row = '', empty = 0;
    for (let x = 0; x < 9; x++) {
      const piece = pieces[String.fromCharCode(97 + x) + y];
      if (!piece) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += piece[0] === 'r' ? piece[1] : piece[1].toLowerCase();
    }
    rows.push(row + (empty || ''));
  }
  return rows.join('/') + ' ' + turn;
}

// A draft may temporarily be illegal. Only new_game's authoritative rules
// can accept it as an engine position; editing never rewrites a saved game.
export class SetupDraft {
  constructor(fen = START_FEN) {
    this.pieces = piecesFromFen(fen); this.turn = fen.split(' ')[1] === 'b' ? 'b' : 'r';
    this.tool = 'move'; this.selected = null; this.history = [];
  }
  get fen() { return fenFromPieces(this.pieces, this.turn); }
  change(action) {
    const before = this.fen;
    action();
    if (this.fen !== before) this.history.push(before);
    this.selected = null;
  }
  replace(fen) { this.change(() => { this.pieces = piecesFromFen(fen); this.turn = fen.split(' ')[1] === 'b' ? 'b' : 'r'; }); }
  setTurn(turn) { this.change(() => { this.turn = turn; }); }
  undo() {
    const fen = this.history.pop();
    if (fen) { this.pieces = piecesFromFen(fen); this.turn = fen.split(' ')[1]; }
    this.selected = null;
  }
  choose(tool) { this.tool = tool; this.selected = null; }
  click(square) {
    if (!/^[a-i][0-9]$/.test(square)) return;
    if (this.tool === 'erase') this.change(() => { delete this.pieces[square]; });
    else if (PIECE_NAMES[this.tool]) this.change(() => { this.pieces[square] = this.tool; });
    else if (this.selected && this.selected !== square) {
      const from = this.selected;
      this.change(() => { this.pieces[square] = this.pieces[from]; delete this.pieces[from]; });
    } else this.selected = this.pieces[square] && this.selected !== square ? square : null;
  }
}
