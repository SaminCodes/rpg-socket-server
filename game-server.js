
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
// Matchmaking queue - stores users looking for opponents
const matchmakingQueue = new Set();

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
      // Remove from matchmaking queue if present
      matchmakingQueue.delete(socket.id);
      // Update matchmaking count
      io.emit('matchmaking_count', matchmakingQueue.size);
      // Уменьшена задержка обновления списка при отключении
      io.emit('games_list', getEnrichedGamesList());
    }
  });

  // Matchmaking system
  socket.on('join_matchmaking', (userData) => {
    console.log(`[Server] ${userData.userName} (${socket.id}) joined matchmaking queue`);

    // Add to queue
    matchmakingQueue.add(socket.id);
    socketMetadata.set(socket.id, {
      userId: userData.userId,
      userName: userData.userName,
      userAvatar: userData.userAvatar,
      isInMatchmaking: true
    });

    // Broadcast updated count
    io.emit('matchmaking_count', matchmakingQueue.size);

    // Try to find a match
    if (matchmakingQueue.size >= 2) {
      const players = Array.from(matchmakingQueue);
      const player1SocketId = players[0];
      const player2SocketId = players[1];

      const player1Meta = socketMetadata.get(player1SocketId);
      const player2Meta = socketMetadata.get(player2SocketId);

      if (player1Meta && player2Meta) {
        // Create a new game session - start with mulligan phase
        const gameId = Math.random().toString(36).substr(2, 9);
        const newSession = {
          id: gameId,
          status: 'active',  // Status is active but both players need to do mulligan first
          hostId: player1Meta.userId,
          hostName: player1Meta.userName,
          hostAvatar: player1Meta.userAvatar,
          guestId: player2Meta.userId,
          guestName: player2Meta.userName,
          guestAvatar: player2Meta.userAvatar,
          currentTurnId: player1Meta.userId,  // Player 1 goes first after mulligan
          createdAt: Date.now(),
          state: {
            player1: { uid: player1Meta.userId, health: 30, mana: { current: 1, max: 1 }, hand: [], board: [], deck: [], fatigue: 0, heroAbility: null, mulliganDone: false },
            player2: { uid: player2Meta.userId, health: 30, mana: { current: 0, max: 0 }, hand: [], board: [], deck: [], fatigue: 0, heroAbility: null, mulliganDone: false }
          }
        };

        games.set(gameId, newSession);

        // Remove both players from queue
        matchmakingQueue.delete(player1SocketId);
        matchmakingQueue.delete(player2SocketId);

        // Update metadata
        socketMetadata.set(player1SocketId, { ...player1Meta, sessionId: gameId, isInMatchmaking: false });
        socketMetadata.set(player2SocketId, { ...player2Meta, sessionId: gameId, isInMatchmaking: false });

        // Join both players to the game room
        io.to(player1SocketId).socketsJoin(gameId);
        io.to(player2SocketId).socketsJoin(gameId);

        // Notify both players
        io.to(player1SocketId).emit('match_found', newSession);
        io.to(player2SocketId).emit('match_found', newSession);

        // Broadcast updated counts
        io.emit('matchmaking_count', matchmakingQueue.size);
        io.emit('games_list', getEnrichedGamesList());

        console.log(`[Server] Match found! Created game ${gameId} between ${player1Meta.userName} and ${player2Meta.userName}`);
      }
    }
  });

  socket.on('leave_matchmaking', () => {
    if (matchmakingQueue.has(socket.id)) {
      matchmakingQueue.delete(socket.id);
      console.log(`[Server] ${socket.id} left matchmaking queue`);

      // Update metadata
      const meta = socketMetadata.get(socket.id);
      if (meta) {
        socketMetadata.set(socket.id, { ...meta, isInMatchmaking: false });
      }

      // Broadcast updated count
      io.emit('matchmaking_count', matchmakingQueue.size);
    }
  });

  // Request current matchmaking count
  socket.on('get_matchmaking_count', () => {
    socket.emit('matchmaking_count', matchmakingQueue.size);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Сервер Арены готов к работе`);
});
