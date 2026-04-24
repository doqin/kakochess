import { evaluateBoard, loadOnnxModel } from './onnx-engine.js';
import { getZobristHash } from './zobrist.js';
import { evaluateBoardSync } from './evaluation.js';

// ---------------------------------------------------------------------------
// Constants & State
// ---------------------------------------------------------------------------
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const TT_SIZE = 1048576; // 2^20 entries (~32MB)
const TT_KEYS = new BigUint64Array(TT_SIZE);
const TT_DATA = new Float32Array(TT_SIZE); // Score
const TT_DEPTH = new Uint8Array(TT_SIZE);
const TT_FLAGS = new Uint8Array(TT_SIZE); // 0: None, 1: EXACT, 2: ALPHA, 3: BETA

let nodeCount = 0;
let stopSearch = false;
let startTimeSearch = 0;
let timeLimitSearch = 0;
let warnedNNFailure = false;

function ttPut(hash, value, depth, flag) {
  const idx = Number(hash % BigInt(TT_SIZE));
  TT_KEYS[idx] = hash;
  TT_DATA[idx] = value;
  TT_DEPTH[idx] = depth;
  TT_FLAGS[idx] = flag;
}

function ttGet(hash, depth) {
  const idx = Number(hash % BigInt(TT_SIZE));
  if (TT_KEYS[idx] === hash && TT_DEPTH[idx] >= depth) {
    return { value: TT_DATA[idx], flag: TT_FLAGS[idx] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Move Ordering
// ---------------------------------------------------------------------------
function orderMoves(game, moves) {
  return moves.map(m => {
    let score = 0;
    if (m.captured) {
      score = 1000 + (PIECE_VALUES[m.captured] * 10) - PIECE_VALUES[m.type];
    }
    if (m.promotion === 'q') score += 900;
    if (game.inCheck()) score += 50;
    return { move: m, score };
  }).sort((a, b) => b.score - a.score).map(x => x.move);
}

// ---------------------------------------------------------------------------
// Search Logic
// ---------------------------------------------------------------------------

function searchRecursive(game, depth, alpha, beta, hash) {
  nodeCount++;
  
  if (nodeCount % 1024 === 0) {
    if (Date.now() - startTimeSearch > timeLimitSearch) stopSearch = true;
  }
  if (stopSearch) return 0;

  const tt = ttGet(hash, depth);
  if (tt) {
    if (tt.flag === 1) return tt.value;
    if (tt.flag === 2 && tt.value <= alpha) return alpha;
    if (tt.flag === 3 && tt.value >= beta) return beta;
  }

  if (game.isGameOver()) {
    if (game.isCheckmate()) return -20000 - depth;
    return 0;
  }
  
  if (depth === 0) {
    return evaluateBoardSync(game);
  }

  let moves = orderMoves(game, game.moves({ verbose: true }));
  if (moves.length === 0) return game.isCheck() ? -20000 : 0;

  let bestVal = -Infinity;
  let oldAlpha = alpha;

  for (const move of moves) {
    game.move(move);
    const nextHash = getZobristHash(game);
    const val = -searchRecursive(game, depth - 1, -beta, -alpha, nextHash);
    game.undo();

    if (stopSearch) return 0;

    if (val > bestVal) {
      bestVal = val;
      if (val > alpha) {
        alpha = val;
      }
    }
    if (alpha >= beta) break; 
  }

  let flag = 1; // EXACT
  if (bestVal <= oldAlpha) flag = 2; // ALPHA (Upper bound)
  else if (bestVal >= beta) flag = 3; // BETA (Lower bound)
  ttPut(hash, bestVal, depth, flag);

  return bestVal;
}

/**
 * Refines the search result using the custom ONNX model.
 */
async function refineWithNN(game, candidates) {
  if (!candidates || candidates.length === 0) return null;
  const results = [];
  
  for (const cand of candidates) {
    game.move(cand.move);
    try {
      const score = await evaluateBoard(game.fen());
      results.push({ move: cand.move, score });
    } catch (e) {
      if (!warnedNNFailure) {
        warnedNNFailure = true;
        console.warn('[Engine] ONNX refinement unavailable, using search-only scores.', e);
      }
      results.push({ move: cand.move, score: 0 });
    }
    game.undo();
  }

  // Sort by NN score (Model already returns score from perspective of side-to-move)
  results.sort((a, b) => b.score - a.score);
  return results[0].move;
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export async function getBestMove(fen, options = {}) {
  // Direct import to avoid window issue if in worker
  const { Chess } = await import('chess.js');
  const game = new Chess(fen);
  
  const legalMoves = game.moves({ verbose: true });
  if (legalMoves.length === 0) return null;

  // 1. Epsilon-greedy exploration (Essential for discovery during training)
  if (options.isTraining && options.epsilon !== undefined) {
    if (Math.random() < options.epsilon) {
      console.log(`[Engine] Epsilon-greedy move triggered (ε=${options.epsilon})`);
      const r = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      return r.from + r.to + (r.promotion || '');
    }
  }

  // 2. Setup Search
  nodeCount = 0;
  stopSearch = false;
  startTimeSearch = Date.now();
  timeLimitSearch = options.timeLimit || 5000;
  const depthLimit = options.depth || 4;

  let bestMoveFound = legalMoves[0];
  let candidatesForNN = [];

  // 2. Iterative Deepening (Synchronous Search Cycles)
  for (let d = 1; d <= depthLimit; d++) {
    const moves = orderMoves(game, legalMoves);
    let bestVal = -Infinity;
    let localBestMove = moves[0];
    let results = [];

    for (const move of moves) {
      game.move(move);
      const val = -searchRecursive(game, d - 1, -100000, 100000, getZobristHash(game));
      game.undo();

      if (stopSearch) break;
      results.push({ move, val });
      if (val > bestVal) {
        bestVal = val;
        localBestMove = move;
      }
    }

    if (stopSearch && d > 1) break; // Use previous depth result
    
    bestMoveFound = localBestMove;
    candidatesForNN = results.sort((a, b) => b.val - a.val).slice(0, 3);
    
    console.log(`[Engine] Depth ${d} complete. Best: ${bestMoveFound.from}${bestMoveFound.to}, Val: ${bestVal}`);
  }

  // 3. Final Step: Pick the best of top candidates using the custom ONNX model
  console.log(`[Engine] Refining ${candidatesForNN.length} candidates with ONNX...`);
  const refinedMove = await refineWithNN(game, candidatesForNN);
  const finalMove = refinedMove || bestMoveFound;

  const duration = Date.now() - startTimeSearch;
  const nps = Math.round(nodeCount / (duration / 1000)) || 0;
  console.log(`[Engine] Search complete. Nodes: ${nodeCount}, Time: ${duration}ms, NPS: ${nps}`);

  return finalMove.from + finalMove.to + (finalMove.promotion || '');
}

// Warm up model
loadOnnxModel().catch(() => {});
