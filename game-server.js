
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const games = new Map();
const socketMetadata = new Map();
const GAME_TIMEOUT_MS = 5 * 60 * 1000; // Remove games waiting for 5 minutes (likely broken)

const getEnrichedGamesList = () => {
  const now = Date.now();
  const validGames = [];
  
  // Remove expired games that have been waiting too long
  for (const [gameId, game] of games.entries()) {
    if (game.status === 'waiting' && (now - game.createdAt) > GAME_TIMEOUT_MS) {
      console.log(`[✗ Server] Removing expired waiting room: ${gameId}`);
      games.delete(gameId);
      continue;
    }
    validGames.push(game);
  }

  return validGames.map(game => {
    const room = io.sockets.adapter.rooms.get(game.id);
    const onlineCount = room ? room.size : 0;
    
    const onlineNames = [];
    if (room) {
      for (const socketId of room) {
        const meta = socketMetadata.get(socketId);
        if (meta && meta.userName) {
          onlineNames.push(meta.userName);
        }
      }
    }

    // Ensure all required fields are present
    let enrichedGame = {
      ...game,
      onlineCount,
      onlineNames: [...new Set(onlineNames)],
      // Ensure these fields always exist
      guestId: game.guestId || '',
      guestName: game.guestName || '',
      guestAvatar: game.guestAvatar || '',
      hostId: game.hostId || '',
      hostName: game.hostName || '',
      hostAvatar: game.hostAvatar || '',
      status: game.status || 'waiting'
    };
    
    // If player2 is connected but guestId not at root level, get from state
    if (game.state?.player2?.uid && !game.guestId) {
      enrichedGame.guestId = game.state.player2.uid;
    }
    
    return enrichedGame;
  });
};

// Function to broadcast games list to ALL connected clients
const broadcastGamesList = () => {
  try {
    const enrichedList = getEnrichedGamesList();
    console.log(`[■ Server] Broadcasting ${enrichedList.length} games to all sockets`);
    // Use io.sockets.emit to reach all connected clients
    io.sockets.emit('games_list', enrichedList);
  } catch (e) {
    console.error(`[✗ Server] Error broadcasting games list:`, e.message);
  }
};

io.on('connection', (socket) => {
  console.log(`[✓ Server] Connected: ${socket.id}`);

  socket.on('get_games_list', () => {
    try {
      const list = getEnrichedGamesList();
      socket.emit('games_list', list);
      console.log(`[■ Server] Sent ${list.length} games to ${socket.id}`);
    } catch (e) {
      console.error(`[✗ Server] Error sending games list:`, e.message);
    }
  });

  socket.on('get_game', (sessionId) => {
    try {
      const game = games.get(sessionId);
      if (game) {
        socket.emit('game_sync', game);
        console.log(`[■ Server] Sent game sync for ${sessionId}`);
      } else {
        console.warn(`[! Server] Game ${sessionId} not found`);
        socket.emit('game_sync', null);
      }
    } catch (e) {
      console.error(`[✗ Server] Error getting game ${sessionId}:`, e.message);
    }
  });

  socket.on('create_game', (session) => {
    try {
      if (!session || !session.id) {
        console.error(`[✗ Server] Invalid session data`);
        return;
      }
      session.createdAt = Date.now();
      games.set(session.id, session);
      socketMetadata.set(socket.id, { userId: session.hostId, userName: session.hostName, sessionId: session.id });
      socket.join(session.id);
      
      console.log(`[+ Server] Game created: ${session.id} by ${session.hostName}`);
      
      // Broadcast updated list to ALL connected clients (not just creator)
      broadcastGamesList();
      
      // Also send game_sync to the creator
      socket.emit('game_sync', session);
      console.log(`[+ Server] Creator notified of game: ${session.id}`);
    } catch (e) {
      console.error(`[✗ Server] Error creating game:`, e.message);
    }
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    try {
      const game = games.get(sessionId);
      if (!game) {
        console.warn(`[! Server] Cannot join: Game ${sessionId} not found`);
        socket.emit('error', { message: 'Game not found' });
        return;
      }
      
      if (updates) {
        Object.assign(game, updates);
        games.set(sessionId, game);
        console.log(`[~ Server] Game ${sessionId} updated with new player`);
      }
      
      socketMetadata.set(socket.id, { 
        userId: updates?.guestId || game.guestId || 'spectator', 
        userName: updates?.guestName || game.guestName || 'Наблюдатель', 
        sessionId: sessionId 
      });

      socket.join(sessionId);
      
      // Send updated game state to all players in this room
      io.to(sessionId).emit('game_sync', game);
      
      // Broadcast updated list to ALL connected clients
      broadcastGamesList();
      
      console.log(`[+ Server] Player joined game: ${sessionId}`);
    } catch (e) {
      console.error(`[✗ Server] Error joining game:`, e.message);
    }
  });

  socket.on('rejoin_game', (sessionId) => {
    try {
      const game = games.get(sessionId);
      if (!game) {
        console.warn(`[! Server] Cannot rejoin: Game ${sessionId} not found`);
        return;
      }
      socket.join(sessionId);
      socket.emit('game_sync', game);
      broadcastGamesList();
      console.log(`[↻ Server] Player rejoined game: ${sessionId}`);
    } catch (e) {
      console.error(`[✗ Server] Error rejoining game:`, e.message);
    }
  });

  socket.on('update_game', ({ sessionId, updates }) => {
    try {
      const game = games.get(sessionId);
      if (!game) {
        console.warn(`[! Server] Cannot update: Game ${sessionId} not found`);
        return;
      }
      
      if (updates.state) {
        const mergedState = { ...game.state };
        if (updates.state.player1) mergedState.player1 = { ...mergedState.player1, ...updates.state.player1 };
        if (updates.state.player2) mergedState.player2 = { ...mergedState.player2, ...updates.state.player2 };
        game.state = mergedState;
      }
      if (updates.currentTurnId !== undefined) game.currentTurnId = updates.currentTurnId;
      if (updates.lastAction) game.lastAction = updates.lastAction;
      if (updates.status) game.status = updates.status;
      if (updates.winnerId) game.winnerId = updates.winnerId;

      games.set(sessionId, game);
      io.to(sessionId).emit('game_sync', game);
      broadcastGamesList();
    } catch (e) {
      console.error(`[✗ Server] Error updating game ${sessionId}:`, e.message);
    }
  });

  socket.on('delete_game', (sessionId) => {
    try {
      if (games.has(sessionId)) {
        games.delete(sessionId);
        console.log(`[✗ Server] Game ${sessionId} deleted`);
        broadcastGamesList();
        io.in(sessionId).socketsLeave(sessionId);
      }
    } catch (e) {
      console.error(`[✗ Server] Error deleting game:`, e.message);
    }
  });

  socket.on('disconnect', (reason) => {
    try {
      const meta = socketMetadata.get(socket.id);
      if (meta) {
        console.log(`[✗ Server] Player disconnected: ${meta.userName} (${reason})`);
        socketMetadata.delete(socket.id);
        broadcastGamesList();
      }
    } catch (e) {
      console.error(`[✗ Server] Error on disconnect:`, e.message);
    }
  });

  socket.on('error', (err) => {
    console.error(`[✗ Server] Socket error for ${socket.id}:`, err);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Сервер Арены готов к работе`);
});
