/**
 * zobrist.js
 * High-performance Zobrist Hashing for Kakochess.
 * Uses 64-bit BigInts to generate near-unique keys for board positions.
 */

const pieceKeys = new BigUint64Array(12 * 64);
const sideKey = new BigUint64Array(1);
const castlingKeys = new BigUint64Array(4); // WK, WQ, BK, BQ
const epKeys = new BigUint64Array(8); // Files a-h

// ---------------------------------------------------------------------------
// INITIALIZATION
// ---------------------------------------------------------------------------

function initZobrist() {
  const randomArray = new BigUint64Array(12 * 64 + 1 + 4 + 8);
  crypto.getRandomValues(randomArray);

  let i = 0;
  for (let j = 0; j < 12 * 64; j++) pieceKeys[j] = randomArray[i++];
  sideKey[0] = randomArray[i++];
  for (let j = 0; j < 4; j++) castlingKeys[j] = randomArray[i++];
  for (let j = 0; j < 8; j++) epKeys[j] = randomArray[i++];
}

initZobrist();

const PIECE_MAP = {
  'p': 0, 'n': 1, 'b': 2, 'r': 3, 'q': 4, 'k': 5,
  'P': 6, 'N': 7, 'B': 8, 'R': 9, 'Q': 10, 'K': 11
};

/**
 * Calculates the Zobrist hash from scratch for a chess.js object.
 */
export function getZobristHash(game) {
  let hash = 0n;
  const board = game.board();

  // 1. Pieces
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (piece) {
        const pIdx = PIECE_MAP[piece.color === 'w' ? piece.type.toUpperCase() : piece.type];
        const sqIdx = r * 8 + f;
        hash ^= pieceKeys[pIdx * 64 + sqIdx];
      }
    }
  }

  // 2. Side to move
  if (game.turn() === 'b') hash ^= sideKey[0];

  // 3. Castling
  const fenParts = game.fen().split(' ');
  const castling = fenParts[2];
  if (castling !== '-') {
    if (castling.includes('K')) hash ^= castlingKeys[0];
    if (castling.includes('Q')) hash ^= castlingKeys[1];
    if (castling.includes('k')) hash ^= castlingKeys[2];
    if (castling.includes('q')) hash ^= castlingKeys[3];
  }

  // 4. En Passant
  const ep = fenParts[3];
  if (ep !== '-') {
    const file = ep.charCodeAt(0) - 97; // 'a' = 97
    hash ^= epKeys[file];
  }

  return hash;
}
