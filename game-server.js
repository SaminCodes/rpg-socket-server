
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

// Хранилище игр в памяти
const games = new Map();

// Функция для очистки пустых игр
const cleanupEmptyGames = () => {
  let changed = false;
  for (const [id, game] of games.entries()) {
    const room = io.sockets.adapter.rooms.get(id);
    // Если в комнате 0 человек и игре больше 10 секунд (даем время на вход создателю)
    if (!room || room.size === 0) {
      if (Date.now() - game.createdAt > 10000) {
        games.delete(id);
        changed = true;
        console.log(`Игра ${id} удалена (пустой стол)`);
      }
    }
  }
  if (changed) {
    io.emit('games_list', Array.from(games.values()));
  }
};

// Проверка каждые 30 секунд для надежности
setInterval(cleanupEmptyGames, 30000);

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  socket.on('get_games_list', () => {
    socket.emit('games_list', Array.from(games.values()));
  });

  socket.on('create_game', (session) => {
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
      if (updates.state) game.state = { ...game.state, ...updates.state };
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
    // При отключении проверяем все комнаты, в которых был игрок
    // Но проще запустить общую проверку с небольшой задержкой
    setTimeout(cleanupEmptyGames, 2000);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Игровой сервер запущен на порту ${PORT}`);
});
