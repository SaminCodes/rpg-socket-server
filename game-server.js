
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

const cleanupEmptyGames = () => {
  let changed = false;
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    const room = io.sockets.adapter.rooms.get(id);
    if (!room || room.size === 0) {
      if (now - game.createdAt > 10000) {
        games.delete(id);
        changed = true;
      }
    }
  }
  if (changed) io.emit('games_list', Array.from(games.values()));
};

setInterval(cleanupEmptyGames, 30000);

io.on('connection', (socket) => {
  socket.on('get_games_list', () => {
    socket.emit('games_list', Array.from(games.values()));
  });

  socket.on('create_game', (session) => {
    session.createdAt = Date.now();
    games.set(session.id, session);
    io.emit('games_list', Array.from(games.values()));
    socket.join(session.id);
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      if (updates) {
        Object.assign(game, updates);
        games.set(sessionId, game); 
        io.emit('games_list', Array.from(games.values()));
      }
      socket.join(sessionId);
      socket.emit('game_sync', game);
    }
  });

  socket.on('rejoin_game', (sessionId) => {
    const game = games.get(sessionId);
    if (game) {
      socket.join(sessionId);
      socket.emit('game_sync', game);
    }
  });

  socket.on('update_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Глубокое слияние состояний игроков
      if (updates.state) {
        const mergedState = { ...game.state };
        if (updates.state.player1) {
          mergedState.player1 = { ...mergedState.player1, ...updates.state.player1 };
        }
        if (updates.state.player2) {
          mergedState.player2 = { ...mergedState.player2, ...updates.state.player2 };
        }
        game.state = mergedState;
      }
      
      if (updates.currentTurnId) game.currentTurnId = updates.currentTurnId;
      if (updates.lastAction) game.lastAction = updates.lastAction;
      if (updates.status) game.status = updates.status;
      if (updates.winnerId) game.winnerId = updates.winnerId;
      if (updates.guestId) game.guestId = updates.guestId;
      if (updates.guestName) game.guestName = updates.guestName;
      if (updates.guestAvatar) game.guestAvatar = updates.guestAvatar;

      games.set(sessionId, game);
      io.to(sessionId).emit('game_sync', game);
      
      if (updates.status || updates.guestId) {
         io.emit('games_list', Array.from(games.values()));
      }
    }
  });

  socket.on('delete_game', (sessionId) => {
    if (games.has(sessionId)) {
      games.delete(sessionId);
      io.emit('games_list', Array.from(games.values()));
      io.in(sessionId).socketsLeave(sessionId);
    }
  });

  socket.on('disconnect', () => {
    setTimeout(cleanupEmptyGames, 3000);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Игровой сервер запущен на порту ${PORT}`);
});
