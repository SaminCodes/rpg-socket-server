
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

// Функция умного слияния состояния, чтобы игроки не перезаписывали друг друга
const mergeGameState = (currentState, newUpdates) => {
    // Если обновлений нет, возвращаем как есть
    if (!newUpdates) return;

    // 1. Обновление вложенного state (игроков)
    if (newUpdates.state) {
        if (!currentState.state) currentState.state = {};
        
        // Если прилетел player1, мержим его
        if (newUpdates.state.player1) {
            currentState.state.player1 = { 
                ...currentState.state.player1, 
                ...newUpdates.state.player1 
            };
        }
        // Если прилетел player2, мержим его
        if (newUpdates.state.player2) {
            currentState.state.player2 = { 
                ...currentState.state.player2, 
                ...newUpdates.state.player2 
            };
        }
        // Удаляем state из updates, чтобы он не перезаписался целиком ниже
        delete newUpdates.state;
    }

    // 2. Обновление остальных полей верхнего уровня (status, turn, etc)
    Object.assign(currentState, newUpdates);
};

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  const waitingGames = Object.values(games).filter(g => g.status === 'waiting');
  socket.emit('games_list', waitingGames);

  // Создание новой игры
  socket.on('create_game', (session) => {
    console.log(`Создана игра: ${session.id}`);
    games[session.id] = session;
    socket.join(session.id);
    
    io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    socket.emit('game_sync', session);
  });

  // Присоединение к игре
  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games[sessionId];
    if (game) {
      console.log(`Игрок ${socket.id} обновляет игру ${sessionId}`);
      
      // Используем умное слияние
      mergeGameState(game, updates);
      
      // Логика "занятия стола"
      if (game.hostId !== 'system' && game.state.player1.uid && !game.state.player2.uid) {
          console.log(`Стол ${sessionId} занят игроком P1`);
      }
      if (game.state.player1.uid && game.state.player2.uid) {
          console.log(`Стол ${sessionId} теперь полный. Игра активна.`);
      }

      socket.join(sessionId);
      
      // Отправляем обновленное состояние ВСЕМ в комнате
      io.to(sessionId).emit('game_sync', game);
      
      // Обновляем список игр
      io.emit('games_list', Object.values(games).filter(g => g.status === 'waiting'));
    } else {
      socket.emit('error', { message: 'Игра не найдена' });
    }
  });

  // Re-join without updating state (fixing eternal waiting bug on reconnect)
  socket.on('rejoin_game', (sessionId) => {
    if (games[sessionId]) {
        console.log(`Игрок ${socket.id} переподключился к столу ${sessionId}`);
        socket.join(sessionId);
        // Send current state to the reconnecting player immediately
        socket.emit('game_sync', games[sessionId]);
    }
  });

  // Обновление состояния игры
  socket.on('update_game', ({ sessionId, updates }) => {
    const game = games[sessionId];
    if (game) {
      mergeGameState(game, updates);
      io.to(sessionId).emit('game_sync', game);
    }
  });

  // Удаление/Сброс игры
  socket.on('delete_game', (sessionId) => {
    if (games[sessionId]) {
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