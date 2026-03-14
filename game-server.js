
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
  console.log(`[Server] Connected: ${socket.id}`);

  socket.on('get_games_list', () => {
    socket.emit('games_list', getEnrichedGamesList());
  });

  socket.on('create_game', (session) => {
    session.createdAt = Date.now();
    games.set(session.id, session);
    socketMetadata.set(socket.id, { userId: session.hostId, userName: session.hostName, sessionId: session.id });
    socket.join(session.id);
    io.emit('games_list', getEnrichedGamesList());
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      if (updates) {
        Object.assign(game, updates);
        games.set(sessionId, game); 
      }
      
      socketMetadata.set(socket.id, { 
        userId: updates?.guestId || game.guestId || 'spectator', 
        userName: updates?.guestName || game.guestName || 'Наблюдатель', 
        sessionId: sessionId 
      });

      socket.join(sessionId);
      socket.emit('game_sync', game);
      io.emit('games_list', getEnrichedGamesList());
    }
  });

  socket.on('rejoin_game', (sessionId) => {
      const game = games.get(sessionId);
      if (game) {
          socket.join(sessionId);
          socket.emit('game_sync', game);
          io.emit('games_list', getEnrichedGamesList());
      }
  });

  socket.on('update_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      if (updates.state) {
        const mergedState = { ...game.state };
        if (updates.state.player1) mergedState.player1 = { ...mergedState.player1, ...updates.state.player1 };
        if (updates.state.player2) mergedState.player2 = { ...mergedState.player2, ...updates.state.player2 };
        game.state = mergedState;
      }
      if (updates.currentTurnId) game.currentTurnId = updates.currentTurnId;
      if (updates.lastAction) game.lastAction = updates.lastAction;
      if (updates.status) game.status = updates.status;
      if (updates.winnerId) game.winnerId = updates.winnerId;

      games.set(sessionId, game);
      io.to(sessionId).emit('game_sync', game);
      io.emit('games_list', getEnrichedGamesList());
    }
  });

  socket.on('delete_game', (sessionId) => {
    if (games.has(sessionId)) {
      games.delete(sessionId);
      console.log(`[Server] Game ${sessionId} manually deleted`);
      io.emit('games_list', getEnrichedGamesList());
      io.in(sessionId).socketsLeave(sessionId);
    }
  });

  socket.on('disconnect', () => {
    const meta = socketMetadata.get(socket.id);
    if (meta) {
      socketMetadata.delete(socket.id);
      // Уменьшена задержка обновления списка при отключении
      io.emit('games_list', getEnrichedGamesList());
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Сервер Арены готов к работе`);
});
