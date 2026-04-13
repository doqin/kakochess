importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js');
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js');

let session = null;
let modelLoadingPromise = null;

// Configure ONNX Runtime to find WASM files from CDN
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';

// Helper function to map chess piece to an input index
function pieceToIndex(pieceStr) {
    const map = { 'p': 0, 'n': 1, 'b': 2, 'r': 3, 'q': 4, 'k': 5 };
    return map[pieceStr.toLowerCase()];
}

// Convert "e2" to 0-63 (0=a1, 63=h8)
function uciToSq(uci) {
    const file = uci.charCodeAt(0) - 97;
    const rank = parseInt(uci[1]) - 1;
    return rank * 8 + file;
}

// Reusable input buffer to avoid massive allocation pressure
const inputBuffer = new Float32Array(20 * 8 * 8);

// Map the board FEN to the 20-plane tactical buffer
function buildTensor(chess) {
    inputBuffer.fill(0);
    
    const pieceMap = { 'p': 0, 'n': 1, 'b': 2, 'r': 3, 'q': 4, 'k': 5 };
    const files = ['a','b','c','d','e','f','g','h'];
    
    // 0-11: Piece planes
    for (let r = 1; r <= 8; r++) {
        for (let f = 0; f < 8; f++) {
            const sq = files[f] + r;
            const piece = chess.get(sq);
            if (piece) {
                const colorOffset = piece.color === 'w' ? 0 : 6;
                const channel = pieceMap[piece.type] + colorOffset;
                const sqIndex = (r - 1) * 8 + f;
                inputBuffer[channel * 64 + sqIndex] = 1.0;
            }
        }
    }
    
    // 12-15: Castling rights
    const fen = chess.fen();
    const castlingPart = fen.split(' ')[2];
    for (let i=0; i<64; i++) {
        if (castlingPart.includes('K')) inputBuffer[12 * 64 + i] = 1.0;
        if (castlingPart.includes('Q')) inputBuffer[13 * 64 + i] = 1.0;
        if (castlingPart.includes('k')) inputBuffer[14 * 64 + i] = 1.0;
        if (castlingPart.includes('q')) inputBuffer[15 * 64 + i] = 1.0;
    }
    
    // 16: En Passant
    const epPart = fen.split(' ')[3];
    if (epPart !== '-') {
        const f = epPart.charCodeAt(0) - 97;
        const r = parseInt(epPart[1]) - 1;
        inputBuffer[16 * 64 + (r * 8 + f)] = 1.0;
    }
    
    // 17: Turn
    const turnPart = fen.split(' ')[1];
    if (turnPart === 'w') {
        for (let i=0; i<64; i++) inputBuffer[17 * 64 + i] = 1.0;
    }

    // 18-19: Attack Maps (Tactical Vision)
    // We get attacks by looking at ALL possible moves for both colors
    const originalFen = chess.fen();
    
    // Current side attacks
    const currentMoves = chess.moves({ verbose: true });
    const currentOffset = chess.turn() === 'w' ? 18 : 19;
    for (const m of currentMoves) {
        const sq = uciToSq(m.to);
        inputBuffer[currentOffset * 64 + sq] = 1.0;
    }
    
    // Opponent attacks (simulated by switching turn)
    // We use a temporary chess instance to avoid corrupting the search state
    let tempChess = new Chess(originalFen);
    let tokens = originalFen.split(' ');
    tokens[1] = tokens[1] === 'w' ? 'b' : 'w';
    tempChess.load(tokens.join(' '));
    const opponentMoves = tempChess.moves({ verbose: true });
    const opponentOffset = tokens[1] === 'w' ? 18 : 19;
    for (const m of opponentMoves) {
        const sq = uciToSq(m.to);
        inputBuffer[opponentOffset * 64 + sq] = 1.0;
    }

    return new ort.Tensor('float32', inputBuffer, [1, 20, 8, 8]);
}

async function loadModel() {
    if (modelLoadingPromise) return modelLoadingPromise;
    
    modelLoadingPromise = (async () => {
        try {
            // Download the ONNX model from the FastAPI endpoint
            session = await ort.InferenceSession.create('http://localhost:8000/api/model.onnx', { 
                executionProviders: ['wasm'] 
            });
            postMessage({ type: 'STATUS', msg: 'Tactical Model loaded successfully' });
        } catch (e) {
            console.error("MCTS Worker: Failed to load model", e);
            postMessage({ type: 'STATUS', msg: 'Failed to load Tactical ONNX model: ' + e.message });
            modelLoadingPromise = null; // Allow retry
        }
    })();
    
    return modelLoadingPromise;
}

// Evaluate a board using the Tactical ONNX model
async function evaluate(chess) {
    const tensor = buildTensor(chess);
    const results = await session.run({ input: tensor });
    // Returns policy (1, 4096), value (1, 1), and material (1, 1)
    return {
        policy: results.policy.data, 
        value: results.value.data[0],
        material: results.material.data[0] // Added auxiliary material prediction
    };
}

class MCTSNode {
    constructor(fen, parent = null, move = null) {
        this.fen = fen;
        this.parent = parent;
        this.move = move; // The move that led here
        
        this.N = 0; // Visit count
        this.W = 0; // Total value
        this.Q = 0; // Average value
        
        this.children = [];
        this.isExpanded = false;
        
        this.P = []; // Prior probabilities for children
        this.legalMoves = [];
    }
    
    async expand(chessInstance) {
        if (this.isExpanded) return;
        
        chessInstance.load(this.fen);
        const moves = chessInstance.moves({ verbose: true });
        this.legalMoves = moves.map(m => m.from + m.to + (m.promotion ? m.promotion : ''));
        
        if (this.legalMoves.length === 0) {
            this.isExpanded = true;
            return;
        }
        
        // Evaluate neural network
        const { policy, value } = await evaluate(chessInstance);
        
        let sumP = 0;
        this.P = this.legalMoves.map(moveStr => {
            const fromSq = uciToSq(moveStr.substring(0, 2));
            const toSq = uciToSq(moveStr.substring(2, 4));
            const pIndex = fromSq * 64 + toSq;
            // Use softmax distribution approximations over logits
            const pVal = Math.exp(policy[pIndex]); 
            sumP += pVal;
            return pVal;
        });
        
        // Normalize probabilities
        if (sumP > 0) {
            this.P = this.P.map(p => p / sumP);
        } else {
            this.P = this.P.map(p => 1.0 / this.P.length); // Uniform if all zero
        }
        
        this.isExpanded = true;
        // Optimization: Delete FEN once expanded to free memory, BUT only if it's not the root
        // as the root FEN is needed to reset the board for every simulation.
        if (this.parent) delete this.fen; 
        return value;
    }
    
    // Inject Dirichlet Noise for exploration at the root
    applyDirichletNoise(epsilon = 0.25) {
        const alpha = 0.3; // Standard for Chess
        const noise = new Array(this.P.length).fill(0).map(() => -Math.log(Math.random()) / alpha);
        const sumNoise = noise.reduce((a, b) => a + b, 0);
        
        for (let i = 0; i < this.P.length; i++) {
            this.P[i] = (1 - epsilon) * this.P[i] + epsilon * (noise[i] / sumNoise);
        }
    }
    
    selectChild(cpuct = 1.5) {
        let bestScore = -Infinity;
        let bestChild = null;
        let bestMoveIndex = -1;
        
        const fpuValue = this.Q - 0.2; 

        for (let i = 0; i < this.legalMoves.length; i++) {
            const move = this.legalMoves[i];
            let child = this.children.find(c => c.move === move);
            
            const q = child ? child.Q : fpuValue;
            const u = cpuct * this.P[i] * Math.sqrt(this.N + 1e-8) / (1 + (child ? child.N : 0));
            const score = q + u;
            
            if (score > bestScore) {
                bestScore = score;
                bestChild = child;
                bestMoveIndex = i;
            }
        }
        
        return { child: bestChild, move: this.legalMoves[bestMoveIndex] };
    }
    
    backup(value) {
        this.N += 1;
        this.W += value;
        this.Q = this.W / this.N;
        if (this.parent) {
            // Flip value for opponent perspective
            this.parent.backup(-value);
        }
    }
}

let currentRoot = null;

async function search(rootFen, numSimulations = 100, moveCount = 0, cpuct = 1.5, tempThreshold = 30, dirichletEps = 0.25) {
    if (currentRoot) {
        function disposeNode(node) {
            for (let child of node.children) {
                disposeNode(child);
            }
            node.children = [];
            node.parent = null;
        }
        disposeNode(currentRoot);
        currentRoot = null;
    }

    let chess = new Chess();
    let root = new MCTSNode(rootFen);
    currentRoot = root;
    
    await root.expand(chess);
    if (dirichletEps > 0) root.applyDirichletNoise(dirichletEps);
    
    for (let sim = 0; sim < numSimulations; sim++) {
        let node = root;
        chess.load(root.fen);
        
        // 1. Select
        while (node.isExpanded && node.legalMoves.length > 0) {
            const { child, move } = node.selectChild(cpuct);
            chess.move(move, {sloppy: true});
            
            if (child) {
                node = child;
            } else {
                const newChild = new MCTSNode(chess.fen(), node, move);
                node.children.push(newChild);
                node = newChild;
                break;
            }
        }
        
        // 2. Expand & Evaluate
        let value = 0;
        if (!chess.game_over()) {
            value = await node.expand(chess);
        } else {
            // Terminal node
            if (chess.in_checkmate()) {
                value = -1.0; // The previous player won! Note perspective flip happens in backup
            } else {
                value = 0.0;
            }
        }
        
        // 3. Backup
        node.backup(value);
    }
    
    let piArray = new Array(4096).fill(0);
    for (let child of root.children) {
        // Save visit counts into the training policy tensor dimension
        const fromSq = uciToSq(child.move.substring(0, 2));
        const toSq = uciToSq(child.move.substring(2, 4));
        piArray[fromSq * 64 + toSq] = child.N;
    }
    
    // piArray normalization and Move selection logic... (keeping as is)
    const sumN = Math.max(1, root.N);
    piArray = piArray.map(n => n / sumN);
    
    // Selection logic...
    let bestMove = null;
    // Dynamic Temperature: controlled by user-set threshold
    let temperature = moveCount < tempThreshold ? 1.0 : 0.1;
    
    if (temperature > 0.0) {
        let r = Math.random();
        let cumulative = 0;
        for (let child of root.children) {
            const prob = child.N / sumN;
            cumulative += prob;
            if (r <= cumulative) {
                bestMove = child.move;
                break;
            }
        }
    } else {
        let bestVisitCount = -1;
        for (let child of root.children) {
            if (child.N > bestVisitCount) {
                bestVisitCount = child.N;
                bestMove = child.move;
            }
        }
    }
    
    return { bestMove, piArray };
}

onmessage = async function(e) {
    if (e.data.type === 'START') {
        const fen = e.data.fen;
        try {
            // Ensure model is loaded before starting the search
            await loadModel();
            
            if (!session) {
                throw new Error("Model session not initialized");
            }

            const sims = e.data.sims || 50;
            const cpuct = e.data.cpuct || 1.5;
            const tempThreshold = e.data.tempThreshold !== undefined ? e.data.tempThreshold : 30;
            const dirichletEps = e.data.dirichletEps !== undefined ? e.data.dirichletEps : 0.25;
            const res = await search(fen, sims, e.data.moveCount || 0, cpuct, tempThreshold, dirichletEps);
            postMessage({ type: 'MOVE', move: res.bestMove, pi: Array.from(res.piArray) });
        } catch (err) {
            console.error("MCTS Search Error:", err);
            postMessage({ type: 'ERROR', msg: err.message });
        }
    }
};

loadModel();
