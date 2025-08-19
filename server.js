const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Neon DB connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize database tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_rooms (
        id SERIAL PRIMARY KEY,
        room_code VARCHAR(6) UNIQUE NOT NULL,
        player1_id VARCHAR(255),
        player2_id VARCHAR(255),
        current_player CHAR(1) DEFAULT 'X',
        board TEXT DEFAULT '         ',
        game_status VARCHAR(20) DEFAULT 'waiting',
        winner CHAR(1),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        socket_id VARCHAR(255) UNIQUE NOT NULL,
        room_code VARCHAR(6),
        symbol CHAR(1),
        name VARCHAR(100) DEFAULT 'Anonymous',
        connected BOOLEAN DEFAULT true,
        joined_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('Database tables initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Utility functions
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function boardToArray(boardString) {
  return boardString.split('').map(char => char === ' ' ? '' : char);
}

function arrayToBoard(boardArray) {
  return boardArray.map(cell => cell || ' ').join('');
}

function checkWinner(board) {
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
    [0, 4, 8], [2, 4, 6] // diagonals
  ];

  for (let pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }

  if (board.every(cell => cell !== '')) {
    return 'draw';
  }

  return null;
}

// Helper function to send player-specific info to all players in room
async function sendPlayerInfo(roomCode) {
  const roomResult = await pool.query(
    'SELECT * FROM game_rooms WHERE room_code = $1',
    [roomCode]
  );
  
  if (roomResult.rows.length === 0) return;
  
  const room = roomResult.rows[0];
  const players = await pool.query(
    'SELECT * FROM players WHERE room_code = $1 AND connected = true',
    [roomCode]
  );
  
  // Send player-specific info to each connected player
  players.rows.forEach(player => {
    const socket = io.sockets.sockets.get(player.socket_id);
    if (socket) {
      socket.emit('player-info', {
        symbol: player.symbol,
        isMyTurn: player.symbol === room.current_player && room.game_status === 'playing'
      });
    }
  });
}

// API Routes
app.post('/api/create-room', async (req, res) => {
  try {
    let roomCode;
    let attempts = 0;
    
    // Generate unique room code
    do {
      roomCode = generateRoomCode();
      attempts++;
      
      const existing = await pool.query(
        'SELECT room_code FROM game_rooms WHERE room_code = $1',
        [roomCode]
      );
      
      if (existing.rows.length === 0) break;
      
    } while (attempts < 10);

    if (attempts >= 10) {
      return res.status(500).json({ error: 'Unable to generate unique room code' });
    }

    // Create room in database
    await pool.query(
      'INSERT INTO game_rooms (room_code) VALUES ($1)',
      [roomCode]
    );

    res.json({ roomCode, success: true });
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.get('/api/room/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM game_rooms WHERE room_code = $1',
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const room = result.rows[0];
    const players = await pool.query(
      'SELECT * FROM players WHERE room_code = $1 AND connected = true',
      [code]
    );

    res.json({
      room: {
        ...room,
        board: boardToArray(room.board)
      },
      players: players.rows
    });
  } catch (err) {
    console.error('Error fetching room:', err);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', async (data) => {
    try {
      const { roomCode, playerName = 'Anonymous' } = data;

      // Check if room exists
      const roomResult = await pool.query(
        'SELECT * FROM game_rooms WHERE room_code = $1',
        [roomCode]
      );

      if (roomResult.rows.length === 0) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const room = roomResult.rows[0];

      // Check current players in room
      const playersResult = await pool.query(
        'SELECT * FROM players WHERE room_code = $1 AND connected = true',
        [roomCode]
      );

      if (playersResult.rows.length >= 2) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }

      // Determine player symbol
      const isFirstPlayer = playersResult.rows.length === 0;
      const symbol = isFirstPlayer ? 'X' : 'O';

      // Add player to database
      await pool.query(
        'INSERT INTO players (socket_id, room_code, symbol, name) VALUES ($1, $2, $3, $4) ON CONFLICT (socket_id) DO UPDATE SET room_code = $2, symbol = $3, name = $4, connected = true',
        [socket.id, roomCode, symbol, playerName]
      );

      // Join socket room
      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.playerSymbol = symbol;

      // Update room with player info
      if (isFirstPlayer) {
        await pool.query(
          'UPDATE game_rooms SET player1_id = $1, updated_at = NOW() WHERE room_code = $2',
          [socket.id, roomCode]
        );
      } else {
        await pool.query(
          'UPDATE game_rooms SET player2_id = $1, game_status = $2, updated_at = NOW() WHERE room_code = $3',
          [socket.id, 'playing', roomCode]
        );
      }

      // Get updated room state
      const updatedRoom = await pool.query(
        'SELECT * FROM game_rooms WHERE room_code = $1',
        [roomCode]
      );

      const allPlayers = await pool.query(
        'SELECT * FROM players WHERE room_code = $1 AND connected = true',
        [roomCode]
      );

      // Emit room state to all players in room
      const gameState = {
        roomCode,
        board: boardToArray(updatedRoom.rows[0].board),
        currentPlayer: updatedRoom.rows[0].current_player,
        gameStatus: updatedRoom.rows[0].game_status,
        winner: updatedRoom.rows[0].winner,
        players: allPlayers.rows
      };

      io.to(roomCode).emit('room-joined', gameState);

      // Send player-specific info to all players
      await sendPlayerInfo(roomCode);

    } catch (err) {
      console.error('Error joining room:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('make-move', async (data) => {
    try {
      const { roomCode, position } = data;

      if (!socket.roomCode || socket.roomCode !== roomCode) {
        socket.emit('error', { message: 'Not in this room' });
        return;
      }

      // Get current room state
      const roomResult = await pool.query(
        'SELECT * FROM game_rooms WHERE room_code = $1',
        [roomCode]
      );

      if (roomResult.rows.length === 0) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const room = roomResult.rows[0];
      
      // Validate move
      if (room.game_status !== 'playing') {
        socket.emit('error', { message: 'Game not in progress' });
        return;
      }

      if (room.current_player !== socket.playerSymbol) {
        socket.emit('error', { message: 'Not your turn' });
        return;
      }

      const boardArray = boardToArray(room.board);
      
      if (position < 0 || position > 8 || boardArray[position] !== '') {
        socket.emit('error', { message: 'Invalid move' });
        return;
      }

      // Make the move
      boardArray[position] = socket.playerSymbol;
      const newBoard = arrayToBoard(boardArray);

      // Check for winner
      const winner = checkWinner(boardArray);
      const nextPlayer = socket.playerSymbol === 'X' ? 'O' : 'X';
      const gameStatus = winner ? 'finished' : 'playing';

      // Update database
      await pool.query(
        'UPDATE game_rooms SET board = $1, current_player = $2, game_status = $3, winner = $4, updated_at = NOW() WHERE room_code = $5',
        [newBoard, nextPlayer, gameStatus, winner === 'draw' ? null : winner, roomCode]
      );

      // Get updated room state
      const updatedRoom = await pool.query(
        'SELECT * FROM game_rooms WHERE room_code = $1',
        [roomCode]
      );

      const players = await pool.query(
        'SELECT * FROM players WHERE room_code = $1 AND connected = true',
        [roomCode]
      );

      // Emit updated game state to all players in room
      const gameState = {
        roomCode,
        board: boardToArray(updatedRoom.rows[0].board),
        currentPlayer: updatedRoom.rows[0].current_player,
        gameStatus: updatedRoom.rows[0].game_status,
        winner: updatedRoom.rows[0].winner,
        players: players.rows,
        lastMove: { position, player: socket.playerSymbol }
      };

      io.to(roomCode).emit('game-updated', gameState);

      // Send updated player-specific info to all players
      await sendPlayerInfo(roomCode);

    } catch (err) {
      console.error('Error making move:', err);
      socket.emit('error', { message: 'Failed to make move' });
    }
  });

  socket.on('reset-game', async (data) => {
    try {
      const { roomCode } = data;

      if (!socket.roomCode || socket.roomCode !== roomCode) {
        socket.emit('error', { message: 'Not in this room' });
        return;
      }

      // Reset game state
      await pool.query(
        'UPDATE game_rooms SET board = $1, current_player = $2, game_status = $3, winner = NULL, updated_at = NOW() WHERE room_code = $4',
        ['         ', 'X', 'playing', roomCode]
      );

      // Get updated room state
      const updatedRoom = await pool.query(
        'SELECT * FROM game_rooms WHERE room_code = $1',
        [roomCode]
      );

      const players = await pool.query(
        'SELECT * FROM players WHERE room_code = $1 AND connected = true',
        [roomCode]
      );

      const gameState = {
        roomCode,
        board: boardToArray(updatedRoom.rows[0].board),
        currentPlayer: updatedRoom.rows[0].current_player,
        gameStatus: updatedRoom.rows[0].game_status,
        winner: null,
        players: players.rows
      };

      io.to(roomCode).emit('game-reset', gameState);

      // Send updated player-specific info to all players
      await sendPlayerInfo(roomCode);

    } catch (err) {
      console.error('Error resetting game:', err);
      socket.emit('error', { message: 'Failed to reset game' });
    }
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    
    try {
      // Mark player as disconnected
      await pool.query(
        'UPDATE players SET connected = false WHERE socket_id = $1',
        [socket.id]
      );

      if (socket.roomCode) {
        // Notify other players in room
        socket.to(socket.roomCode).emit('player-disconnected', {
          playerId: socket.id,
          symbol: socket.playerSymbol
        });

        // Check if room is empty and clean up after 5 minutes
        setTimeout(async () => {
          try {
            const activePlayers = await pool.query(
              'SELECT * FROM players WHERE room_code = $1 AND connected = true',
              [socket.roomCode]
            );

            if (activePlayers.rows.length === 0) {
              // Delete room and players if no one is connected
              await pool.query('DELETE FROM players WHERE room_code = $1', [socket.roomCode]);
              await pool.query('DELETE FROM game_rooms WHERE room_code = $1', [socket.roomCode]);
              console.log(`Cleaned up empty room: ${socket.roomCode}`);
            }
          } catch (err) {
            console.error('Error cleaning up room:', err);
          }
        }, 5 * 60 * 1000); // 5 minutes
      }
    } catch (err) {
      console.error('Error handling disconnect:', err);
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3002;

async function startServer() {
  try {
    await initDB();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Socket.IO server ready for connections`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully');
  await pool.end();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});