
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
// Хранилище для маппинга сокета к пользователю и сессии
const socketMetadata = new Map();

const getEnrichedGamesList = () => {
  return Array.from(games.values()).map(game => {
    const room = io.sockets.adapter.rooms.get(game.id);
    const onlineCount = room ? room.size : 0;
    
    // Собираем имена тех, кто в комнате прямо сейчас
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
      onlineNames: [...new Set(onlineNames)] // Убираем дубли если один юзер с двух вкладок
    };
  });
};

const cleanupEmptyGames = () => {
  let changed = false;
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    const room = io.sockets.adapter.rooms.get(id);
    // Если в комнате 0 сокетов и она создана более 30 секунд назад
    if (!room || room.size === 0) {
      if (now - game.createdAt > 30000) {
        games.delete(id);
        changed = true;
        console.log(`[Server] Room ${id} deleted (abandoned)`);
      }
    }
  }
  if (changed) io.emit('games_list', getEnrichedGamesList());
};

setInterval(cleanupEmptyGames, 15000);

io.on('connection', (socket) => {
  console.log(`[Server] Socket connected: ${socket.id}`);

  socket.on('get_games_list', () => {
    socket.emit('games_list', getEnrichedGamesList());
  });

  socket.on('create_game', (session) => {
    session.createdAt = Date.now();
    games.set(session.id, session);
    
    socketMetadata.set(socket.id, { 
      userId: session.hostId, 
      userName: session.hostName, 
      sessionId: session.id 
    });
    
    socket.join(session.id);
    console.log(`[Server] Room ${session.id} created by ${session.hostName}`);
    io.emit('games_list', getEnrichedGamesList());
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    const game = games.get(sessionId);
    if (game) {
      if (updates) {
        // Если это первый реальный гость
        if (updates.guestId && !game.guestId) {
          console.log(`[Server] Guest ${updates.guestName} joining ${sessionId}`);
        }
        Object.assign(game, updates);
        games.set(sessionId, game); 
      }
      
      socketMetadata.set(socket.id, { 
        userId: updates?.guestId || game.guestId || 'unknown', 
        userName: updates?.guestName || game.guestName || 'Guest', 
        sessionId: sessionId 
      });

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

      games.set(sessionId, game);
      io.to(sessionId).emit('game_sync', game);
      
      // Если поменялся статус (игра началась), обновляем глобальный список
      if (updates.status) {
         io.emit('games_list', getEnrichedGamesList());
      }
    }
  });

  socket.on('delete_game', (sessionId) => {
    if (games.has(sessionId)) {
      games.delete(sessionId);
      console.log(`[Server] Room ${sessionId} manually deleted`);
      io.emit('games_list', getEnrichedGamesList());
      io.in(sessionId).socketsLeave(sessionId);
    }
  });

  socket.on('disconnect', () => {
    const meta = socketMetadata.get(socket.id);
    if (meta) {
      console.log(`[Server] User ${meta.userName} disconnected from ${meta.sessionId}`);
      socketMetadata.delete(socket.id);
      
      // Даем задержку перед проверкой списка, чтобы сокет успел выйти из комнат адаптера
      setTimeout(() => {
        io.emit('games_list', getEnrichedGamesList());
      }, 1000);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Игровой сервер запущен на порту ${PORT}`);
});
