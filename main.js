import './style.css';
import { Chess } from 'chess.js';
// import { getBestMove as browserGetBestMove } from './src/chess-engine.js';
// import { getOnnxStatus, loadOnnxModel } from './src/onnx-engine.js';

// Web Worker instance
const engineWorker = new Worker(new URL('./src/engine-worker.js', import.meta.url), {
  type: 'module'
});

const IS_LOW_MEMORY_DEVICE = (typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number')
  ? navigator.deviceMemory <= 4
  : false;
const MAX_FEN_HISTORY = IS_LOW_MEMORY_DEVICE ? 256 : 512;
const MAX_LOSS_POINTS = IS_LOW_MEMORY_DEVICE ? 120 : 300;
const MODEL_POLL_INTERVAL_MS = IS_LOW_MEMORY_DEVICE ? 60000 : 30000;

const workerCall = (type, payload) => {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).substring(7);
    const timeoutMs = type === 'GET_BEST_MOVE' ? 30000 : 10000;
    const handler = (e) => {
      if (e.data.id === id) {
        clearTimeout(timer);
        engineWorker.removeEventListener('message', handler);
        if (e.data.type === 'ERROR') reject(new Error(e.data.payload));
        else resolve(e.data.payload);
      }
    };
    const timer = setTimeout(() => {
      engineWorker.removeEventListener('message', handler);
      reject(new Error(`[Worker] Timeout waiting for ${type}`));
    }, timeoutMs);
    engineWorker.addEventListener('message', handler);
    engineWorker.postMessage({ type, payload, id });
  });
};

let currentOnnxStatus = 'loading';
let currentOnnxVersion = null;
let modelSyncInFlight = false;

/**
 * Updates the bot's visual avatar based on game state.
 * @param {'wait' | 'think' | 'capture' | 'blunder'} state 
 */
function updateAvatar(state) {
  const $box = $('.avatar-box');
  const $img = $('#botAvatar');
  if (!$box.length || !$img.length) return;

  $box.removeClass('thinking');
  if (state === 'think') $box.addClass('thinking');

  $img.attr('src', `/${state}.png`);
  console.log('[Avatar] State updated to:', state);
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

const OPENINGS = {
  standard: { name: 'Standard', moves: [] },
  ruyLopez: { name: 'Ruy Lopez', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
  sicilian: { name: 'Sicilian Defense', moves: ['e4', 'c5'] },
  queensGambit: { name: 'Queen\'s Gambit', moves: ['d4', 'd5', 'c4'] },
  french: { name: 'French Defense', moves: ['e4', 'e6'] },
  caroKann: { name: 'Caro-Kann', moves: ['e4', 'c6'] },
  italian: { name: 'Italian Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  scandi: { name: 'Scandinavian', moves: ['e4', 'd5'] },
  indian: { name: 'King\'s Indian', moves: ['d4', 'Nf6', 'c4', 'g6'] },
  slav: { name: 'Slav Defense', moves: ['d4', 'd5', 'c4', 'c6'] }
};

let board = null;
let selectedSquare = null;
let game = new Chess();
let fenHistory = [];
let isSelfPlay = false;
let cachedBase64Credentials = null;
// Scenario Management State
let currentScenario = null;
let autoResetMode = false;
let capturedByWhite = [];
let capturedByBlack = [];

function pushFenHistory(fen) {
  fenHistory.push(fen);
  if (fenHistory.length > MAX_FEN_HISTORY) {
    fenHistory.shift();
  }
}

function pushLossPoint(loss) {
  if (!lossChart) return;
  lossChart.data.labels.push(lossChart.data.labels.length + 1);
  lossChart.data.datasets[0].data.push(loss);

  if (lossChart.data.labels.length > MAX_LOSS_POINTS) {
    const over = lossChart.data.labels.length - MAX_LOSS_POINTS;
    lossChart.data.labels.splice(0, over);
    lossChart.data.datasets[0].data.splice(0, over);
  }
}

function updateCapturedPiecesUI() {
  const $whiteCol = $('#captured-by-white');
  const $blackCol = $('#captured-by-black');
  if (!$whiteCol.length || !$blackCol.length) return;

  const renderPieces = (pieces, $container) => {
    $container.empty();
    
    // Group pieces by type
    const counts = {};
    pieces.forEach(p => {
      counts[p.type] = (counts[p.type] || 0) + 1;
    });
    
    // Sort keys by priority: Pawn, Knight, Bishop, Rook, Queen
    const order = { p: 0, n: 1, b: 2, r: 3, q: 4 };
    const types = Object.keys(counts).sort((a, b) => order[a] - order[b]);

    types.forEach(type => {
      const p = pieces.find(x => x.type === type);
      const pieceStr = p.color + p.type.toUpperCase();
      const url = `https://chessboardjs.com/img/chesspieces/wikipedia/${pieceStr}.png`;
      const count = counts[type];
      
      const $item = $(`
        <div class="captured-item">
          <img src="${url}" class="captured-piece" alt="${pieceStr}" />
          ${count > 1 ? `<span class="captured-count">×${count}</span>` : ''}
        </div>
      `);
      $container.append($item);
    });
  };

  renderPieces(capturedByWhite, $whiteCol);
  renderPieces(capturedByBlack, $blackCol);
}

function generateEndgame(scenario = 'random') {
  const tempGame = new Chess();
  tempGame.clear();

  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      squares.push(String.fromCharCode(97 + f) + (r + 1));
    }
  }

  const getRandomEmpty = (g) => {
    let sq;
    let attempts = 0;
    do {
      sq = squares[Math.floor(Math.random() * squares.length)];
      attempts++;
    } while (g.get(sq) && attempts < 100);
    return sq;
  };

  const isAdjacent = (s1, s2) => {
    const f1 = s1.charCodeAt(0), r1 = parseInt(s1[1]);
    const f2 = s2.charCodeAt(0), r2 = parseInt(s2[1]);
    return Math.abs(f1 - f2) <= 1 && Math.abs(r1 - r2) <= 1;
  };

  // Place Kings
  let wk = squares[Math.floor(Math.random() * squares.length)];
  let bk;
  do {
    bk = squares[Math.floor(Math.random() * squares.length)];
  } while (isAdjacent(wk, bk) || wk === bk);

  tempGame.put({ type: 'k', color: 'w' }, wk);
  tempGame.put({ type: 'k', color: 'b' }, bk);

  const selectedType = scenario === 'random' ? ['pawn', 'rook', 'queen'][Math.floor(Math.random() * 3)] : scenario;

  if (selectedType === 'pawn') {
    const numP = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < numP; i++) {
      let sq = getRandomEmpty(tempGame);
      if (sq[1] !== '1' && sq[1] !== '8') tempGame.put({ type: 'p', color: 'w' }, sq);
    }
    const numBP = Math.floor(Math.random() * 2);
    for (let i = 0; i < numBP; i++) {
      let sq = getRandomEmpty(tempGame);
      if (sq[1] !== '1' && sq[1] !== '8') tempGame.put({ type: 'p', color: 'b' }, sq);
    }
  } else if (selectedType === 'rook') {
    tempGame.put({ type: 'r', color: 'w' }, getRandomEmpty(tempGame));
    if (Math.random() > 0.7) tempGame.put({ type: 'p', color: 'b' }, getRandomEmpty(tempGame));
  } else if (selectedType === 'queen') {
    tempGame.put({ type: 'q', color: 'w' }, getRandomEmpty(tempGame));
  }

  // Ensure side to move is NOT already in check (makes it a legal start)
  let finalFen = tempGame.fen();
  // Random turn
  if (Math.random() > 0.5) finalFen = finalFen.replace(' w ', ' b ');

  return finalFen;
}

function startScenario(type) {
  const fen = generateEndgame(type);
  currentScenario = type;
  game.load(fen);
  board.position(fen);
  fenHistory = [game.fen()];
  updateStatus();
  updateAvatar('wait');
  console.log('[Scenario] Started:', type, fen);
  if (isSelfPlay && !game.isGameOver()) {
    setTimeout(getBotMove, 250);
  }
}
let lossChart = null; // Chart.js instance

// ---------------------------------------------------------------------------
// Difficulty Mapping
// ---------------------------------------------------------------------------
const DIFFICULTY_CONFIGS = {
  casual: { depth: 2, randomness: 0.15, isTraining: false },
  intermediate: { depth: 3, randomness: 0.05, isTraining: false },
  competitive: { depth: 4, randomness: 0, isTraining: false }
};

function getBotOptions() {
  const isAdmin = !!window.IS_ADMIN_MODE;
  if (isAdmin) {
    const epsilon = parseFloat(document.getElementById('epsilonInput')?.value || '0.25');
    const depth = parseInt(document.getElementById('depthInput')?.value || '2');
    const options = { depth: depth, randomness: 0.01, isTraining: true, epsilon: epsilon };
    console.log('[Engine] Admin Mode Search Options:', options);
    return options;
  }

  const difficulty = document.getElementById('difficultySelect')?.value || 'intermediate';
  return DIFFICULTY_CONFIGS[difficulty];
}

// ---------------------------------------------------------------------------
// ONNX status badge
// ---------------------------------------------------------------------------
function updateOnnxBadge(status, msg) {
  const badge = document.getElementById('onnx-badge');
  if (!badge) return;
  const labels = {
    idle: '⬤ ONNX: Idle',
    loading: '⬤ ONNX: Loading…',
    ready: '⬤ ONNX: Ready ✓',
    error: '⬤ ONNX: Unavailable',
  };
  badge.textContent = msg || labels[status] || status;
  badge.dataset.state = status;
}

function formatVersion(version) {
  if (!version) return 'unknown';
  return version.slice(0, 8);
}

async function pollModelVersionAndSync() {
  if (modelSyncInFlight) return;

  try {
    const res = await fetch(`${API_URL}/model/metadata`, { cache: 'no-store' });
    if (!res.ok) return;
    const meta = await res.json();

    if (!meta?.available || !meta.version) {
      if (currentOnnxStatus !== 'error') {
        currentOnnxStatus = 'error';
        updateOnnxBadge('error', '⬤ ONNX: Unavailable');
      }
      return;
    }
    if (currentOnnxVersion && currentOnnxVersion === meta.version) return;

    modelSyncInFlight = true;
    currentOnnxStatus = 'loading';
    updateOnnxBadge('loading', `⬤ ONNX: Syncing ${formatVersion(meta.version)}…`);

    const payload = await workerCall('LOAD_MODEL', { force: true });
    currentOnnxVersion = payload?.version || meta.version;

    currentOnnxStatus = 'ready';
    updateOnnxBadge('ready', `⬤ ONNX: Ready ${formatVersion(currentOnnxVersion)} ✓`);
  } catch (err) {
    console.warn('[ONNX] Version poll failed:', err);
  } finally {
    modelSyncInFlight = false;
  }
}

// Start listening for ONNX status from worker
engineWorker.addEventListener('message', (e) => {
  if (e.data.type === 'MODEL_READY') {
    currentOnnxStatus = 'ready';
    if (e.data.payload?.version) currentOnnxVersion = e.data.payload.version;
    updateOnnxBadge('ready', `⬤ ONNX: Ready ${formatVersion(currentOnnxVersion)} ✓`);
  } else if (e.data.type === 'ERROR' && !e.data.id) {
    currentOnnxStatus = 'error';
    updateOnnxBadge('error', '⬤ ONNX: Error');
  }
});
updateOnnxBadge('loading');

// Keep the worker-side ONNX model synchronized with backend publishes.
setInterval(pollModelVersionAndSync, MODEL_POLL_INTERVAL_MS);
setTimeout(pollModelVersionAndSync, 4000);

// Free worker cache when tab is hidden/backgrounded (common mobile pressure case).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    workerCall('TRIM_MEMORY', { hard: false }).catch(() => {});
  }
});
window.addEventListener('pagehide', () => {
  workerCall('TRIM_MEMORY', { hard: true }).catch(() => {});
});

// (The worker script itself triggers loadOnnxModel on init)

// ---------------------------------------------------------------------------
// Training Progress Chart
// ---------------------------------------------------------------------------
async function initLossChart() {
  const canvas = document.getElementById('lossChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  lossChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Average Loss',
        data: [],
        borderColor: '#65a30d',
        backgroundColor: 'rgba(101, 163, 13, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { display: false } // Hide complex timestamps
        },
        y: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: 'Loss', color: '#94a3b8' }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });

  // Load history
  try {
    const res = await fetch(`${API_URL}/stats`);
    if (res.ok) {
      const stats = await res.json();
      const trimmed = stats.slice(-MAX_LOSS_POINTS);
      trimmed.forEach((s, i) => {
        lossChart.data.labels.push(i + 1);
        lossChart.data.datasets[0].data.push(s.loss);
      });
      lossChart.update();
    }
  } catch (e) {
    console.warn('[Stats] Failed to load history:', e);
  }
}

initLossChart();

// ---------------------------------------------------------------------------
// Board helpers
// ---------------------------------------------------------------------------
function removeHighlights() {
  $('#myBoard .square-55d63').removeClass('highlight-square selected-square');
}

function removeLastMoveHighlights() {
  $('#myBoard .square-55d63').removeClass('last-move');
}

function highlightLastMove(from, to) {
  removeLastMoveHighlights();
  $('#myBoard .square-' + from).addClass('last-move');
  $('#myBoard .square-' + to).addClass('last-move');
}

function highlightLegalMoves(square) {
  removeHighlights();
  $('#myBoard .square-' + square).addClass('selected-square');
  const moves = game.moves({ square, verbose: true });
  for (const m of moves) {
    $('#myBoard .square-' + m.to).addClass('highlight-square');
  }
}

// ---------------------------------------------------------------------------
// Tap-to-move
// ---------------------------------------------------------------------------
$('#myBoard').on('mousedown click', '.square-55d63', function (e) {
  if (game.isGameOver() || isSelfPlay) return;

  const square = $(this).attr('data-square');
  const piece = game.get(square);
  const orientationColor = board.orientation() === 'white' ? 'w' : 'b';

  if (selectedSquare && selectedSquare !== square) {
    const move = game.move({ from: selectedSquare, to: square, promotion: 'q' });
    if (move) {
      if (move.captured) {
        if (move.color === 'w') capturedByWhite.push({ type: move.captured, color: 'b' });
        else capturedByBlack.push({ type: move.captured, color: 'w' });
        updateCapturedPiecesUI();
        updateAvatar('blunder');
      } else {
        updateAvatar('wait');
      }

      board.position(game.fen(), !isSelfPlay);
      pushFenHistory(game.fen());
      updateStatus();
      removeHighlights();
      highlightLastMove(selectedSquare, square);
      selectedSquare = null;
      if (!game.isGameOver()) {
        window.setTimeout(getBotMove, 250);
      } else {
        checkGameOver();
      }
      return;
    }
  }

  if (piece && piece.color === orientationColor) {
    selectedSquare = square;
    highlightLegalMoves(square);
    return;
  }

  removeHighlights();
  selectedSquare = null;
});

// ---------------------------------------------------------------------------
// Drag-and-drop
// ---------------------------------------------------------------------------
function onDragStart(source, piece, position, orientation) {
  if (game.isGameOver() || isSelfPlay) return false;
  const playerColor = board.orientation() === 'white' ? 'w' : 'b';
  if (piece.search(new RegExp('^' + playerColor)) === -1) return false;
  selectedSquare = source;
  highlightLegalMoves(source);
}

function onDrop(source, target) {
  if (source === target) return;
  removeHighlights();
  selectedSquare = null;
  const move = game.move({ from: source, to: target, promotion: 'q' });
  if (move === null) return 'snapback';

  if (move.captured) {
    if (move.color === 'w') capturedByWhite.push({ type: move.captured, color: 'b' });
    else capturedByBlack.push({ type: move.captured, color: 'w' });
    updateCapturedPiecesUI();
    updateAvatar('blunder');
  } else {
    updateAvatar('wait');
  }

  pushFenHistory(game.fen());
  updateStatus();
  highlightLastMove(source, target);
  if (!game.isGameOver()) {
    window.setTimeout(getBotMove, 250);
  } else {
    checkGameOver();
  }
}

function onSnapEnd() {
  board.position(game.fen(), !isSelfPlay);
}

// ---------------------------------------------------------------------------
// Bot move
// ---------------------------------------------------------------------------
function makeRandomMove() {
  const possibleMoves = game.moves();
  if (possibleMoves.length === 0) return;
  const move = game.move(possibleMoves[Math.floor(Math.random() * possibleMoves.length)]);
  highlightLastMove(move.from, move.to);
  board.position(game.fen(), !isSelfPlay);
  pushFenHistory(game.fen());
  if (move.captured) {
    if (move.color === 'w') capturedByWhite.push({ type: move.captured, color: 'b' });
    else capturedByBlack.push({ type: move.captured, color: 'w' });
    updateCapturedPiecesUI();
    updateAvatar('capture');
  } else {
    updateAvatar('wait');
  }
  updateStatus();
}

async function getBotMove() {
  if (game.isGameOver()) return;

  updateAvatar('think');

  const currentFen = game.fen();
  const options = getBotOptions();
  let moveUci = null;

  try {
    options.history = fenHistory;
    // Call worker instead of direct function
    moveUci = await workerCall('GET_BEST_MOVE', { fen: currentFen, options });
  } catch (browserErr) {
    console.warn('[Engine] Browser worker failed, trying server…', browserErr);
  }

  if (!moveUci) {
    try {
      const res = await fetch(`${API_URL}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: currentFen,
          history: fenHistory,
          is_admin: options.isTraining,
          depth: options.depth,
          epsilon: options.epsilon
        }),
      });
      if (res.ok) {
        const data = await res.json();
        moveUci = data.move;
      }
    } catch (serverErr) {
      console.warn('[Engine] Server fallback also failed:', serverErr);
    }
  }

  if (moveUci && moveUci.length >= 4) {
    const from = moveUci.substring(0, 2);
    const to = moveUci.substring(2, 4);
    const promotion = moveUci.length === 5 ? moveUci[4] : undefined;
    const move = game.move({ from, to, promotion });
    board.position(game.fen(), !isSelfPlay);
    pushFenHistory(game.fen());
    highlightLastMove(from, to);
    if (move && move.captured) {
      if (move.color === 'w') capturedByWhite.push({ type: move.captured, color: 'b' });
      else capturedByBlack.push({ type: move.captured, color: 'w' });
      updateCapturedPiecesUI();
      updateAvatar('capture');
    } else {
      updateAvatar('wait');
    }
  } else {
    makeRandomMove();
  }

  updateStatus();
  checkGameOver();

  if (isSelfPlay && !game.isGameOver()) {
    window.setTimeout(getBotMove, 50);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function updateStatus() {
  const moveColor = game.turn() === 'b' ? 'Black' : 'White';
  let statusHTML = '';
  if (game.isCheckmate()) {
    statusHTML = `Game over, ${moveColor} is in checkmate.`;
  } else if (game.isDraw()) {
    statusHTML = 'Game over, drawn position';
  } else {
    statusHTML = `${moveColor} to move`;
    if (game.isCheck()) statusHTML += `, ${moveColor} is in check`;
  }
  $('#status-text').html(statusHTML);
}

// ---------------------------------------------------------------------------
// Game over + training
// ---------------------------------------------------------------------------
async function checkGameOver() {
  if (!game.isGameOver()) return;
  if (window.IS_ADMIN_MODE) await trainBot();

  const waitTime = autoResetMode ? 1000 : 2000;
  setTimeout(() => {
    if (autoResetMode && currentScenario) {
      startScenario(currentScenario);
    } else {
      board.flip();
      restartGame();
    }
  }, waitTime);
}

async function trainBot() {
  updateAvatar('wait');
  $('#training-status').show();
  const trainingStatus = document.getElementById('training-status');
  if (trainingStatus) {
    trainingStatus.style.display = 'block';
    trainingStatus.innerText = 'Training in progress… Sending data to backend.';
  }

  if (!cachedBase64Credentials) {
    const username = prompt('Admin Authentication Required\nEnter Admin Username:');
    if (username === null) {
      if (trainingStatus) {
        trainingStatus.innerText = 'Cancelled: Admin authentication required.';
        trainingStatus.style.color = '#fcd34d';
      }
      return;
    }
    const password = prompt('Enter Admin Password:');
    if (password === null) return null;
    cachedBase64Credentials = btoa(`${username}:${password}`);
  }

  let result = 0.0;
  if (game.isCheckmate()) {
    result = game.turn() === 'b' ? 1.0 : -1.0;
  }

  const lr = parseFloat(document.getElementById('lrInput')?.value || '0.0001');
  const discount = parseFloat(document.getElementById('discountInput')?.value || '0.95');
  console.log(`[Training] Sending training request. LR=${lr}, Discount=${discount}, Result=${result}`);

  try {
    const res = await fetch(`${API_URL}/train`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${cachedBase64Credentials}`,
      },
      body: JSON.stringify({
        fens: fenHistory,
        result,
        learning_rate: lr,
        discount_factor: discount
      }),
    });
    if (res.ok) {
      const data = await res.json();

      // Refresh worker-side ONNX session so newly-trained weights are used immediately.
      try {
        const modelInfo = await workerCall('LOAD_MODEL', { force: true });
        if (modelInfo?.version) currentOnnxVersion = modelInfo.version;
        updateOnnxBadge('ready', `⬤ ONNX: Ready ${formatVersion(currentOnnxVersion)} ✓`);
      } catch (reloadErr) {
        console.warn('[ONNX] Model reload after training failed:', reloadErr);
      }

      // Update Chart
      if (lossChart) {
        pushLossPoint(data.loss);
        lossChart.update();
      }

      if (trainingStatus) {
        trainingStatus.innerText = `Training complete! Loss: ${data.loss.toFixed(4)}`;
        setTimeout(() => (trainingStatus.style.display = 'none'), 5000);
      }
    } else {
      let detail = '';
      try {
        const errData = await res.json();
        if (typeof errData?.detail === 'string') detail = errData.detail;
      } catch {
        // Keep fallback message when response isn't JSON.
      }
      if (trainingStatus) {
        trainingStatus.innerText = detail ? `Training failed: ${detail}` : 'Training failed.';
        trainingStatus.style.color = '#f87171';
      }
      console.warn('[Training] Request failed:', res.status, detail || '(no detail)');
    }
  } catch (e) {
    console.error('Training error', e);
    if (trainingStatus) {
      trainingStatus.innerText = 'Error connecting to backend.';
      trainingStatus.style.color = '#f87171';
    }
  }
}

// ---------------------------------------------------------------------------
// Board init
// ---------------------------------------------------------------------------
const config = {
  pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
  draggable: true,
  position: 'start',
  onDragStart,
  onDrop,
  onSnapEnd,
};

board = window.Chessboard('myBoard', config);

function restartGame() {
  const openingKey = document.getElementById('openingSelect')?.value || 'standard';
  const randomize = document.getElementById('randomizeOpeningsCheck')?.checked;
  
  let opening = OPENINGS[openingKey] || OPENINGS.standard;
  
  if (randomize && isSelfPlay) {
    const keys = Object.keys(OPENINGS);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    opening = OPENINGS[randomKey];
    console.log(`[Training] Guided Path: Starting from ${opening.name}`);
  }

  game.reset();
  capturedByWhite = [];
  capturedByBlack = [];
  updateCapturedPiecesUI();
  fenHistory = [game.fen()]; // CAPTURE INITIAL STATE
  
  // Play through the opening moves to populate history and reach the position
  if (opening.moves && opening.moves.length > 0) {
    for (const move of opening.moves) {
      const result = game.move(move);
      if (result) {
        pushFenHistory(game.fen());
      }
    }
  }

  board.position(game.fen(), !isSelfPlay);
  removeHighlights();
  removeLastMoveHighlights();
  updateStatus();
  updateAvatar('wait');
  
  if (board.orientation() === 'black' || isSelfPlay) {
    window.setTimeout(getBotMove, 250);
  }
}

// Scenario Button Listeners
$('#genRandomBtn').on('click', () => startScenario('random'));
$('#genPawnBtn').on('click', () => startScenario('pawn'));
$('#genRookBtn').on('click', () => startScenario('rook'));

$('#autoResetCheck').on('change', function () {
  autoResetMode = $(this).is(':checked');
});

$('#startBtn').on('click', () => {
  currentScenario = null; // Clear scenario mode on manual restart
  restartGame();
});

$('#switchBtn').on('click', function () {
  board.flip();
  const botColor = board.orientation() === 'white' ? 'b' : 'w';
  if (game.turn() === botColor && !game.isGameOver()) {
    window.setTimeout(getBotMove, 250);
  }
});

const forceTrainBtn = document.getElementById('forceTrainBtn');
if (forceTrainBtn) {
  forceTrainBtn.addEventListener('click', async () => {
    if (fenHistory.length > 0) {
      await trainBot();
    } else {
      alert('Play a few moves first!');
    }
  });
}

$('#selfPlayBtn').on('click', function () {
  isSelfPlay = !isSelfPlay;
  if (isSelfPlay) {
    $(this).text('Stop Self-Play');
    $(this).css('background', '#ef4444');
    if (!game.isGameOver()) getBotMove();
  } else {
    $(this).text('Start Self-Play');
    $(this).css('background', '#8b5cf6');
  }
});

const presetSelect = document.getElementById('presetSelect');
if (presetSelect) {
  const PRESETS = {
    standard: { lr: 0.0001, discount: 0.95, epsilon: 0.25, depth: 2 },
    aggressive: { lr: 0.01, discount: 0.9, epsilon: 0.4, depth: 1 },
    finetune: { lr: 0.0001, discount: 0.99, epsilon: 0.1, depth: 3 }
  };

  presetSelect.addEventListener('change', () => {
    const preset = PRESETS[presetSelect.value];
    if (preset) {
      document.getElementById('lrInput').value = preset.lr;
      document.getElementById('discountInput').value = preset.discount;
      document.getElementById('epsilonInput').value = preset.epsilon;
      if (preset.depth) document.getElementById('depthInput').value = preset.depth;
    }
  });
}

updateStatus();

// Mobile Failsafe: Prevent page scrolling when dragging on the board
// Reset Brain Handler
  document.getElementById('resetBrainBtn')?.addEventListener('click', async () => {
    const confirmed = confirm("⚠️ DANGER: This will permanently delete the model weights and training history from the server and Vercel Blob. This action cannot be undone.\n\nAre you absolutely sure?");
    if (!confirmed) return;

    const username = prompt("Enter Admin Username:");
    if (!username) return;
    const password = prompt("Enter Admin Password:");
    if (!password) return;

    try {
      const resp = await fetch(`${API_URL}/reset-engine`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa(username + ':' + password) }
      });

      if (resp.ok) {
        alert("✅ Engine brain reset successfully. Page will reload to refresh model.");
        window.location.reload();
      } else {
        const err = await resp.text();
        alert(`❌ Reset failed: Unauthorized or server error. Check your credentials.`);
      }
    } catch (e) {
      alert(`❌ Connection error: ${e.message}`);
    }
  });

const boardElem = document.getElementById('myBoard');
if (boardElem) {
  boardElem.addEventListener('touchmove', function (e) {
    e.preventDefault();
  }, { passive: false });
}

