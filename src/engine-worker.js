/**
 * engine-worker.js
 * Web Worker for the Kakochess engine.
 * Offloads alpha-beta search from the main thread to prevent UI lag.
 */

import { getBestMove } from './chess-engine.js';
import {
  clearEvalCache,
  getOnnxModelVersion,
  loadOnnxModel,
  releaseOnnxModel,
} from './onnx-engine.js';

// Setup listener for incoming requests
self.onmessage = async (e) => {
  const { type, payload, id } = e.data;

  if (type === 'GET_BEST_MOVE') {
    const { fen, options } = payload;
    try {
      const move = await getBestMove(fen, options);
      self.postMessage({ id, type: 'MOVE_RESULT', payload: move });
    } catch (err) {
      console.error('[Worker] Search failed:', err);
      self.postMessage({ id, type: 'ERROR', payload: err.message });
    }
  } else if (type === 'LOAD_MODEL') {
    try {
      const force = !!payload?.force;
      console.log('[Worker] Loading ONNX model...');
      await loadOnnxModel({ force });
      self.postMessage({
        id,
        type: 'MODEL_READY',
        payload: { version: getOnnxModelVersion() }
      });
    } catch (err) {
      console.error('[Worker] Model load failed:', err);
      self.postMessage({ id, type: 'ERROR', payload: err.message });
    }
  } else if (type === 'TRIM_MEMORY') {
    try {
      const hard = !!payload?.hard;
      if (hard) {
        await releaseOnnxModel();
      } else {
        clearEvalCache();
      }
      self.postMessage({ id, type: 'MEMORY_TRIMMED', payload: { hard } });
    } catch (err) {
      self.postMessage({ id, type: 'ERROR', payload: err.message });
    }
  }
};

// Start loading the model immediately in the worker thread
loadOnnxModel()
  .then(() => self.postMessage({
    type: 'MODEL_READY',
    payload: { version: getOnnxModelVersion() }
  }))
  .catch((err) => self.postMessage({ type: 'ERROR', payload: err.message }));
