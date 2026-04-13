import './style.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
// Fallback to chess.js default from global
const Chess = window.Chess;

let board = null;
let game = new Chess();
let $status = $('#status');
let fenHistory = [];
let isSelfPlay = false;
let trainingMode = 'neural'; // 'neural' | 'teacher'
let isTeacherRunning = false;
let cachedBase64Credentials = null;
let selectedSquare = null;
let piHistory = []; // To store MCTS policy vectors

// Persist games trained count and loss history
let totalGamesTrained = parseInt(localStorage.getItem('kakochess_games_trained') || '0');
let trainingLossHistory = JSON.parse(localStorage.getItem('kakochess_loss_history') || '[]');
let matchHistory = JSON.parse(localStorage.getItem('kakochess_match_history') || '[]');

function updateGameCounterDisplay() {
  const el = document.getElementById('gamesTrained');
  if (el) el.innerText = totalGamesTrained;
  renderLossHistory();
  renderMatchHistory();
}

function renderMatchHistory() {
  const listEl = document.getElementById('match-list');
  if (!listEl) return;
  if (matchHistory.length === 0) return;

  listEl.innerHTML = matchHistory.slice(-10).reverse().map((m, i) => {
    const winnerText = m.winner === 'Draw' ? "Draw" : `${m.winner} won`;
    const resultColor = m.winner === 'Draw' ? '#94a3b8' : (m.winner.includes('Kakobot') ? '#ef4444' : '#22c55e');
    const playerWhite = m.white === 'Player' ? 'Player (White)' : `${m.white} (White)`;
    const playerBlack = m.black === 'Player' ? 'Player (Black)' : `${m.black} (Black)`;

    return `<div style="margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
       <div style="display:flex; justify-content:space-between; font-size: 0.75rem; opacity: 0.7;">
         <span>${playerWhite} vs ${playerBlack}</span>
         <span style="font-size: 0.7rem; opacity: 0.6;">${m.moves} moves</span>
       </div>
       <div style="color: ${resultColor}; font-weight: 500;">${winnerText}</div>
     </div>`;
  }).join('');
}

function recordMatch(resultVal) {
  const oppSelect = document.getElementById('opponentSelect');
  if (!oppSelect) return;

  const playerColorStr = board.orientation() === 'white' ? 'White' : 'Black';
  const oppColorStr = playerColorStr === 'White' ? 'Black' : 'White';
  
  const oppName = oppSelect.options[oppSelect.selectedIndex].text.replace(' (Local Browser)', '').replace(' (Online API)', '');
  const p1 = isSelfPlay ? 'Kako Bot' : 'Human';
  let p2 = oppSelect.value === 'bot' ? 'Kako Bot' : oppName;

  const whiteName = playerColorStr === 'White' ? p1 : p2;
  const blackName = playerColorStr === 'Black' ? p1 : p2;

  let winnerName = "Draw";
  if (resultVal === 1.0) {
    winnerName = whiteName === blackName ? `${whiteName} (White)` : whiteName;
  } else if (resultVal === -1.0) {
    winnerName = whiteName === blackName ? `${blackName} (Black)` : blackName;
  }

  matchHistory.push({
    white: whiteName,
    black: blackName,
    winner: winnerName,
    moves: game.history().length,
    date: Date.now()
  });

  if (matchHistory.length > 50) matchHistory.shift();
  localStorage.setItem('kakochess_match_history', JSON.stringify(matchHistory));
  renderMatchHistory();
}

function renderLossHistory() {
  const listEl = document.getElementById('loss-list');
  const sparkEl = document.getElementById('loss-sparkline');
  const currentLossEl = document.getElementById('current-loss');
  if (!listEl || !sparkEl) return;

  if (trainingLossHistory.length === 0) return;

  const lastLoss = trainingLossHistory[trainingLossHistory.length - 1];
  if (currentLossEl) currentLossEl.innerText = lastLoss.toFixed(4);

  // List: last 10 entries
  listEl.innerHTML = trainingLossHistory.slice(-10).reverse().map((loss, i) => 
    `<div style="display:flex; justify-content:space-between; opacity: ${1 - i*0.08}">
       <span>Game #${totalGamesTrained - i}</span>
       <span style="font-family:monospace; color:var(--text-primary);">${loss.toFixed(4)}</span>
     </div>`
  ).join('');

  // Sparkline: Simple bar chart
  const maxLoss = Math.max(...trainingLossHistory.slice(-30), 1);
  sparkEl.innerHTML = trainingLossHistory.slice(-30).map(loss => {
      const height = (loss / maxLoss) * 100;
      return `<div style="flex:1; background:var(--accent); height:${height}%; min-width:3px; opacity:0.6; border-radius:1px 1px 0 0;"></div>`;
  }).join('');
}

let mctsWorker = null;
let mctsResolve = null;
let gamesSinceLastRestart = 0;

function initMctsWorker() {
  if (mctsWorker) {
    mctsWorker.terminate();
    mctsWorker = null;
  }
  
  try {
    mctsWorker = new Worker('/mcts.js');
    mctsWorker.onmessage = function(event) {
      if (event.data.type === 'MOVE' && mctsResolve) {
        mctsResolve({ moveUci: event.data.move, pi: event.data.pi });
        mctsResolve = null;
      } else if (event.data.type === 'STATUS') {
        console.log("MCTS Status:", event.data.msg);
      }
    };
  } catch (e) {
    console.warn("Could not load MCTS worker", e);
  }
}

if (window.Worker) {
  initMctsWorker();
}

async function getKakoMove(fen, moveCount = 0, sims = 50, cpuct = 1.5, tempThreshold = 30, dirichletEps = 0.25) {
  return new Promise((resolve, reject) => {
    if (!mctsWorker) return reject("MCTS Worker not loaded");
    mctsResolve = resolve;
    mctsWorker.postMessage({
      type: 'START',
      fen,
      moveCount,
      sims,
      cpuct,
      tempThreshold,
      dirichletEps
    });
  });
}

// Stockfish Worker setup
let stockfishWorker = null;
let stockfishResolve = null;
if (window.Worker) {
  try {
    stockfishWorker = new Worker('/stockfish.js');
    // Limit memory: 16MB Hash is perfect for depth 5 and prevents browser crashes
    stockfishWorker.postMessage('uci');
    stockfishWorker.postMessage('setoption name Hash value 16');
    stockfishWorker.onmessage = function(event) {
      if (typeof event.data === 'string' && event.data.startsWith('bestmove')) {
        const parts = event.data.split(' ');
        if (parts.length > 1 && stockfishResolve) {
          stockfishResolve(parts[1]);
          stockfishResolve = null;
        }
      }
    };
  } catch (e) {
    console.warn("Could not load local stockfish worker", e);
  }
}

async function getStockfishLocalMove(fen, depth, skill = 20) {
  return new Promise((resolve, reject) => {
    if (!stockfishWorker) return reject("Worker not loaded");
    stockfishResolve = resolve;
    console.log(`[Stockfish Local] Setting Skill Level to ${skill}, Depth to ${depth}`);
    stockfishWorker.postMessage('setoption name Skill Level value ' + skill);
    stockfishWorker.postMessage('position fen ' + fen);
    stockfishWorker.postMessage('go depth ' + depth);
  });
}

async function getStockfishOnlineMove(fen, depth) {
  const url = `https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${depth}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.success && data.bestmove) {
    return data.bestmove.split(' ')[1];
  }
  throw new Error("Failed to parse online stockfish");
}

function removeHighlights() {
  $('#myBoard .square-55d63').removeClass('highlight-square');
  $('#myBoard .square-55d63').removeClass('selected-square');
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
    $('#myBoard .square-' + moves[i].to).addClass('highlight-square');
  }
}

// Handle Tap-To-Move interface for mobile/desktop
$('#myBoard').on('mousedown click', '.square-55d63', function(e) {
  if (game.game_over() || isSelfPlay) return;

  const square = $(this).attr('data-square');
  const piece = game.get(square);
  const orientationColor = board.orientation() === 'white' ? 'w' : 'b';

  // If already have a selected square, try making a move
  if (selectedSquare && selectedSquare !== square) {
    const move = game.move({
      from: selectedSquare,
      to: square,
      promotion: 'q'
    });

    if (move) {
      board.position(game.fen());
      fenHistory.push(game.fen());
      updateStatus();
      removeHighlights();
      highlightLastMove(selectedSquare, square);
      selectedSquare = null;
      if (!game.game_over()) {
        window.setTimeout(getBotMove, 250);
      } else {
        checkGameOver();
      }
      return;
    }
  }

  // If clicking on our own piece, select it
  if (piece && piece.color === orientationColor) {
    selectedSquare = square;
    highlightLegalMoves(square);
    return;
  }

  // If clicking empty square or enemy piece (and not making a move), deselect
  removeHighlights();
  selectedSquare = null;
});

function onDragStart (source, piece, position, orientation) {
  // do not pick up pieces if the game is over
  if (game.game_over() || isSelfPlay) return false;

  // only pick up pieces for the player's current color
  const playerColor = board.orientation() === 'white' ? 'w' : 'b';
  if (piece.search(new RegExp('^' + playerColor)) === -1) return false;

  // Show selection and legal moves immediately
  selectedSquare = source;
  highlightLegalMoves(source);
}

function makeRandomMove () {
  const possibleMoves = game.moves();
  if (possibleMoves.length === 0) return;
  const randomIdx = Math.floor(Math.random() * possibleMoves.length);
  const move = game.move(possibleMoves[randomIdx]);
  highlightLastMove(move.from, move.to);
  board.position(game.fen());
  fenHistory.push(game.fen());
  updateStatus();
}

async function getBotMove() {
  const currentFen = game.fen();
  
  let opponentType = 'bot';
  let sfDepth = 1;
  let sfSkill = 20;
  const oppSelect = document.getElementById('opponentSelect');
  const depthInput = document.getElementById('sfDepth');
  const skillInput = document.getElementById('sfSkill');
  if (oppSelect && window.IS_ADMIN_MODE) {
    opponentType = oppSelect.value;
    if (depthInput) sfDepth = parseInt(depthInput.value) || 1;
    if (skillInput && skillInput.value !== "") sfSkill = parseInt(skillInput.value);
  }
  
  const playerColor = board.orientation() === 'white' ? 'w' : 'b';
  const isOpponentTurn = game.turn() !== playerColor;
  
  let useEngine = 'bot';
  if (isOpponentTurn) {
    useEngine = opponentType;
  } else {
    // If it is the player's turn but we are running auto-bot, it's Kakochess!
    useEngine = 'bot';
  }

  let moveUci = null;
  let pi = null;

  try {
    if (useEngine === 'stockfish-local') {
      moveUci = await getStockfishLocalMove(currentFen, sfDepth, sfSkill);
    } else if (useEngine === 'stockfish-online') {
      moveUci = await getStockfishOnlineMove(currentFen, sfDepth);
    } else {
      // Kako Bot (MCTS) — read all user-configured parameters
      const simsCount    = parseInt(document.getElementById('mctsSims')?.value)       || 50;
      const cpuct        = parseFloat(document.getElementById('cpuct')?.value)         ?? 1.5;
      const tempThreshold= parseInt(document.getElementById('tempThreshold')?.value)   ?? 30;
      const dirichletEps = parseFloat(document.getElementById('dirichletEps')?.value)  ?? 0.25;
      const res = await getKakoMove(currentFen, game.history().length, simsCount, cpuct, tempThreshold, dirichletEps);
      moveUci = res.moveUci;
      pi = res.pi;
    }
  } catch (e) {
    console.error(`Failed to get move from ${useEngine}`, e);
  }
  
  if (moveUci && moveUci.length >= 4) {
    const from = moveUci.substring(0, 2);
    const to = moveUci.substring(2, 4);
    const promotion = moveUci.length === 5 ? moveUci[4] : undefined;
    
    game.move({ from, to, promotion });
    board.position(game.fen());
    
    fenHistory.push(currentFen);
    // If we didn't get a PI (e.g. from stockfish), create a one-hot vector for the move taken
    if (!pi) {
        pi = new Array(4096).fill(0);
        // Use the proper helper
        const fSq = (moveUci.charCodeAt(0) - 97) + (parseInt(moveUci[1]) - 1) * 8;
        const tSq = (moveUci.charCodeAt(2) - 97) + (parseInt(moveUci[3]) - 1) * 8;
        pi[fSq * 64 + tSq] = 1.0;
    }
    piHistory.push(pi);
    
    highlightLastMove(from, to);
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

function onDrop (source, target) {
  // If we just tapped the same piece, don't clear anything
  if (source === target) return;

  removeHighlights();
  selectedSquare = null;
  const prevFen = game.fen();
  // see if the move is legal
  // chess.js version ^0.12.0 handles `{from, to, promotion}`
  const move = game.move({
    from: source,
    to: target,
    promotion: 'q' // NOTE: always promote to a queen for example simplicity
  });

  // illegal move
  if (move === null) return 'snapback';

  // Save the move for training
  fenHistory.push(prevFen);
  const pi = new Array(4096).fill(0);
  const fSq = (source.charCodeAt(0) - 97) + (parseInt(source[1]) - 1) * 8;
  const tSq = (target.charCodeAt(0) - 97) + (parseInt(target[1]) - 1) * 8;
  pi[fSq * 64 + tSq] = 1.0;
  piHistory.push(pi);

  // State after player move
  const lastFen = game.fen(); // Position after move
  // Note: for training, we need the FEN *before* the move
  // So we should have saved the FEN before game.move
  // Let's fix that.
  
  updateStatus();
  highlightLastMove(source, target);

  // make bot move
  if (!game.game_over()) {
    window.setTimeout(getBotMove, 250);
  } else {
    checkGameOver();
  }
}

// update the board position after the piece snap
// for castling, en passant, pawn promotion
function onSnapEnd () {
  board.position(game.fen());
}

function updateStatus () {
  let statusHTML = '';

  let moveColor = 'White';
  if (game.turn() === 'b') {
    moveColor = 'Black';
  }

  if (game.in_checkmate()) {
    statusHTML = `Game over, ${moveColor} is in checkmate.`;
  } else if (game.in_draw()) {
    statusHTML = 'Game over, drawn position';
  } else {
    statusHTML = `${moveColor} to move`;
    if (game.in_check()) {
      statusHTML += ', ' + moveColor + ' is in check';
    }
  }

  if (window.IS_ADMIN_MODE) {
    const oppSelect = document.getElementById('opponentSelect');
    if (oppSelect) {
       const playerColorStr = board.orientation() === 'white' ? 'White' : 'Black';
       const oppColorStr = playerColorStr === 'White' ? 'Black' : 'White';
       
       const oppName = oppSelect.options[oppSelect.selectedIndex].text.replace(' (Local Browser)', '').replace(' (Online API)', '');
       const p1 = isSelfPlay ? '🤖 Kako Bot' : '👤 Human';
       
       let p2 = '🤖 Kako Bot';
       if (oppSelect.value !== 'bot') {
           p2 = `💻 ${oppName}`;
       }
       
       statusHTML += `<div style="margin-top: 8px; font-size: 1rem; color: var(--accent); font-weight: 800;">`;
       statusHTML += `${p1} (${playerColorStr}) <span style="color:var(--text-secondary); margin: 0 4px;">vs</span> ${p2} (${oppColorStr})`;
       statusHTML += `</div>`;
    }
  }

  $status.html(statusHTML);
}

async function checkGameOver() {
  if (!game.game_over()) return;
  
  if (window.IS_ADMIN_MODE) {
    await trainBot();
  }
  
  // Auto-switch sides and restart after a brief delay
  setTimeout(() => {
    board.flip();
    restartGame();
  }, 2000);
}

async function trainBot() {
  const trainingStatus = document.getElementById('training-status');
  if (trainingStatus) {
    trainingStatus.style.display = 'block';
    trainingStatus.innerText = 'Training in progress... Sending data to backend.';
  }

  if (!cachedBase64Credentials) {
    const username = prompt("Admin Authentication Required\nEnter Admin Username:");
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
  if (game.in_checkmate()) {
    result = game.turn() === 'b' ? 1.0 : -1.0;
  }
  
  // Read training params from UI
  const lr = parseFloat(document.getElementById('learningRate')?.value) || 0.0001;
  const batchSize = parseInt(document.getElementById('batchSize')?.value) || 128;
  
  // Record the match before training
  recordMatch(result);
  
  try {
    const res = await fetch(`${API_URL}/train`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Basic ${cachedBase64Credentials}`
      },
      body: JSON.stringify({ 
        fens: fenHistory, 
        pis: piHistory, 
        result: result,
        learning_rate: lr,
        batch_size: batchSize
      })
    });
    
    if (res.ok) {
      const data = await res.json();
      
      // Update persistent counter
      totalGamesTrained++;
      localStorage.setItem('kakochess_games_trained', totalGamesTrained);
      
      // Update loss history
      trainingLossHistory.push(data.loss);
      if (trainingLossHistory.length > 100) trainingLossHistory.shift(); // Keep last 100
      localStorage.setItem('kakochess_loss_history', JSON.stringify(trainingLossHistory));
      
      updateGameCounterDisplay();

      if (trainingStatus) {
        trainingStatus.innerText = `Training complete! Loss: ${data.loss.toFixed(4)}`;
        setTimeout(() => trainingStatus.style.display = 'none', 5000);
      }
    } else {
      if (trainingStatus) {
        trainingStatus.innerText = 'Training failed.';
        trainingStatus.style.color = '#f87171';
      }
    }
  } catch (e) {
    console.error("Training error", e);
    if (trainingStatus) {
      trainingStatus.innerText = 'Error connecting to backend.';
      trainingStatus.style.color = '#f87171';
    }
  }
}

const config = {
  pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
  draggable: true,
  position: 'start',
  onDragStart: onDragStart,
  onDrop: onDrop,
  onSnapEnd: onSnapEnd
};

board = window.Chessboard('myBoard', config);

function restartGame() {
  game.reset();
  fenHistory = [];
  piHistory = [];
  
  // Memory optimization: Restart the MCTS worker every 3 games to clear WASM heap fragmentation
  gamesSinceLastRestart++;
  if (gamesSinceLastRestart >= 3) {
      console.log("Recycling MCTS worker to free memory junk...");
      initMctsWorker();
      gamesSinceLastRestart = 0;
  }
  
  board.start(); // Resets piece positions but keeps the flipped orientation
  removeHighlights();
  removeLastMoveHighlights();
  updateStatus();
  
  // If the player is now Black or we are in Self-Play, kick off bot move immediately
  if (board.orientation() === 'black' || isSelfPlay) {
    window.setTimeout(getBotMove, 250);
  }
}

$('#startBtn').on('click', restartGame);

$('#switchBtn').on('click', function() {
  board.flip();
  // If it's now the bot's turn, trigger a move
  const botColor = board.orientation() === 'white' ? 'b' : 'w';
  if (game.turn() === botColor && !game.game_over()) {
    window.setTimeout(getBotMove, 250);
  }
});

const forceTrainBtn = document.getElementById('forceTrainBtn');
if (forceTrainBtn) {
  forceTrainBtn.addEventListener('click', async () => {
    if (fenHistory.length > 0) {
      await trainBot();
    } else {
      alert("Play a few moves first!");
    }
  });
}

$('#selfPlayBtn').on('click', function() {
  isSelfPlay = !isSelfPlay;
  updateStatus(); // Update the indicators immediately
  if (isSelfPlay) {
    $(this).text('Stop Self-Play');
    $(this).css('background', '#ef4444');
    if (!game.game_over()) {
      getBotMove();
    }
  } else {
    $(this).text('Start Self-Play');
    $(this).css('background', '#8b5cf6');
  }
});

// ─── Training Mode Switcher ───────────────────────────────────────────────────
function setTrainingMode(mode) {
  trainingMode = mode;
  const neuralBtn = document.getElementById('modeNeuralBtn');
  const teacherBtn = document.getElementById('modeTeacherBtn');
  const teacherControls = document.getElementById('teacher-controls');
  const teacherRunBtn = document.getElementById('teacherRunBtn');
  const selfPlayBtn = document.getElementById('selfPlayBtn');
  const forceTrainBtn = document.getElementById('forceTrainBtn');

  if (mode === 'teacher') {
    if (neuralBtn) { neuralBtn.style.background = 'rgba(255,255,255,0.1)'; neuralBtn.style.border = '1px solid rgba(255,255,255,0.2)'; }
    if (teacherBtn) { teacherBtn.style.background = '#d97706'; teacherBtn.style.border = 'none'; }
    if (teacherControls) teacherControls.style.display = 'flex';
    if (teacherRunBtn) teacherRunBtn.style.display = '';
    if (selfPlayBtn) selfPlayBtn.style.display = 'none';
    if (forceTrainBtn) forceTrainBtn.style.display = 'none';
  } else {
    if (neuralBtn) { neuralBtn.style.background = 'var(--accent)'; neuralBtn.style.border = 'none'; }
    if (teacherBtn) { teacherBtn.style.background = 'rgba(255,255,255,0.1)'; teacherBtn.style.border = '1px solid rgba(255,255,255,0.2)'; }
    if (teacherControls) teacherControls.style.display = 'none';
    if (teacherRunBtn) teacherRunBtn.style.display = 'none';
    if (selfPlayBtn) selfPlayBtn.style.display = '';
    if (forceTrainBtn) forceTrainBtn.style.display = '';
  }
}

// Wire mode buttons via addEventListener (reliable — avoids inline onclick + ES module timing issues)
const modeNeuralBtn = document.getElementById('modeNeuralBtn');
const modeTeacherBtn = document.getElementById('modeTeacherBtn');
if (modeNeuralBtn) modeNeuralBtn.addEventListener('click', () => setTrainingMode('neural'));
if (modeTeacherBtn) modeTeacherBtn.addEventListener('click', () => setTrainingMode('teacher'));

// ─── Teacher Game Live Stream ─────────────────────────────────────────────────
// Streams a teacher game via SSE: the server sends each move as it's computed,
// and we immediately play it on the board. Training happens server-side after the last move.
async function runTeacherGameLive(gameIndex, numGames) {
  if (!cachedBase64Credentials) {
    const username = prompt('Admin Authentication Required\nEnter Admin Username:');
    if (!username) return null;
    const password = prompt('Enter Admin Password:');
    if (!password) return null;
    cachedBase64Credentials = btoa(`${username}:${password}`);
  }

  const depth     = parseInt(document.getElementById('teacherDepth')?.value)       || 3;
  const lr        = parseFloat(document.getElementById('learningRate')?.value)      || 0.0001;
  const batchSize = parseInt(document.getElementById('batchSize')?.value)           || 128;
  const trainingStatus = document.getElementById('training-status');

  // Reset the board for the new game
  game.reset();
  board.start(false);
  removeHighlights?.();
  removeLastMoveHighlights?.();

  let moveCount = 0;

  const res = await fetch(`${API_URL}/teacher-game`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${cachedBase64Credentials}`
    },
    body: JSON.stringify({ depth, learning_rate: lr, batch_size: batchSize })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (trainingStatus) {
      trainingStatus.style.color = '#f87171';
      trainingStatus.innerText = `Teacher game failed: ${err.detail}`;
    }
    return null;
  }

  // Read the SSE stream line by line
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneData = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let event;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }

      if (event.type === 'move') {
        const uci = event.move;
        const from = uci.substring(0, 2);
        const to   = uci.substring(2, 4);
        const promotion = uci.length === 5 ? uci[4] : undefined;

        game.move({ from, to, promotion });
        board.position(game.fen(), false); // false = instant, no animation
        highlightLastMove?.(from, to);
        moveCount = event.move_num;

        const side = event.move_num % 2 === 1 ? '♔ White' : '♚ Black';
        $status.html(`📚 <strong>Teacher Game ${gameIndex}/${numGames}</strong> — Move ${Math.ceil(event.move_num / 2)} (${uci}) <span style="opacity:0.5">${side}</span>`);

        if (trainingStatus) {
          trainingStatus.style.color = '#fbbf24';
          trainingStatus.innerText = `📚 Game ${gameIndex}/${numGames} — Playing move ${moveCount}...`;
        }

      } else if (event.type === 'done') {
        doneData = event;
      }
    }
  }

  return doneData; // { result, result_str, moves, loss }
}

const teacherRunBtn = document.getElementById('teacherRunBtn');
if (teacherRunBtn) {
  teacherRunBtn.addEventListener('click', async () => {
    if (isTeacherRunning) return;
    isTeacherRunning = true;
    const numGames = parseInt(document.getElementById('teacherGames')?.value) || 5;
    const trainingStatus = document.getElementById('training-status');
    teacherRunBtn.disabled = true;
    teacherRunBtn.textContent = '⏳ Running Teacher Games...';

    for (let i = 0; i < numGames; i++) {
      if (trainingStatus) {
        trainingStatus.style.display = 'block';
        trainingStatus.style.color = '#fbbf24';
        trainingStatus.innerText = `📚 Starting teacher game ${i + 1}/${numGames}...`;
      }

      const data = await runTeacherGameLive(i + 1, numGames);
      if (!data) break;

      // Update persistent counters
      totalGamesTrained++;
      localStorage.setItem('kakochess_games_trained', totalGamesTrained);
      trainingLossHistory.push(data.loss);
      if (trainingLossHistory.length > 100) trainingLossHistory.shift();
      localStorage.setItem('kakochess_loss_history', JSON.stringify(trainingLossHistory));
      updateGameCounterDisplay();

      if (trainingStatus) {
        trainingStatus.style.color = '#86efac';
        trainingStatus.innerText = `✅ Game ${i + 1}: ${data.result_str} | ${data.moves} moves | Loss: ${data.loss.toFixed(4)}`;
      }
      $status.html(`📚 <strong>Game ${i + 1} done</strong> — ${data.result_str} | Loss: ${data.loss.toFixed(4)}`);

      // Brief pause between games
      await new Promise(r => setTimeout(r, 500));
    }

    isTeacherRunning = false;
    teacherRunBtn.disabled = false;
    teacherRunBtn.textContent = '▶ Run Teacher Games';
    if (trainingStatus) {
      trainingStatus.style.color = '#86efac';
      trainingStatus.innerText = `📚 Teacher batch of ${numGames} games complete!`;
      setTimeout(() => trainingStatus.style.display = 'none', 5000);
    }
  });
}

updateStatus();
updateGameCounterDisplay();

// Re-render status when opponent is changed
$('#opponentSelect').on('change', function() {
  updateStatus();
  const val = $(this).val();
  if (val.startsWith('stockfish')) {
    $('#sf-settings').css('display', 'flex');
  } else {
    $('#sf-settings').css('display', 'none');
  }
});
