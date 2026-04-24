/**
 * onnx-engine.js
 * Loads chess_model.onnx from the backend and exposes evaluateBoard(fen).
 * Runs entirely in the browser via onnxruntime-web — no server round-trip.
 *
 * Input:  Float32Array of length 768 (64 squares × 12 piece channels)
 * Output: scalar in [-1, 1] from side-to-move perspective
 *         (1 = side-to-move is better, -1 = side-to-move is worse)
 */

import * as ort from 'onnxruntime-web';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// Use the wasm backend (works everywhere; 'webgl' is faster if available)
ort.env.wasm.numThreads = 1; // keep simple — avoids SharedArrayBuffer requirement

let _session = null;     // cached InferenceSession
let _loadPromise = null; // singleton loading promise
let _modelVersion = null;
const EVAL_CACHE = new Map(); // FEN -> score
const DEVICE_MEMORY_GB = (typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number')
  ? navigator.deviceMemory
  : null;
const MAX_EVAL_CACHE = DEVICE_MEMORY_GB && DEVICE_MEMORY_GB <= 2
  ? 256
  : DEVICE_MEMORY_GB && DEVICE_MEMORY_GB <= 4
    ? 768
    : 2000;

export function getOnnxStatus() {
  if (_session) return 'ready';
  if (_loadPromise) return 'loading';
  return 'idle';
}

export function getOnnxModelVersion() {
  return _modelVersion;
}

export function clearEvalCache() {
  EVAL_CACHE.clear();
}

export async function releaseOnnxModel() {
  clearEvalCache();
  if (_session && typeof _session.release === 'function') {
    await _session.release();
  }
  _session = null;
  _loadPromise = null;
}

export async function loadOnnxModel(options = {}) {
  const forceReload = !!options.force;
  if (forceReload) {
    await releaseOnnxModel();
  }

  if (_session) return _session;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const bust = forceReload ? `?t=${Date.now()}` : '';
      const url = `${API_URL}/model${bust}`;
      console.log('[ONNX] Fetching model from', url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      _modelVersion = resp.headers.get('x-model-version') || null;
      const buffer = await resp.arrayBuffer();
      _session = await ort.InferenceSession.create(buffer, {
        executionProviders: ['wasm'],
      });
      clearEvalCache();
      console.log('[ONNX] Model loaded ✓');
      return _session;
    } catch (err) {
      _loadPromise = null; // allow retry
      console.error('[ONNX] Failed to load model:', err);
      throw err;
    }
  })();

  return _loadPromise;
}

/**
 * Converts a FEN string into a Float32Array of length 768.
 * Mirrors the Python fen_to_tensor() function in bot.py exactly.
 */
function fenToTensor(fen) {
  const pieceIndex = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
  const data = new Float32Array(768);
  const parts = fen.split(' ');
  const rows = parts[0].split('/');
  const turn = parts[1]; // 'w' or 'b'

  for (let rank = 7; rank >= 0; rank--) {
    const row = rows[7 - rank];
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch);
      } else {
        const lower = ch.toLowerCase();
        const isWhite = ch === ch.toUpperCase();
        
        // Perspective logic: Are these 'my' pieces?
        const isMyPiece = (turn === 'w' && isWhite) || (turn === 'b' && !isWhite);
        const colorOffset = isMyPiece ? 0 : 6;
        
        // Keep contract parity with backend: python-chess square index for
        // black-to-move positions is remapped with sq ^ 56.
        const absSquare = rank * 8 + file;
        const square = (turn === 'w') ? absSquare : (absSquare ^ 56);
        
        const idx = square * 12 + (pieceIndex[lower] + colorOffset);
        data[idx] = 1.0;
        file++;
      }
    }
  }
  return data;
}

/**
 * Evaluate a board position using the ONNX model.
 * Loads the model on first call (cached for subsequent calls).
 * Returns a value in [-1, 1]. Throws if model unavailable.
 */
export async function evaluateBoard(fen) {
  // 1. Check cache first
  if (EVAL_CACHE.has(fen)) return EVAL_CACHE.get(fen);

  const session = await loadOnnxModel();
  const inputData = fenToTensor(fen);
  // Model contract: [batch, 64, 12]
  const tensor = new ort.Tensor('float32', inputData, [1, 64, 12]);
  const feeds = { board: tensor };
  const results = await session.run(feeds);
  const output = results['value'];
  if (!output || !output.data || output.data.length === 0) {
    const names = Object.keys(results || {});
    throw new Error(`[ONNX] Missing output tensor 'value'. Available outputs: ${names.join(', ')}`);
  }
  const val = output.data[0];
  if (!Number.isFinite(val)) {
    throw new Error('[ONNX] Non-finite value returned by model output tensor.');
  }

  // 2. Store in cache with adaptive memory cap
  if (EVAL_CACHE.size >= MAX_EVAL_CACHE) {
    const firstKey = EVAL_CACHE.keys().next().value;
    EVAL_CACHE.delete(firstKey);
  }
  EVAL_CACHE.set(fen, val);

  return val;
}
