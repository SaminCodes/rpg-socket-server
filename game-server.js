
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

const getEnrichedGamesList = () => {
  return Array.from(games.values()).map(game => {
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

    return {
      ...game,
      onlineCount,
      onlineNames: [...new Set(onlineNames)]
    };
  });
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
      io.emit('games_list', getEnrichedGamesList());
      console.log(`[+ Server] Game created: ${session.id} by ${session.hostName}`);
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
      // ✓ ИСПРАВЛЕНО: отправляем игру ВСЕм в комнате, не только новому игроку
      io.to(sessionId).emit('game_sync', game);
      io.emit('games_list', getEnrichedGamesList());
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
      io.emit('games_list', getEnrichedGamesList());
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
      io.emit('games_list', getEnrichedGamesList());
    } catch (e) {
      console.error(`[✗ Server] Error updating game ${sessionId}:`, e.message);
    }
  });

  socket.on('delete_game', (sessionId) => {
    try {
      if (games.has(sessionId)) {
        games.delete(sessionId);
        console.log(`[✗ Server] Game ${sessionId} deleted`);
        io.emit('games_list', getEnrichedGamesList());
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
        io.emit('games_list', getEnrichedGamesList());
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
