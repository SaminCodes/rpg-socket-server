
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

// Базовое состояние игрока для ботов
const createEmptyPlayer = (uid) => ({
    uid,
    health: 30,
    mana: { current: 1, max: 1 },
    hand: [],
    board: [],
    deck: [],
    fatigue: 0
});

// Хранилище игровых сессий в памяти с 3 предустановленными комнатами
const games = {
    'room-test-1': {
        id: 'room-test-1',
        status: 'waiting',
        hostId: 'bot-1',
        hostName: 'Тренировочный Манекен',
        hostAvatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Dummy',
        currentTurnId: 'bot-1',
        createdAt: Date.now(),
        state: {
            player1: createEmptyPlayer('bot-1'),
            player2: createEmptyPlayer('')
        }
    },
    'room-test-2': {
        id: 'room-test-2',
        status: 'waiting',
        hostId: 'bot-2',
        hostName: 'Страж Арены',
        hostAvatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Guardian',
        currentTurnId: 'bot-2',
        createdAt: Date.now(),
        state: {
            player1: createEmptyPlayer('bot-2'),
            player2: createEmptyPlayer('')
        }
    },
    'room-test-3': {
        id: 'room-test-3',
        status: 'waiting',
        hostId: 'bot-3',
        hostName: 'Тень Разлома',
        hostAvatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Shadow',
        currentTurnId: 'bot-3',
        createdAt: Date.now(),
        state: {
            player1: createEmptyPlayer('bot-3'),
            player2: createEmptyPlayer('')
        }
    }
};

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  // Отправляем список ожидающих игр при подключении
  const waitingGames = Object.values(games).filter(g => g.status === 'waiting');
  console.log(`Sending ${waitingGames.length} games to new client`);
  socket.emit('games_list', waitingGames);

  // Создание новой игры
  socket.on('create_game', (session) => {
    console.log(`Создана игра: ${session.id} хост: ${session.hostName}`);
    games[session.id] = session;
    socket.join(session.id);
    
    // Рассылаем обновленный список игр всем
    const waiting = Object.values(games).filter(g => g.status === 'waiting');
    console.log(`Broadcast games list: ${waiting.length} games`);
    io.emit('games_list', waiting);
    
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
      
      Object.assign(game, updates);

      // Рассылаем всем участникам
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
    const list = Object.values(games).filter(g => g.status === 'waiting');
    console.log(`Manual request: sending ${list.length} games`);
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
