
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
  console.log(`[Server] 🔌 New connection: ${socket.id}`);

  socket.on('get_games_list', () => {
    console.log(`[Server] 📋 Request for games list from ${socket.id}`);
    socket.emit('games_list', getEnrichedGamesList());
    console.log(`[Server] 📋 Games list sent to ${socket.id}`);
  });

  socket.on('create_game', (session) => {
    console.log(`[Server] 🎮 Game creation requested by ${session.hostName} (${socket.id})`);
    console.log(`[Server] 📝 Game details:`, {
      gameId: session.id,
      host: session.hostName,
      hostId: session.hostId,
      status: session.status
    });

    session.createdAt = Date.now();
    games.set(session.id, session);
    socketMetadata.set(socket.id, { userId: session.hostId, userName: session.hostName, sessionId: session.id });
    socket.join(session.id);

    console.log(`[Server] 🎮 Game ${session.id} created successfully`);
    console.log(`[Server] 📡 Broadcasting updated games list to all clients`);
    io.emit('games_list', getEnrichedGamesList());
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    console.log(`[Server] 🚪 Join game request from ${socket.id} for session ${sessionId}`);
    if (updates) {
      console.log(`[Server] 📝 Updates provided:`, {
        guestId: updates.guestId,
        guestName: updates.guestName,
        otherUpdates: Object.keys(updates).filter(k => !['guestId', 'guestName'].includes(k))
      });
    }

    const game = games.get(sessionId);
    if (game) {
      if (updates) {
        Object.assign(game, updates);
        games.set(sessionId, game); 
      }
      
      const userName = updates?.guestName || game.guestName || 'Наблюдатель';
      const userId = updates?.guestId || game.guestId || 'spectator';

      socketMetadata.set(socket.id, { 
        userId: userId, 
        userName: userName, 
        sessionId: sessionId 
      });

      console.log(`[Server] 👤 User metadata set for ${socket.id}: ${userName} (${userId})`);

      socket.join(sessionId);
      console.log(`[Server] 🎮 ${socket.id} joined game room ${sessionId}`);

      // ✓ ИСПРАВЛЕНО: Отправляем обновление ВСЕМ игрокам в комнате, а не только новому игроку
      const room = io.sockets.adapter.rooms.get(sessionId);
      if (room) {
        for (const socketId of room) {
          io.to(socketId).emit('game_sync', game);
        }
        console.log(`[Server] 📡 Game sync broadcast to ${room.size} players in room ${sessionId}`);
      }

      io.emit('games_list', getEnrichedGamesList());
      console.log(`[Server] 📡 Games list broadcast to all clients`);

      // ✓ ИСПРАВЛЕНО: Логируем присоединение к игре
      console.log(`[Server] ✅ Player ${userName} (${socket.id}) successfully joined game ${sessionId}`);
    } else {
      console.log(`[Server] ❌ Failed to join game ${sessionId} - game not found`);
    }
  });

  socket.on('rejoin_game', (sessionId) => {
      console.log(`[Server] 🔄 Rejoin request from ${socket.id} for session ${sessionId}`);
      const game = games.get(sessionId);
      if (game) {
          socket.join(sessionId);
          console.log(`[Server] 🎮 ${socket.id} rejoined game room ${sessionId}`);
          socket.emit('game_sync', game);
          console.log(`[Server] 📡 Game sync sent to rejoining player ${socket.id}`);
          io.emit('games_list', getEnrichedGamesList());
          console.log(`[Server] 📡 Games list broadcast to all clients`);
      } else {
          console.log(`[Server] ❌ Failed to rejoin game ${sessionId} - game not found`);
      }
  });

  socket.on('update_game', ({ sessionId, updates }) => {
    console.log(`[Server] 🔄 Game update request for session ${sessionId}`);
    console.log(`[Server] 📝 Update details:`, {
      hasState: !!updates.state,
      hasCurrentTurnId: !!updates.currentTurnId,
      hasLastAction: !!updates.lastAction,
      hasStatus: !!updates.status,
      hasWinnerId: !!updates.winnerId,
      ...(updates.state && {
        stateChanges: {
          player1: updates.state.player1 ? Object.keys(updates.state.player1) : undefined,
          player2: updates.state.player2 ? Object.keys(updates.state.player2) : undefined
        }
      })
    });

    const game = games.get(sessionId);
    if (game) {
      if (updates.state) {
        const mergedState = { ...game.state };
        if (updates.state.player1) mergedState.player1 = { ...mergedState.player1, ...updates.state.player1 };
        if (updates.state.player2) mergedState.player2 = { ...mergedState.player2, ...updates.state.player2 };
        game.state = mergedState;
        console.log(`[Server] 🎮 Game state updated for session ${sessionId}`);
      }
      if (updates.currentTurnId) {
        game.currentTurnId = updates.currentTurnId;
        console.log(`[Server] 🎮 Turn changed to ${updates.currentTurnId} in game ${sessionId}`);
      }
      if (updates.lastAction) {
        game.lastAction = updates.lastAction;
        console.log(`[Server] 🎮 Last action updated: ${updates.lastAction.type} in game ${sessionId}`);
      }
      if (updates.status) {
        game.status = updates.status;
        console.log(`[Server] 🎮 Game status changed to ${updates.status} in game ${sessionId}`);
      }
      if (updates.winnerId) {
        game.winnerId = updates.winnerId;
        console.log(`[Server] 🏆 Winner set to ${updates.winnerId} in game ${sessionId}`);
      }

      // ✓ ИСПРАВЛЕНО: Автоматически начинаем игру когда оба игрока завершили муллиган
      if (updates.state?.player1?.mulliganDone !== undefined || updates.state?.player2?.mulliganDone !== undefined) {
        const bothPlayersDone = game.state.player1.mulliganDone && game.state.player2.mulliganDone;
        if (bothPlayersDone && !game.lastAction) {
          console.log(`[Server] 🎮 Both players completed mulligan for game ${sessionId}, starting game...`);
          // Set initial turn if not already set
          if (!game.currentTurnId) {
            game.currentTurnId = game.hostId;
          }
          // Add initial action to trigger game start
          game.lastAction = {
            type: 'game_start',
            timestamp: Date.now()
          };
        }
      }

      games.set(sessionId, game);

      // ✓ ИСПРАВЛЕНО: Отправляем обновление ВСЕМ игрокам в комнате
      const room = io.sockets.adapter.rooms.get(sessionId);
      if (room) {
        for (const socketId of room) {
          io.to(socketId).emit('game_sync', game);
        }
        console.log(`[Server] 📡 Game sync broadcast to ${room.size} players in room ${sessionId}`);
      }

      io.emit('games_list', getEnrichedGamesList());
      console.log(`[Server] 📡 Games list broadcast to all clients`);

      // ✓ ИСПРАВЛЕНО: Логируем обновление муллигана для отладки
      if (updates.state?.player1?.mulliganDone !== undefined || updates.state?.player2?.mulliganDone !== undefined) {
        console.log(`[Server] 🎮 Mulligan update for game ${sessionId}:`, {
          player1Done: game.state.player1.mulliganDone,
          player2Done: game.state.player2.mulliganDone,
          bothDone: bothPlayersDone,
          gameStarted: !!game.lastAction
        });
      }
    } else {
      console.log(`[Server] ❌ Failed to update game ${sessionId} - game not found`);
    }
  });

  socket.on('delete_game', (sessionId) => {
    console.log(`[Server] 🗑️ Delete game request for session ${sessionId}`);
    if (games.has(sessionId)) {
      games.delete(sessionId);
      console.log(`[Server] 🗑️ Game ${sessionId} successfully deleted`);
      io.emit('games_list', getEnrichedGamesList());
      console.log(`[Server] 📡 Games list broadcast to all clients after deletion`);
      io.in(sessionId).socketsLeave(sessionId);
      console.log(`[Server] 🎮 All players removed from game room ${sessionId}`);
    } else {
      console.log(`[Server] ❌ Failed to delete game ${sessionId} - game not found`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Server] 🔌 Disconnection detected: ${socket.id}`);
    const meta = socketMetadata.get(socket.id);
    if (meta) {
      console.log(`[Server] 👤 User metadata found: ${JSON.stringify(meta)}`);
      socketMetadata.delete(socket.id);
      console.log(`[Server] 👤 User metadata removed for ${socket.id}`);

      // Remove from matchmaking queue if present
      if (matchmakingQueue.has(socket.id)) {
        matchmakingQueue.delete(socket.id);
        console.log(`[Server] 🎮 ${socket.id} removed from matchmaking queue`);
      }

      // Update matchmaking count
      io.emit('matchmaking_count', matchmakingQueue.size);
      console.log(`[Server] 📡 Matchmaking count broadcast: ${matchmakingQueue.size} players in queue`);

      // Уменьшена задержка обновления списка при отключении
      io.emit('games_list', getEnrichedGamesList());
      console.log(`[Server] 📡 Games list broadcast to all clients after disconnection`);
    } else {
      console.log(`[Server] 👤 No metadata found for disconnected socket ${socket.id}`);
    }
  });

  // Matchmaking system
  socket.on('join_matchmaking', (userData) => {
    console.log(`[Server] 🎯 Matchmaking join request from ${userData.userName} (${socket.id})`);
    console.log(`[Server] 📝 User data:`, {
      userId: userData.userId,
      userName: userData.userName,
      userAvatar: userData.userAvatar ? 'present' : 'none'
    });

    // Add to queue
    matchmakingQueue.add(socket.id);
    socketMetadata.set(socket.id, {
      userId: userData.userId,
      userName: userData.userName,
      userAvatar: userData.userAvatar,
      isInMatchmaking: true
    });

    console.log(`[Server] 🎯 ${userData.userName} added to matchmaking queue`);
    console.log(`[Server] 📊 Current queue size: ${matchmakingQueue.size}`);

    // Broadcast updated count
    io.emit('matchmaking_count', matchmakingQueue.size);
    console.log(`[Server] 📡 Matchmaking count broadcast: ${matchmakingQueue.size} players in queue`);

    // Try to find a match
    if (matchmakingQueue.size >= 2) {
      console.log(`[Server] 🎯 Matchmaking: Found enough players (${matchmakingQueue.size}), attempting to create match...`);
      const players = Array.from(matchmakingQueue);
      const player1SocketId = players[0];
      const player2SocketId = players[1];

      const player1Meta = socketMetadata.get(player1SocketId);
      const player2Meta = socketMetadata.get(player2SocketId);

      if (player1Meta && player2Meta) {
        console.log(`[Server] 🎯 Matchmaking: Matching ${player1Meta.userName} (${player1SocketId}) with ${player2Meta.userName} (${player2SocketId})`);

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
        console.log(`[Server] 🎮 New game session created: ${gameId}`);

        // Remove both players from queue
        matchmakingQueue.delete(player1SocketId);
        matchmakingQueue.delete(player2SocketId);
        console.log(`[Server] 🎯 Both players removed from matchmaking queue`);

        // Update metadata
        socketMetadata.set(player1SocketId, { ...player1Meta, sessionId: gameId, isInMatchmaking: false });
        socketMetadata.set(player2SocketId, { ...player2Meta, sessionId: gameId, isInMatchmaking: false });
        console.log(`[Server] 👤 Metadata updated for both players with game session ${gameId}`);

        // Join both players to the game room
        io.to(player1SocketId).socketsJoin(gameId);
        io.to(player2SocketId).socketsJoin(gameId);
        console.log(`[Server] 🎮 Both players joined game room ${gameId}`);

        // Notify both players
        io.to(player1SocketId).emit('match_found', newSession);
        io.to(player2SocketId).emit('match_found', newSession);
        console.log(`[Server] 📡 Match found notification sent to both players`);

        // Broadcast updated counts
        io.emit('matchmaking_count', matchmakingQueue.size);
        io.emit('games_list', getEnrichedGamesList());
        console.log(`[Server] 📡 Updated matchmaking count and games list broadcast`);

        console.log(`[Server] 🎯 Match found! Created game ${gameId} between ${player1Meta.userName} and ${player2Meta.userName}`);
      } else {
        console.log(`[Server] ❌ Matchmaking failed: Could not retrieve metadata for one or both players`);
      }
    } else {
      console.log(`[Server] 🎯 Matchmaking: Not enough players in queue (${matchmakingQueue.size}/2), waiting for more players...`);
    }
  });

  socket.on('leave_matchmaking', () => {
    console.log(`[Server] 🎯 Leave matchmaking request from ${socket.id}`);
    if (matchmakingQueue.has(socket.id)) {
      matchmakingQueue.delete(socket.id);
      console.log(`[Server] 🎯 ${socket.id} successfully removed from matchmaking queue`);

      // Update metadata
      const meta = socketMetadata.get(socket.id);
      if (meta) {
        socketMetadata.set(socket.id, { ...meta, isInMatchmaking: false });
        console.log(`[Server] 👤 Metadata updated for ${socket.id}: isInMatchmaking = false`);
      } else {
        console.log(`[Server] 👤 No metadata found for ${socket.id} when leaving matchmaking`);
      }

      // Broadcast updated count
      io.emit('matchmaking_count', matchmakingQueue.size);
      console.log(`[Server] 📡 Matchmaking count broadcast: ${matchmakingQueue.size} players in queue`);
    } else {
      console.log(`[Server] 🎯 ${socket.id} was not in matchmaking queue`);
    }
  });

  // Request current matchmaking count
  socket.on('get_matchmaking_count', () => {
    console.log(`[Server] 📊 Matchmaking count request from ${socket.id}`);
    socket.emit('matchmaking_count', matchmakingQueue.size);
    console.log(`[Server] 📊 Matchmaking count (${matchmakingQueue.size}) sent to ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Сервер Арены готов к работе`);
});
