
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

// Базовое состояние игрока (пустое)
const createEmptyPlayer = (uid) => ({
    uid: uid || '',
    health: 30,
    mana: { current: 1, max: 1 },
    hand: [],
    board: [],
    deck: [],
    fatigue: 0
});

// Хранилище игровых сессий с 3 ПУСТЫМИ столами
// hostId: 'system' означает, что стол свободен и первый зашедший станет Player 1
const games = {
    'table-1': {
        id: 'table-1',
        status: 'waiting',
        hostId: 'system', 
        hostName: 'Открытый Стол #1',
        hostAvatar: 'https://cdn-icons-png.flaticon.com/512/10613/10613919.png',
        currentTurnId: '',
        createdAt: Date.now(),
        state: {
            player1: createEmptyPlayer(''),
            player2: createEmptyPlayer('')
        }
    },
    'table-2': {
        id: 'table-2',
        status: 'waiting',
        hostId: 'system',
        hostName: 'Открытый Стол #2',
        hostAvatar: 'https://cdn-icons-png.flaticon.com/512/10613/10613919.png',
        currentTurnId: '',
        createdAt: Date.now(),
        state: {
            player1: createEmptyPlayer(''),
            player2: createEmptyPlayer('')
        }
    },
    'table-3': {
        id: 'table-3',
        status: 'waiting',
        hostId: 'system',
        hostName: 'Открытый Стол #3',
        hostAvatar: 'https://cdn-icons-png.flaticon.com/512/10613/10613919.png',
        currentTurnId: '',
        createdAt: Date.now(),
        state: {
            player1: createEmptyPlayer(''),
            player2: createEmptyPlayer('')
        }
    }
};

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  // Отправляем список ожидающих игр при подключении
  const waitingGames = Object.values(games).filter(g => g.status === 'waiting');
  socket.emit('games_list', waitingGames);

  // Создание новой игры (пользовательская)
  socket.on('create_game', (session) => {
    console.log(`Создана игра: ${session.id} хост: ${session.hostName}`);
    games[session.id] = session;
    socket.join(session.id);
    
    const waiting = Object.values(games).filter(g => g.status === 'waiting');
    io.emit('games_list', waiting);
    socket.emit('game_sync', session);
  });

  // Присоединение к игре (или занятие свободного стола)
  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games[sessionId];
    if (game) {
      console.log(`Игрок ${socket.id} обновляет игру ${sessionId}`);
      
      // Применяем обновления
      Object.assign(game, updates);
      
      // Если это был системный стол и теперь у него появился реальный хост (Player 1)
      if (game.hostId !== 'system' && game.state.player1.uid && !game.state.player2.uid) {
          // Игра все еще в статусе waiting (ждет P2), но теперь у нее есть владелец
          console.log(`Стол ${sessionId} занят игроком ${game.hostName}`);
      }

      socket.join(sessionId);
      
      // Отправляем обновленное состояние всем в комнате
      io.to(sessionId).emit('game_sync', game);
      
      // Обновляем список игр для всех (чтобы обновились аватарки/статусы столов)
      io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    } else {
      socket.emit('error', { message: 'Игра не найдена' });
    }
  });

  // Обновление состояния игры
  socket.on('update_game', ({ sessionId, updates }) => {
    const game = games[sessionId];
    if (game) {
      if (updates.state) game.state = updates.state;
      if (updates.lastAction) game.lastAction = updates.lastAction;
      if (updates.currentTurnId) game.currentTurnId = updates.currentTurnId;
      if (updates.winnerId) game.winnerId = updates.winnerId;
      if (updates.status) game.status = updates.status;
      
      Object.assign(game, updates);
      io.to(sessionId).emit('game_sync', game);
    }
  });

  // Удаление игры
  socket.on('delete_game', (sessionId) => {
    if (games[sessionId]) {
      // Если это один из системных столов, мы его не удаляем полностью, а сбрасываем!
      if (sessionId.startsWith('table-')) {
          console.log(`Сброс системного стола ${sessionId}`);
          games[sessionId] = {
              id: sessionId,
              status: 'waiting',
              hostId: 'system',
              hostName: `Открытый Стол #${sessionId.split('-')[1]}`,
              hostAvatar: 'https://cdn-icons-png.flaticon.com/512/10613/10613919.png',
              currentTurnId: '',
              createdAt: Date.now(),
              state: {
                  player1: createEmptyPlayer(''),
                  player2: createEmptyPlayer('')
              }
          };
          // Очищаем комнату сокетов (выкидываем всех)
          io.in(sessionId).socketsLeave(sessionId);
      } else {
          console.log(`Игра ${sessionId} удалена`);
          delete games[sessionId];
      }
      
      io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    }
  });

  socket.on('get_games_list', () => {
    const list = Object.values(games).filter(g => g.status === 'waiting');
    socket.emit('games_list', list);
  });

  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Игровой сервер запущен на порту ${PORT}`);
});
