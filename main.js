import './style.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
// Fallback to chess.js default from global
const Chess = window.Chess;

let board = null;
let game = new Chess();
let $status = $('#status');
let fenHistory = [];
let isSelfPlay = false;
let cachedBase64Credentials = null;

function onDragStart (source, piece, position, orientation) {
  // do not pick up pieces if the game is over
  if (game.game_over()) return false;

  // only pick up pieces for the player's current color
  if (board.orientation() === 'white' && piece.search(/^b/) !== -1) return false;
  if (board.orientation() === 'black' && piece.search(/^w/) !== -1) return false;
}

function makeRandomMove () {
  const possibleMoves = game.moves();
  if (possibleMoves.length === 0) return;
  const randomIdx = Math.floor(Math.random() * possibleMoves.length);
  game.move(possibleMoves[randomIdx]);
  board.position(game.fen());
  fenHistory.push(game.fen());
  updateStatus();
}

async function getBotMove() {
  const currentFen = game.fen();
  try {
    const res = await fetch(`${API_URL}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen: currentFen, is_admin: !!window.IS_ADMIN_MODE })
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
        
        game.move({ from, to, promotion });
        board.position(game.fen());
        fenHistory.push(game.fen());
      } else {
        // Fallback
        makeRandomMove();
      }
    } else {
      makeRandomMove();
    }
  } catch (e) {
    console.error("Failed to connect to backend", e);
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
  // see if the move is legal
  // chess.js version ^0.12.0 handles `{from, to, promotion}`
  const move = game.move({
    from: source,
    to: target,
    promotion: 'q' // NOTE: always promote to a queen for example simplicity
  });

  // illegal move
  if (move === null) return 'snapback';

  // State after player move
  fenHistory.push(game.fen());
  updateStatus();

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
  
  try {
    const res = await fetch(`${API_URL}/train`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Basic ${cachedBase64Credentials}`
      },
      body: JSON.stringify({ fens: fenHistory, result: result })
    });
    
    if (res.ok) {
      const data = await res.json();
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
  board.start(); // Resets piece positions but keeps the flipped orientation
  updateStatus();
  
  // If the player is now Black or we are in Self-Play, kick off bot move immediately
  if (board.orientation() === 'black' || isSelfPlay) {
    window.setTimeout(getBotMove, 250);
  }
}

$('#startBtn').on('click', restartGame);

$('#switchBtn').on('click', function() {
  board.flip();
  restartGame();
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

updateStatus();
