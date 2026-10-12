// Only animate a single identifiable move, never a board load or a multi-move jump.
export function movedPiece(before, after) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(square => before[square] !== after[square]);
  if (changed.length !== 2) return null;
  const from = changed.find(square => before[square] && !after[square]);
  const to = changed.find(square => square !== from && after[square] === before[from]);
  return from && to ? { from, to, piece: before[from], captured: before[to] ?? null } : null;
}

export function boardCell(square, flipped = false) {
  const file = square.charCodeAt(0) - 97, rank = Number(square[1]);
  return { column: flipped ? 8 - file : file, row: flipped ? rank : 9 - rank };
}

const samePieces = (a, b) => Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(square => a[square] === b[square]);

export class BoardMotion {
  constructor({ board, squares, createPiece, effects, onSettled = () => {},
    reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches }) {
    Object.assign(this, { board, squares, createPiece, effects, onSettled, reducedMotion });
    this.frame = null;
    this.flight = null;
  }

  get active() { return !!this.flight; }
  whenIdle() { return this.flight?.settled ?? Promise.resolve(); }
  target(square) { return this.squares.querySelector(`[data-square="${square}"]`); }

  update({ pieces, context, flipped }) {
    const previous = this.frame;
    const continuous = previous?.context === context && previous.flipped === flipped;
    if (continuous && samePieces(previous.pieces, pieces)) {
      // Saving, scoring and lesson updates must not restart the existing flight.
      if (this.flight) this.target(this.flight.move.to)?.classList.add('motion-target');
      return;
    }
    const move = continuous && movedPiece(previous.pieces, pieces);
    this.cancel({ preserveImpact: !!move && !this.flight && !this.reducedMotion() });
    this.frame = { pieces: { ...pieces }, context, flipped };
    if (!move || this.reducedMotion()) return;
    const from = boardCell(move.from, flipped), to = boardCell(move.to, flipped);
    const mover = this.layer(move.piece, to, 'piece-flight');
    if (!mover.animate) { mover.remove(); return; }
    const captured = move.captured ? this.layer(move.captured, to, 'piece-captured') : null;
    this.target(move.to)?.classList.add('motion-target');
    const animation = mover.animate([
      { transform: `translate(${(from.column - to.column) * 100}%, ${(from.row - to.row) * 100}%)` },
      { transform: 'translate(0%, 0%)' },
    ], { duration: 380, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'both' });
    const flight = { move, mover, captured, animation, to };
    this.flight = flight;
    this.effects?.start(move, from, to);
    flight.settled = animation.finished.then(() => this.finish(flight), () => this.finish(flight));
  }

  layer(piece, cell, className) {
    const layer = this.board.ownerDocument.createElement('div');
    layer.className = className;
    layer.setAttribute('aria-hidden', 'true');
    layer.style.left = `${cell.column * 100 / 9}%`;
    layer.style.top = `${cell.row * 10}%`;
    layer.append(this.createPiece(piece));
    this.board.append(layer);
    return layer;
  }

  clear(flight) {
    this.target(flight.move.to)?.classList.remove('motion-target');
    flight.mover.remove(); flight.captured?.remove();
  }
  finish(flight) {
    if (this.flight !== flight) return;
    this.flight = null; this.clear(flight);
    this.effects?.land(flight.move, flight.to);
    this.onSettled();
  }
  cancel({ preserveImpact = false } = {}) {
    if (preserveImpact && this.effects?.cancelFlight) this.effects.cancelFlight();
    else this.effects?.clear();
    const flight = this.flight;
    if (!flight) return;
    this.flight = null; this.clear(flight); flight.animation.cancel();
  }
}
