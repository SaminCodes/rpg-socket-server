import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors());

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const games = new Map();
const socketMeta = new Map();
const matchmakingQueue = [];

const WAITING_ROOM_TTL_MS = 5 * 60 * 1000;

const now = () => Date.now();

const defaultPlayer = (uid = '', isFirst = false) => ({
  uid,
  health: 30,
  mana: { current: isFirst ? 1 : 0, max: isFirst ? 1 : 0 },
  hand: [],
  board: [],
  deck: [],
  fatigue: 0,
  mulliganDone: false
});

const normalizeGame = (raw) => {
  const game = raw || {};
  game.id = game.id || Math.random().toString(36).slice(2, 11);
  game.createdAt = game.createdAt || now();
  game.status = game.status || 'waiting';
  game.phase = game.phase || 'mulligan';
  game.state = game.state || {};
  game.state.player1 = { ...defaultPlayer('', true), ...(game.state.player1 || {}) };
  game.state.player2 = { ...defaultPlayer('', false), ...(game.state.player2 || {}) };

  game.hostId = game.hostId || game.state.player1.uid || '';
  game.guestId = game.guestId || game.state.player2.uid || '';
  game.hostName = game.hostName || 'Player 1';
  game.guestName = game.guestName || '';
  game.hostAvatar = game.hostAvatar || '';
  game.guestAvatar = game.guestAvatar || '';

  if (!game.currentTurnId) game.currentTurnId = game.hostId || game.state.player1.uid || '';

  return game;
};

const mergePlayer = (base, patch) => {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    mana: patch.mana ? { ...(base.mana || {}), ...patch.mana } : base.mana
  };
};

const mergeState = (currentState, patchState) => {
  if (!patchState) return currentState;
  return {
    player1: mergePlayer(currentState.player1, patchState.player1),
    player2: mergePlayer(currentState.player2, patchState.player2)
  };
};

const maybeStartGameAfterMulligan = (game) => {
  const p1Ready = !!game.state?.player1?.mulliganDone;
  const p2Ready = !!game.state?.player2?.mulliganDone;
  if (!p1Ready || !p2Ready) return;

  if (game.phase !== 'battle') {
    game.phase = 'battle';
    game.status = 'active';
    game.currentTurnId = game.state.player1.uid || game.hostId || game.currentTurnId;
    game.lastAction = { type: 'game_start', timestamp: now() };
    console.log(`[Server] game_start for ${game.id}`);
  }
};

const getRoomOnlineNames = (sessionId) => {
  const room = io.sockets.adapter.rooms.get(sessionId);
  if (!room) return [];

  const names = [];
  for (const sid of room) {
    const meta = socketMeta.get(sid);
    if (meta?.userName) names.push(meta.userName);
  }
  return [...new Set(names)];
};

const cleanupExpiredWaitingGames = () => {
  const ts = now();
  for (const [id, game] of games.entries()) {
    if (game.status === 'waiting' && ts - (game.createdAt || ts) > WAITING_ROOM_TTL_MS) {
      games.delete(id);
      io.in(id).socketsLeave(id);
      console.log(`[Server] removed expired waiting room ${id}`);
    }
  }
};

const enrichedGamesList = () => {
  cleanupExpiredWaitingGames();

  const list = [];
  for (const game of games.values()) {
    normalizeGame(game);
    const room = io.sockets.adapter.rooms.get(game.id);
    const onlineCount = room ? room.size : 0;
    list.push({
      ...game,
      onlineCount,
      onlineNames: getRoomOnlineNames(game.id)
    });
  }
  return list;
};

const broadcastGamesList = () => {
  io.sockets.emit('games_list', enrichedGamesList());
};

const emitGameSync = (sessionId) => {
  const game = games.get(sessionId);
  if (!game) return;
  io.to(sessionId).emit('game_sync', game);
};

const saveGame = (game) => {
  normalizeGame(game);
  maybeStartGameAfterMulligan(game);
  games.set(game.id, game);
};

io.on('connection', (socket) => {
  console.log(`[Server] connected ${socket.id}`);

  socket.on('get_games_list', () => {
    socket.emit('games_list', enrichedGamesList());
  });

  socket.on('get_game', (sessionId) => {
    socket.emit('game_sync', games.get(sessionId) || null);
  });

  socket.on('create_game', (session) => {
    try {
      if (!session?.id) return;
      const game = normalizeGame({ ...session, status: 'waiting', phase: 'mulligan', createdAt: now() });
      saveGame(game);

      socket.join(game.id);
      socketMeta.set(socket.id, {
        sessionId: game.id,
        userId: game.hostId || game.state.player1.uid,
        userName: game.hostName || 'Player 1'
      });

      socket.emit('game_sync', game);
      broadcastGamesList();
      console.log(`[Server] create_game ${game.id}`);
    } catch (err) {
      console.error('[Server] create_game error', err);
    }
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    try {
      const game = games.get(sessionId);
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      normalizeGame(game);

      if (updates?.state) {
        game.state = mergeState(game.state, updates.state);
      }

      if (updates?.guestId !== undefined) game.guestId = updates.guestId;
      if (updates?.guestName !== undefined) game.guestName = updates.guestName;
      if (updates?.guestAvatar !== undefined) game.guestAvatar = updates.guestAvatar;
      if (updates?.hostId !== undefined) game.hostId = updates.hostId;
      if (updates?.hostName !== undefined) game.hostName = updates.hostName;
      if (updates?.hostAvatar !== undefined) game.hostAvatar = updates.hostAvatar;
      if (updates?.currentTurnId !== undefined) game.currentTurnId = updates.currentTurnId;
      if (updates?.status !== undefined) game.status = updates.status;

      if (game.state.player1.uid && !game.hostId) game.hostId = game.state.player1.uid;
      if (game.state.player2.uid && !game.guestId) game.guestId = game.state.player2.uid;

      saveGame(game);

      socket.join(sessionId);
      socketMeta.set(socket.id, {
        sessionId,
        userId: updates?.guestId || updates?.hostId || game.guestId || game.hostId || 'spectator',
        userName: updates?.guestName || updates?.hostName || game.guestName || game.hostName || 'Spectator'
      });

      emitGameSync(sessionId);
      broadcastGamesList();
      console.log(`[Server] join_game ${sessionId}`);
    } catch (err) {
      console.error('[Server] join_game error', err);
    }
  });

  socket.on('rejoin_game', (payload) => {
    try {
      const sessionId = typeof payload === 'string' ? payload : payload?.sessionId;
      const userData = typeof payload === 'object' ? payload?.userData : null;
      const game = games.get(sessionId);
      if (!game) return;

      socket.join(sessionId);
      if (userData?.userId || userData?.userName) {
        socketMeta.set(socket.id, {
          sessionId,
          userId: userData?.userId || 'spectator',
          userName: userData?.userName || 'Spectator'
        });
      }

      socket.emit('game_sync', game);
      broadcastGamesList();
    } catch (err) {
      console.error('[Server] rejoin_game error', err);
    }
  });

  socket.on('update_game', ({ sessionId, updates }) => {
    try {
      const game = games.get(sessionId);
      if (!game) return;

      normalizeGame(game);

      if (updates?.state) {
        game.state = mergeState(game.state, updates.state);
      }
      if (updates?.currentTurnId !== undefined) game.currentTurnId = updates.currentTurnId;
      if (updates?.lastAction) game.lastAction = updates.lastAction;
      if (updates?.status !== undefined) game.status = updates.status;
      if (updates?.winnerId !== undefined) game.winnerId = updates.winnerId;
      if (updates?.phase !== undefined) game.phase = updates.phase;

      if (updates?.hostId !== undefined) game.hostId = updates.hostId;
      if (updates?.hostName !== undefined) game.hostName = updates.hostName;
      if (updates?.hostAvatar !== undefined) game.hostAvatar = updates.hostAvatar;
      if (updates?.guestId !== undefined) game.guestId = updates.guestId;
      if (updates?.guestName !== undefined) game.guestName = updates.guestName;
      if (updates?.guestAvatar !== undefined) game.guestAvatar = updates.guestAvatar;

      saveGame(game);

      emitGameSync(sessionId);
      broadcastGamesList();
    } catch (err) {
      console.error('[Server] update_game error', err);
    }
  });

  socket.on('delete_game', (sessionId) => {
    if (!games.has(sessionId)) return;
    games.delete(sessionId);
    io.in(sessionId).socketsLeave(sessionId);
    broadcastGamesList();
    console.log(`[Server] delete_game ${sessionId}`);
  });

  socket.on('join_matchmaking', (userData) => {
    try {
      if (!userData?.userId) return;

      const payload = {
        userId: userData.userId,
        userName: userData.userName || 'Player',
        userAvatar: userData.userAvatar || '',
        socketId: socket.id
      };

      const existingIndex = matchmakingQueue.findIndex((p) => p.userId === payload.userId);
      if (existingIndex >= 0) matchmakingQueue[existingIndex] = payload;
      else matchmakingQueue.push(payload);

      io.emit('matchmaking_count', matchmakingQueue.length);

      if (matchmakingQueue.length >= 2) {
        const p1 = matchmakingQueue.shift();
        const p2 = matchmakingQueue.shift();

        const sessionId = Math.random().toString(36).slice(2, 11);
        const game = normalizeGame({
          id: sessionId,
          status: 'waiting',
          phase: 'mulligan',
          createdAt: now(),
          hostId: p1.userId,
          hostName: p1.userName,
          hostAvatar: p1.userAvatar,
          guestId: p2.userId,
          guestName: p2.userName,
          guestAvatar: p2.userAvatar,
          currentTurnId: p1.userId,
          state: {
            player1: defaultPlayer(p1.userId, true),
            player2: defaultPlayer(p2.userId, false)
          }
        });

        saveGame(game);

        io.to(p1.socketId).emit('match_found', game);
        io.to(p2.socketId).emit('match_found', game);

        io.emit('matchmaking_count', matchmakingQueue.length);
        broadcastGamesList();
      }
    } catch (err) {
      console.error('[Server] join_matchmaking error', err);
    }
  });

  socket.on('leave_matchmaking', () => {
    const idx = matchmakingQueue.findIndex((p) => p.socketId === socket.id);
    if (idx >= 0) matchmakingQueue.splice(idx, 1);
    io.emit('matchmaking_count', matchmakingQueue.length);
  });

  socket.on('get_matchmaking_count', () => {
    socket.emit('matchmaking_count', matchmakingQueue.length);
  });

  socket.on('disconnect', (reason) => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);

    const idx = matchmakingQueue.findIndex((p) => p.socketId === socket.id);
    if (idx >= 0) {
      matchmakingQueue.splice(idx, 1);
      io.emit('matchmaking_count', matchmakingQueue.length);
    }

    if (meta) {
      console.log(`[Server] disconnected ${meta.userName} (${reason})`);
    }

    broadcastGamesList();
  });

  socket.on('error', (err) => {
    console.error(`[Server] socket error ${socket.id}`, err);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Server] listening on port ${PORT}`);
});
