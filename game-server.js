
// ЭТОТ ФАЙЛ НУЖНО ЗАПУСТИТЬ ОТДЕЛЬНО: node game-server.js
// Предварительно: npm install

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
// Enable CORS for all routes in Express
app.use(cors({ origin: true, credentials: true }));

const server = createServer(app);
const io = new Server(server, {
  cors: {
    // Dynamic origin handler to allow all origins while supporting credentials
    origin: (origin, callback) => {
      callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  }
});

// Хранилище игровых сессий в памяти
const games = {};

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  // Отправляем список ожидающих игр при подключении
  socket.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));

  // Создание новой игры
  socket.on('create_game', (session) => {
    console.log(`Создана игра: ${session.id} хост: ${session.hostName}`);
    games[session.id] = session;
    socket.join(session.id);
    
    // Рассылаем обновленный список игр всем
    io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    
    // Подтверждаем создание (синхронизируем стейт)
    socket.emit('game_sync', session);
  });

  // Присоединение к игре
  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games[sessionId];
    if (game) {
      console.log(`Игрок ${socket.id} присоединился к игре ${sessionId}`);
      // Применяем обновления (данные второго игрока, статус active)
      Object.assign(game, updates);
      
      socket.join(sessionId);
      
      // Отправляем обновленное состояние всем в комнате
      io.to(sessionId).emit('game_sync', game);
      
      // Обновляем список игр (игра больше не waiting)
      io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    } else {
      socket.emit('error', { message: 'Игра не найдена' });
    }
  });

  // Обновление состояния игры (ходы, атаки)
  socket.on('update_game', ({ sessionId, updates }) => {
    const game = games[sessionId];
    if (game) {
      // Глубокое слияние или поверхностное? Для простоты поверхностное, но state заменяем целиком если он есть
      if (updates.state) {
         game.state = updates.state;
      }
      if (updates.lastAction) {
         game.lastAction = updates.lastAction;
      }
      if (updates.currentTurnId) {
         game.currentTurnId = updates.currentTurnId;
      }
      if (updates.winnerId) {
         game.winnerId = updates.winnerId;
      }
      if (updates.status) {
         game.status = updates.status;
      }
      
      // Можно было бы использовать Object.assign(game, updates), но нужно быть осторожным с вложенностью
      // Для простоты прототипа:
      Object.assign(game, updates);

      // Рассылаем всем участникам (включая отправителя, для надежной синхронизации)
      io.to(sessionId).emit('game_sync', game);
    }
  });

  // Удаление игры
  socket.on('delete_game', (sessionId) => {
    if (games[sessionId]) {
      console.log(`Игра ${sessionId} удалена`);
      delete games[sessionId];
      io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    }
  });

  // Запрос списка игр вручную
  socket.on('get_games_list', () => {
    socket.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
  });

  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Игровой сервер запущен на порту ${PORT}`);
});
