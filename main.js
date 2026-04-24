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
let $status = $('#status');
let fenHistory = [game.fen()];
let isSelfPlay = false;
let cachedBase64Credentials = null;
let viewedMoveIndex = -1;
let selectedSquare = null;

// Lichess Sound Effects (Preloaded and cloned for reliability)
const SOUND_URLS = {
  move: 'https://lichess1.org/assets/_L4E18z/sound/standard/Move.mp3',
  capture: 'https://lichess1.org/assets/_L4E18z/sound/standard/Capture.mp3',
  check: 'https://lichess1.org/assets/_L4E18z/sound/standard/Check.mp3',
  castle: 'https://lichess1.org/assets/_L4E18z/sound/standard/Castle.mp3',
  notify: 'https://lichess1.org/assets/_L4E18z/sound/standard/GenericNotify.mp3',
};

// Pre-create audio elements for caching
const SOUND_CACHE = {};
Object.entries(SOUND_URLS).forEach(([key, url]) => {
  SOUND_CACHE[key] = new Audio(url);
  SOUND_CACHE[key].load();
});

function playMoveSound(moveResult) {
  if (!moveResult) return;

  let type = 'move';

  // Priority: Capture > Castle > Move
  if (moveResult.flags.includes('c') || moveResult.flags.includes('e')) {
    type = 'capture';
  }

  // Clone node for simultaneous playback (prevents one sound from cutting off another)
  const sound = SOUND_CACHE[type].cloneNode();
  sound.play().catch(e => console.warn('SFX playback prevented:', e));

  if (game.game_over()) {
    setTimeout(() => {
      const notify = SOUND_CACHE.notify.cloneNode();
      notify.play().catch(e => { });
    }, 500);
  }
}

function removeHighlights() {
  $('#myBoard .square-55d63').removeClass('highlight-square');
  $('#myBoard .square-55d63').removeClass('selected-square');
  $('#myBoard .square-55d63').removeClass('capture-hint');
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

  // Highlight the selected square
  $('#myBoard .square-' + square).addClass('selected-square');

  const moves = game.moves({
    square: square,
    verbose: true
  });

  for (let i = 0; i < moves.length; i++) {
    const $square = $('#myBoard .square-' + moves[i].to);
    if (moves[i].flags.includes('c') || moves[i].flags.includes('e')) {
      $square.addClass('capture-hint');
    } else {
      $square.addClass('highlight-square');
    }
  }
}

// Handle Tap-To-Move interface for mobile/desktop
$('#myBoard').on('mousedown click', '.square-55d63', function (e) {
  if (game.game_over() || isSelfPlay || viewedMoveIndex !== -1) return false;

  const square = $(this).attr('data-square');
  const piece = game.get(square);
  const orientationColor = board.orientation() === 'white' ? 'w' : 'b';

  if (selectedSquare && selectedSquare !== square) {
    const move = game.move({ from: selectedSquare, to: square, promotion: 'q' });
    if (move) {
      playMoveSound(move);
      viewedMoveIndex = -1;
      board.position(game.fen());
      fenHistory.push(game.fen());
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

function onDragStart(source, piece, position, orientation) {
  // do not pick up pieces if the game is over or in review mode
  if (game.game_over() || isSelfPlay || viewedMoveIndex !== -1) return false;

  // only pick up pieces for the player's current color
  const playerColor = board.orientation() === 'white' ? 'w' : 'b';
  if (piece.search(new RegExp('^' + playerColor)) === -1) return false;
  selectedSquare = source;
  highlightLegalMoves(source);
}

function makeRandomMove() {
  const possibleMoves = game.moves();
  if (possibleMoves.length === 0) return;
  const move = game.move(possibleMoves[Math.floor(Math.random() * possibleMoves.length)]);
  highlightLastMove(move.from, move.to);
  viewedMoveIndex = -1;
  board.position(game.fen());
  fenHistory.push(game.fen());
  updateStatus();
  updateMoveHistory();
}

async function getBotMove() {
  if (game.isGameOver()) return;

  updateAvatar('think');

  const currentFen = game.fen();
  const selectedDepth = parseInt(document.getElementById('depthSelect')?.value || '2');

  updateBotAvatar('think');

  try {
    const res = await fetch(`${API_URL}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen: currentFen,
        is_admin: !!window.IS_ADMIN_MODE,
        depth: selectedDepth
      })
    });

    if (res.ok) {
      const data = await res.json();
      // data.move should be UCI, e.g. "e2e4"
      // chess.js handles it if we split from/to or use `{from: 'e2', to: 'e4'}` or SAN
      const moveUci = data.move;
      if (moveUci && moveUci.length >= 4) {
        const from = moveUci.substring(0, 2);
        const to = moveUci.substring(2, 4);
        const promotion = moveUci.length === 5 ? moveUci[4] : undefined;

        const move = game.move({ from, to, promotion });
          if (move) {
            playMoveSound(move);
            viewedMoveIndex = -1;
            board.position(game.fen());
            fenHistory.push(game.fen());
            highlightLastMove(from, to);

            if (move.flags.includes('c') || move.flags.includes('e')) {
              updateBotAvatar('capture');
              setTimeout(() => updateBotAvatar('wait'), 2000);
            } else {
              updateBotAvatar('wait');
            }
          } else {
          makeRandomMove();
        }
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

  if (isSelfPlay && !game.game_over()) {
    // 50ms delay creates a rapid but visible visualization loop
    window.setTimeout(getBotMove, 50);
  }
}

function onDrop(source, target) {
  // If we just tapped the same piece, don't clear anything
  if (source === target) return;

  removeHighlights();
  selectedSquare = null;
  // see if the move is legal
  // chess.js version ^0.12.0 handles `{from, to, promotion}`
  const move = game.move({
    from: source,
    to: target,
    promotion: 'q' // NOTE: always promote to a queen for example simplicity
  });

  // illegal move
  if (move === null) return 'snapback';

  playMoveSound(move);

  // State after player move
  viewedMoveIndex = -1;
  fenHistory.push(game.fen());
  updateStatus();
  checkGameOver();

  // Bot reacts to losing a non-pawn piece
  if (move && move.captured && move.captured !== 'p') {
    updateBotAvatar('blunder');
    setTimeout(() => updateBotAvatar('wait'), 2000);
  }

  // make bot move
  if (!game.game_over()) {
    window.setTimeout(getBotMove, 250);
  } else {
    checkGameOver();
  }
}

// update the board position after the piece snap
// for castling, en passant, pawn promotion
function onSnapEnd() {
  board.position(game.fen());
}

function updateStatus() {
  let statusHTML = '';
  if (game.isCheckmate()) {
    statusHTML = `Game over, ${moveColor} is in checkmate.`;
  } else if (game.isDraw()) {
    statusHTML = 'Game over, drawn position';
  } else {
    statusHTML = `${moveColor} to move`;
    if (game.isCheck()) statusHTML += `, ${moveColor} is in check`;
  }

  $status.html(statusHTML);
  updateMoveHistory();
}

function updateMoveHistory() {
  const history = game.history();
  const $moveBody = $('#moveBody');
  $moveBody.empty();

  for (let i = 0; i < history.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const whiteMove = history[i];
    const blackMove = history[i + 1] || '';

    const whiteCell = `<td class="move-cell ${viewedMoveIndex === i ? 'viewing' : ''}" data-move-index="${i}">${whiteMove}</td>`;
    const blackCell = blackMove ? `<td class="move-cell ${viewedMoveIndex === i + 1 ? 'viewing' : ''}" data-move-index="${i + 1}">${blackMove}</td>` : '<td></td>';

    const row = `<tr class="move-row">
      <td>${moveNum}</td>
      ${whiteCell}
      ${blackCell}
    </tr>`;
    $moveBody.append(row);
  }

  // Scroll to bottom only if viewing live
  if (viewedMoveIndex === -1) {
    const moveHistoryDiv = document.getElementById('moveHistory');
    if (moveHistoryDiv) {
      moveHistoryDiv.scrollTop = moveHistoryDiv.scrollHeight;
    }
  }
}

// Navigation Logic
$(document).on('click', '.move-cell', function () {
  const index = parseInt($(this).attr('data-move-index'));
  if (isNaN(index)) return;

  // If clicking already selected, go back to live
  if (viewedMoveIndex === index) {
    viewedMoveIndex = -1;
  } else {
    viewedMoveIndex = index;
  }
  
  renderViewedPosition();
});

function renderViewedPosition() {
  if (viewedMoveIndex === -1) {
    board.position(game.fen());
  } else if (viewedMoveIndex === -2) {
    board.position(fenHistory[0]);
  } else {
    // fenHistory[0] is initial, [1] is after move 0, etc.
    const fen = fenHistory[viewedMoveIndex + 1];
    if (fen) board.position(fen);
  }
  updateMoveHistory();
}

// Button Navigation
$('#navFirst').on('click', () => {
  if (fenHistory.length > 0) {
    viewedMoveIndex = -2;
    renderViewedPosition();
  }
});

$('#navPrev').on('click', () => {
  const history = game.history();
  if (viewedMoveIndex === -1) {
    viewedMoveIndex = history.length - 1;
  } else if (viewedMoveIndex > -2) {
    viewedMoveIndex--;
  }
  renderViewedPosition();
});

$('#navNext').on('click', () => {
  const history = game.history();
  if (viewedMoveIndex === -2) {
    viewedMoveIndex = 0;
  } else if (viewedMoveIndex !== -1 && viewedMoveIndex < history.length - 1) {
    viewedMoveIndex++;
  } else {
    viewedMoveIndex = -1;
  }
  renderViewedPosition();
});

$('#navLast').on('click', () => {
  viewedMoveIndex = -1;
  renderViewedPosition();
});

function updateBotAvatar(state) {
  const $avatar = $('#botAvatar');
  if (!$avatar.length) return;

  const images = {
    wait: '/wait.png',
    think: '/think.png',
    capture: '/capture.png',
    blunder: '/blunder.png'
  };

  $avatar.attr('src', images[state] || images.wait);
}

// ---------------------------------------------------------------------------
// Game over + training
// ---------------------------------------------------------------------------
async function checkGameOver() {
  if (!game.game_over()) return;

  if (window.IS_ADMIN_MODE) {
    await trainBot();
  }

  // Auto-switch sides and restart after a brief delay
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
    const password = prompt("Enter Admin Password:");
    if (password === null) return;

    cachedBase64Credentials = btoa(`${username}:${password}`);
  }

  // Determine result: 1.0 (White won), -1.0 (Black won), 0.0 (Draw)
  let result = 0.0;
  if (game.isCheckmate()) {
    result = game.turn() === 'b' ? 1.0 : -1.0;
  }

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
  fenHistory = [game.fen()];
  viewedMoveIndex = -1;
  board.start(); // Resets piece positions but keeps the flipped orientation
  removeHighlights();
  removeLastMoveHighlights();
  updateStatus();

  // If the player is now Black or we are in Self-Play, kick off bot move immediately
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

