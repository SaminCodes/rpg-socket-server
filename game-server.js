
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // В продакшене замените на ваш домен
    methods: ["GET", "POST"]
  }
});

// In-memory storage for games
// In a real production app, use Redis or a database
const games = new Map();

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  // --- LOBBY LOGIC ---

  // Запрос списка игр
  socket.on('get_games_list', () => {
    socket.emit('games_list', Array.from(games.values()));
  });

  // Создание игры
  socket.on('create_game', (session) => {
    games.set(session.id, session);
    // Рассылаем обновленный список всем, кто в лобби (или просто всем подключенным)
    io.emit('games_list', Array.from(games.values()));
    
    // Создатель сразу входит в комнату этой игры
    socket.join(session.id);
  });

  // --- GAMEPLAY LOGIC ---

  // Вход в конкретную игру (подписка на обновления)
  // join_game теперь принимает sessionId и опциональные updates (если игрок присоединяется как guest)
  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      // Если есть обновления (например, записался второй игрок), применяем их
      if (updates) {
        Object.assign(game, updates);
        // Обновляем состояние в общем списке
        games.set(sessionId, game); 
        io.emit('games_list', Array.from(games.values()));
      }

      socket.join(sessionId);
      // Отправляем текущее состояние подключившемуся
      socket.emit('game_sync', game);
      console.log(`Socket ${socket.id} joined game ${sessionId}`);
    }
  });

  // Переподключение к игре (без изменений данных)
  socket.on('rejoin_game', (sessionId) => {
    const game = games.get(sessionId);
    if (game) {
      socket.join(sessionId);
      socket.emit('game_sync', game);
    }
  });

  // Получение конкретной игры (синхронизация по запросу)
  socket.on('get_game', (sessionId) => {
    const game = games.get(sessionId);
    if (game) {
      socket.emit('game_sync', game);
    }
  });

  // Обновление состояния игры (ход, атака, мана и т.д.)
  socket.on('update_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      // Глубокое слияние (или поверхностное, в зависимости от структуры)
      // Для простоты здесь используем Object.assign, но для вложенных state лучше deep merge
      // В данном случае React-клиент обычно шлет полный state или критические секции
      
      if (updates.state) {
         game.state = { ...game.state, ...updates.state };
      }
      if (updates.currentTurnId) game.currentTurnId = updates.currentTurnId;
      if (updates.lastAction) game.lastAction = updates.lastAction;
      if (updates.status) game.status = updates.status;
      if (updates.winnerId) game.winnerId = updates.winnerId;
      if (updates.guestId) game.guestId = updates.guestId;
      if (updates.guestName) game.guestName = updates.guestName;
      if (updates.guestAvatar) game.guestAvatar = updates.guestAvatar;

      games.set(sessionId, game);
      
      // Рассылаем обновление всем в комнате
      io.to(sessionId).emit('game_sync', game);
      
      // Если статус поменялся (например, finished), обновляем список в лобби
      if (updates.status) {
         io.emit('games_list', Array.from(games.values()));
      }
    }
  });

  // Удаление игры
  socket.on('delete_game', (sessionId) => {
    if (games.has(sessionId)) {
      games.delete(sessionId);
      io.emit('games_list', Array.from(games.values()));
      // Можно выкинуть всех из комнаты
      io.in(sessionId).socketsLeave(sessionId);
    }
  });

  // Эмоции / Реакции
  socket.on('emote', ({ roomId, emoteId, userId }) => {
    socket.to(roomId).emit('emote', { emoteId, userId });
  });

  socket.on('disconnect', () => {
    // console.log('Игрок отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Игровой сервер запущен на порту ${PORT}`);
});
