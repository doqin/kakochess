import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  // onnxruntime-web loads .wasm files at runtime via fetch — we must exclude it
  // from bundling so its own worker/wasm path resolution stays intact.
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  // REMOVED COOP/COEP headers. 
  // We use ort.env.wasm.numThreads = 1 to avoid needing SharedArrayBuffer,
  // which allows us to load external piece images from chessboardjs.com.
});
