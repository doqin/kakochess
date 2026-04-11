# Kakochess (Frontend)

A stunning, highly dynamic chess user interface built with Vite, Vanilla JavaScript, and `chessboard.js`.
It directly interfaces with the `kakochessbot` Python API to let you battle against a self-learning PyTorch model.

## Core Features
1. **Rich Aesthetics**: A fluid glassmorphism design with a modern dark-mode palette.
2. **Guest Mode (`index.html`)**: Play standard, consequence-free games against the AI.
3. **Admin Mode (`admin.html`)**: Train the model! Play a game and let the backend automatically initiate PyTorch backpropagation upon completion.

## Running Locally

1. Install all UI dependencies:
   ```bash
   npm install
   ```
2. Start the Vite development server (usually runs on `http://localhost:5173`):
   ```bash
   npm run dev
   ```

*(Ensure your FastApi `kakochessbot` server is running simultaneously on port 8000!)*
