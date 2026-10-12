import { boardCell } from './board-motion.mjs';
import { PIECE_NAMES } from './setup-board.mjs';

const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const attribute = (node, name, value) => {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
};

// Keep square buttons and stationary pieces mounted through save/engine updates.
export class BoardSquares {
  constructor({ root, createPiece, onSelect }) {
    Object.assign(this, { root, createPiece });
    this.cells = new Map();
    this.pieces = {};
    for (let row = 0; row < 10; row++) for (let column = 0; column < 9; column++) {
      const square = String.fromCharCode(97 + column) + (9 - row);
      const button = root.ownerDocument.createElement('button');
      button.className = 'square'; button.dataset.square = square;
      button.onclick = () => onSelect(square);
      button.onkeydown = event => {
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[event.key];
        if (offset === undefined) return;
        event.preventDefault();
        const cell = boardCell(square, this.flipped), index = cell.row * 9 + cell.column;
        root.children[Math.max(0, Math.min(89, index + offset))]?.focus();
      };
      this.cells.set(square, button); root.append(button);
    }
    this.flipped = false;
  }

  update({ pieces, flipped, active, selected, allowed, last }) {
    if (this.flipped !== flipped) {
      this.flipped = flipped;
      const ordered = [...this.cells].sort(([a], [b]) => {
        const aa = boardCell(a, flipped), bb = boardCell(b, flipped);
        return (aa.row - bb.row) * 9 + aa.column - bb.column;
      });
      for (const [, button] of ordered) this.root.append(button);
    }
    for (const [square, button] of this.cells) {
      const piece = pieces[square], x = square.charCodeAt(0) - 97, y = Number(square[1]);
      button.disabled = !active;
      button.classList.toggle('selected', square === selected);
      button.classList.toggle('legal', allowed.has(square));
      button.classList.toggle('last-from', square === last?.slice(0, 2));
      button.classList.toggle('last-to', square === last?.slice(2));
      const label = piece ? `${piece[0] === 'r' ? '红方' : '黑方'}${numerals[piece[0] === 'r' ? 8 - x : x]}路${PIECE_NAMES[piece]}` : `${numerals[8 - x]}路，第${y + 1}横线空位`;
      attribute(button, 'aria-label', label + (allowed.has(square) ? '，可落子' : '') + (square === last?.slice(0, 2) ? '，上一步起点' : square === last?.slice(2) ? '，上一步落点' : ''));
      attribute(button, 'aria-pressed', String(square === selected));
      if (piece !== this.pieces[square]) button.replaceChildren(...(piece ? [this.createPiece(piece)] : []));
    }
    this.pieces = { ...pieces };
  }
}
