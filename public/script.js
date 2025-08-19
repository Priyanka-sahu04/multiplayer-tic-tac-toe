const SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3002'
    : window.location.origin;

// Game state
let gameState = {
    roomCode: null,
    players: [],
    currentPlayer: 'X',
    board: Array(9).fill(''),
    gameStatus: 'waiting',
    winner: null,
    playerSymbol: null,
    isMyTurn: false,
    playerName: 'Player'
};

// Socket connection
let socket = null;
let connectionAttempts = 0;
const maxConnectionAttempts = 10;

// Debug mode - set to false for production
const DEBUG_MODE = true;

function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        console.log(`[DEBUG] ${message}`, data || '');
        const debugContent = document.getElementById('debug-content');
        if (debugContent) {
            const timestamp = new Date().toLocaleTimeString();
            debugContent.innerHTML += `${timestamp}: ${message}${data ? ': ' + JSON.stringify(data) : ''}<br>`;
            debugContent.scrollTop = debugContent.scrollHeight;
            document.getElementById('debug-info').classList.remove('hidden');
        }
    }
}

function initializeSocket() {
    if (socket) {
        socket.disconnect();
    }

    debugLog('Initializing socket connection', { serverUrl: SERVER_URL });

    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: maxConnectionAttempts,
        forceNew: true
    });

    socket.on('connect', () => {
        console.log('Connected to server');
        connectionAttempts = 0;
        updateConnectionStatus('connected', 'Connected');
        debugLog('Socket connected', { socketId: socket.id });
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        updateConnectionStatus('disconnected', 'Disconnected');
        debugLog('Socket disconnected', { reason });
    });

    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        connectionAttempts++;
        debugLog('Connection error', { error: error.message || 'websocket error', attempts: connectionAttempts });

        if (connectionAttempts >= maxConnectionAttempts) {
            showError('Failed to connect to server. Please refresh and try again.');
            updateConnectionStatus('disconnected', 'Connection failed');
        } else {
            updateConnectionStatus('disconnected', `Reconnecting... (${connectionAttempts}/${maxConnectionAttempts})`);
        }
    });

    socket.on('room-joined', (data) => {
        console.log('Room joined:', data);
        debugLog('Room joined', data);
        gameState = { ...gameState, ...data };
        onRoomJoined(data);
    });

    socket.on('player-info', (data) => {
        console.log('Player info received:', data);
        debugLog('Player info received', data);
        gameState.playerSymbol = data.symbol;
        gameState.isMyTurn = data.isMyTurn;
        debugLog('Updated game state after player-info', {
            playerSymbol: gameState.playerSymbol,
            isMyTurn: gameState.isMyTurn,
            currentPlayer: gameState.currentPlayer
        });
        updateGameDisplay();
    });

    socket.on('game-updated', (data) => {
        console.log('Game updated:', data);
        debugLog('Game updated', data);
        gameState = { ...gameState, ...data };
        updateGameDisplay();
    });

    socket.on('game-reset', (data) => {
        console.log('Game reset:', data);
        debugLog('Game reset', data);
        gameState = { ...gameState, ...data };
        hideElement('game-controls');
        updateGameDisplay();
    });

    socket.on('player-disconnected', (data) => {
        console.log('Player disconnected:', data);
        debugLog('Player disconnected', data);
        showError(`Player ${data.symbol} disconnected. Waiting for reconnection...`);
        updateConnectionStatus('waiting', 'Waiting for opponent to reconnect...');
    });

    socket.on('error', (data) => {
        console.error('Server error:', data);
        debugLog('Server error', data);
        showError(data.message || 'An error occurred');
        hideLoading();
    });
}

function initializeBoard() {
    const boardElement = document.getElementById('game-board');
    boardElement.innerHTML = '';

    for (let i = 0; i < 9; i++) {
        const cell = document.createElement('button');
        cell.className = 'cell';
        cell.setAttribute('data-index', i);
        cell.onclick = () => makeMove(i);
        boardElement.appendChild(cell);
    }
}

function createRoom() {
    const playerName = document.getElementById('player-name-input').value.trim() || 'Player';
    gameState.playerName = playerName;

    showLoading();
    hideError();
    debugLog('Creating room', { playerName });

    fetch(`${SERVER_URL}/api/create-room`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ playerName })
    })
        .then(response => response.json())
        .then(data => {
            debugLog('Room created response', data);
            if (data.success) {
                const roomCode = data.roomCode;
                gameState.roomCode = roomCode;

                // Join the created room
                socket.emit('join-room', {
                    roomCode: roomCode,
                    playerName: playerName
                });

                showElement('room-display');
                showElement('connection-status');
                hideElement('room-selection');

                document.getElementById('room-code').textContent = roomCode;
                updateConnectionStatus('waiting', 'Waiting for opponent to join...');
            } else {
                throw new Error(data.error || 'Failed to create room');
            }
        })
        .catch(error => {
            console.error('Error creating room:', error);
            debugLog('Error creating room', { error: error.message });
            showError('Failed to create room. Please try again.');
        })
        .finally(() => {
            hideLoading();
        });
}

function joinRoom() {
    const roomCodeInput = document.getElementById('room-code-input');
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    const playerName = document.getElementById('player-name-input').value.trim() || 'Player';

    if (roomCode.length !== 6) {
        showError('Please enter a valid 6-character room code');
        return;
    }

    gameState.playerName = playerName;
    gameState.roomCode = roomCode;

    showLoading();
    hideError();
    debugLog('Joining room', { roomCode, playerName });

    // Join the room via socket
    socket.emit('join-room', {
        roomCode: roomCode,
        playerName: playerName
    });
}

function onRoomJoined(data) {
    hideLoading();
    hideError();
    debugLog('Room joined successfully', data);

    showElement('room-display');
    hideElement('room-selection');

    document.getElementById('room-code').textContent = data.roomCode;

    if (data.gameStatus === 'playing' && data.players.length === 2) {
        debugLog('Game is ready to start - both players present');
        startGame(); // Connection status hide हो जाएगा और game UI show होगा
    } else if (data.gameStatus === 'waiting') {
        debugLog('Still waiting for opponent');
        updateConnectionStatus('waiting', 'Waiting for opponent to join...');
    }

    updateGameDisplay();
}

function startGame() {
    hideElement('connection-status');
    showElement('game-status');
    showElement('player-info');
    showElement('game-board');

    initializeBoard();
    updateGameDisplay();
    debugLog('Game started');
}

function makeMove(index) {
    debugLog('Attempting move', {
        index,
        boardValue: gameState.board[index],
        gameStatus: gameState.gameStatus,
        isMyTurn: gameState.isMyTurn,
        playerSymbol: gameState.playerSymbol,
        currentPlayer: gameState.currentPlayer
    });

    if (gameState.board[index] !== '') {
        debugLog('Move rejected: cell already filled');
        return;
    }

    if (gameState.gameStatus !== 'playing') {
        debugLog('Move rejected: game not in playing state');
        return;
    }

    if (!gameState.isMyTurn) {
        debugLog('Move rejected: not my turn');
        return;
    }

    debugLog('Making move', { position: index, roomCode: gameState.roomCode });

    // Emit move to server
    socket.emit('make-move', {
        roomCode: gameState.roomCode,
        position: index
    });
}

function resetGame() {
    debugLog('Resetting game');
    socket.emit('reset-game', {
        roomCode: gameState.roomCode
    });
}

function updateGameDisplay() {
    debugLog('Updating game display', {
        gameStatus: gameState.gameStatus,
        currentPlayer: gameState.currentPlayer,
        playerSymbol: gameState.playerSymbol,
        isMyTurn: gameState.isMyTurn,
        playersCount: gameState.players.length
    });

    updateBoardDisplay();
    updatePlayerDisplay();
    updateStatusDisplay();

    // Start game if both players are present and game is playing
    if (gameState.gameStatus === 'playing' && gameState.players.length === 2) {
        if (document.getElementById('game-board').classList.contains('hidden')) {
            startGame();
        }
    }
}

function updateBoardDisplay() {
    const cells = document.querySelectorAll('.cell');
    cells.forEach((cell, index) => {
        const value = gameState.board[index];
        cell.textContent = value;
        cell.className = 'cell';

        if (value === 'X') {
            cell.classList.add('x', 'filled');
        } else if (value === 'O') {
            cell.classList.add('o', 'filled');
        }

        // More explicit disable logic
        const shouldDisable = value !== '' ||
            gameState.gameStatus !== 'playing' ||
            !gameState.isMyTurn;

        cell.disabled = shouldDisable;

        debugLog(`Cell ${index} state`, {
            value,
            disabled: shouldDisable,
            gameStatus: gameState.gameStatus,
            isMyTurn: gameState.isMyTurn
        });
    });
}

function updatePlayerDisplay() {
    const playerX = document.getElementById('player-x');
    const playerO = document.getElementById('player-o');

    if (!playerX || !playerO) return;

    // Clear current player highlighting
    playerX.classList.remove('current-player');
    playerO.classList.remove('current-player');

    // Highlight current player
    if (gameState.currentPlayer === 'X') {
        playerX.classList.add('current-player');
    } else {
        playerO.classList.add('current-player');
    }

    // Update player names
    const xPlayer = gameState.players.find(p => p.symbol === 'X');
    const oPlayer = gameState.players.find(p => p.symbol === 'O');

    if (xPlayer) {
        const isMe = gameState.playerSymbol === 'X';
        playerX.querySelector('.player-name').textContent =
            xPlayer.name + (isMe ? ' (You)' : '');
    } else {
        playerX.querySelector('.player-name').textContent = 'Waiting...';
    }

    if (oPlayer) {
        const isMe = gameState.playerSymbol === 'O';
        playerO.querySelector('.player-name').textContent =
            oPlayer.name + (isMe ? ' (You)' : '');
    } else {
        playerO.querySelector('.player-name').textContent = 'Waiting...';
    }
}

function updateStatusDisplay() {
    let statusText = '';
    let statusClass = '';

    if (gameState.gameStatus === 'waiting') {
        statusText = 'Waiting for opponent...';
        statusClass = 'status-waiting';
    } else if (gameState.gameStatus === 'playing') {
        if (gameState.isMyTurn) {
            statusText = `Your Turn (${gameState.playerSymbol})`;
            statusClass = 'status-my-turn';
        } else {
            const opponentSymbol = gameState.playerSymbol === 'X' ? 'O' : 'X';
            statusText = `Opponent's Turn (${opponentSymbol})`;
            statusClass = 'status-opponent-turn';
        }
    } else if (gameState.gameStatus === 'finished') {
        showElement('game-controls');

        if (gameState.winner === 'draw' || gameState.winner === null) {
            statusText = "It's a Draw! 🤝";
            statusClass = 'status-finished';
        } else if (gameState.winner === gameState.playerSymbol) {
            statusText = "You Won! 🎉";
            statusClass = 'status-finished status-won';
        } else {
            statusText = "You Lost! 😔";
            statusClass = 'status-finished status-lost';
        }
    }

    if (statusText) {
        updateGameStatus(statusText, statusClass);
    }
}

function updateGameStatus(message, className = '') {
    const statusElement = document.getElementById('game-status');
    if (statusElement) {
        statusElement.textContent = message;
        statusElement.className = `game-status ${className}`;
    }
}

function updateConnectionStatus(status, message) {
    const statusElement = document.getElementById('connection-status');
    const textElement = document.getElementById('connection-text');

    if (statusElement && textElement) {
        statusElement.className = `connection-status ${status}`;
        textElement.textContent = message;
        showElement('connection-status');
    }
}

function copyRoomCode() {
    const roomCode = document.getElementById('room-code').textContent;
    const copyBtn = document.querySelector('.copy-btn');

    if (navigator.clipboard) {
        navigator.clipboard.writeText(roomCode).then(() => {
            showCopySuccess(copyBtn);
        }).catch(() => {
            fallbackCopyToClipboard(roomCode, copyBtn);
        });
    } else {
        fallbackCopyToClipboard(roomCode, copyBtn);
    }
}

function fallbackCopyToClipboard(text, btn) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    textarea.style.top = '-999999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        document.execCommand('copy');
        showCopySuccess(btn);
    } catch (err) {
        console.error('Failed to copy: ', err);
    }

    document.body.removeChild(textarea);
}

function showCopySuccess(btn) {
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.disabled = true;
    setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
    }, 2000);
}

function leaveRoom() {
    if (socket) {
        socket.disconnect();
    }

    // Reset game state
    gameState = {
        roomCode: null,
        players: [],
        currentPlayer: 'X',
        board: Array(9).fill(''),
        gameStatus: 'waiting',
        winner: null,
        playerSymbol: null,
        isMyTurn: false,
        playerName: 'Player'
    };

    // Show/hide UI elements
    showElement('room-selection');
    hideElement('room-display');
    hideElement('connection-status');
    hideElement('game-status');
    hideElement('player-info');
    hideElement('game-board');
    hideElement('game-controls');
    hideError();

    // Clear inputs
    document.getElementById('room-code-input').value = '';

    // Reconnect socket for future games
    setTimeout(() => {
        initializeSocket();
    }, 1000);
}

function showElement(id) {
    const element = document.getElementById(id);
    if (element) {
        element.classList.remove('hidden');
    }
}

function hideElement(id) {
    const element = document.getElementById(id);
    if (element) {
        element.classList.add('hidden');
    }
}

function showError(message) {
    const errorElement = document.getElementById('error-message');
    if (errorElement) {
        errorElement.textContent = message;
        showElement('error-message');
        setTimeout(() => {
            hideError();
        }, 5000);
    }
}

function hideError() {
    hideElement('error-message');
}

function showLoading() {
    showElement('loading');
}

function hideLoading() {
    hideElement('loading');
}

// Initialize the application
document.addEventListener('DOMContentLoaded', function () {
    initializeBoard();
    initializeSocket();

    // Keep player name input empty - just set placeholder
    document.getElementById('player-name-input').placeholder = 'Enter your name';
});

// Handle page visibility changes for reconnection
document.addEventListener('visibilitychange', function () {
    if (!document.hidden && socket && !socket.connected) {
        console.log('Page visible, attempting to reconnect...');
        socket.connect();
    }
});
