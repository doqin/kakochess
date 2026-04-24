import './style.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
// Fallback to chess.js default from global
const Chess = window.Chess;

let board = null;
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

  // If already have a selected square, try making a move
  if (selectedSquare && selectedSquare !== square) {
    const move = game.move({
      from: selectedSquare,
      to: square,
      promotion: 'q'
    });

    if (move) {
      playMoveSound(move);
      viewedMoveIndex = -1;
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

function onDragStart(source, piece, position, orientation) {
  // do not pick up pieces if the game is over or in review mode
  if (game.game_over() || isSelfPlay || viewedMoveIndex !== -1) return false;

  // only pick up pieces for the player's current color
  const playerColor = board.orientation() === 'white' ? 'w' : 'b';
  if (piece.search(new RegExp('^' + playerColor)) === -1) return false;

  // Show selection and legal moves immediately
  selectedSquare = source;
  highlightLegalMoves(source);
}

function makeRandomMove() {
  const possibleMoves = game.moves();
  if (possibleMoves.length === 0) return;
  const randomIdx = Math.floor(Math.random() * possibleMoves.length);
  const move = game.move(possibleMoves[randomIdx]);
  highlightLastMove(move.from, move.to);
  viewedMoveIndex = -1;
  board.position(game.fen());
  fenHistory.push(game.fen());
  updateStatus();
  updateMoveHistory();
}

async function getBotMove() {
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
  highlightLastMove(source, target);

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

$('#startBtn').on('click', restartGame);

$('#switchBtn').on('click', function () {
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

$('#selfPlayBtn').on('click', function () {
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
