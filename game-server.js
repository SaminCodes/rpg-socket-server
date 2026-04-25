import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const games = new Map();
const socketMetadata = new Map();
const matchmakingQueue = [];

const GAME_TIMEOUT_MS = 5 * 60 * 1000;

const now = () => Date.now();

const defaultPlayerState = (uid = '', isFirst = false) => ({
  uid,
  health: 30,
  mana: { current: isFirst ? 1 : 0, max: isFirst ? 1 : 0 },
  hand: [],
  board: [],
  deck: [],
  fatigue: 0,
  mulliganDone: false
});

const ensureGameShape = (game) => {
  game.status = game.status || 'waiting';
  game.phase = game.phase || 'mulligan';
  game.createdAt = game.createdAt || now();
  game.state = game.state || {};
  game.state.player1 = { ...defaultPlayerState('', true), ...(game.state.player1 || {}) };
  game.state.player2 = { ...defaultPlayerState('', false), ...(game.state.player2 || {}) };

  game.hostId = game.hostId || game.state.player1.uid || '';
  game.guestId = game.guestId || game.state.player2.uid || '';
  game.hostName = game.hostName || 'Player 1';
  game.guestName = game.guestName || '';
  game.hostAvatar = game.hostAvatar || '';
  game.guestAvatar = game.guestAvatar || '';

  if (!game.currentTurnId) game.currentTurnId = game.state.player1.uid || game.hostId || '';
  return game;
};

const shallowMergePlayer = (base, patch) => {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    mana: patch.mana ? { ...(base.mana || {}), ...patch.mana } : base.mana
  };
};

const mergeState = (baseState, patchState) => {
  if (!patchState) return baseState;
  return {
    player1: shallowMergePlayer(baseState.player1, patchState.player1),
    player2: shallowMergePlayer(baseState.player2, patchState.player2)
  };
};

const normalizeAndAutostart = (game) => {
  ensureGameShape(game);

  const p1Ready = !!game.state.player1.mulliganDone;
  const p2Ready = !!game.state.player2.mulliganDone;

  if (p1Ready && p2Ready && game.phase !== 'battle') {
    game.phase = 'battle';
    game.status = 'active';
    game.currentTurnId = game.state.player1.uid || game.hostId || game.currentTurnId;
    game.lastAction = { type: 'game_start', timestamp: now() };
    console.log(`[Server] Game ${game.id} started (both mulligans confirmed)`);
  }

  return game;
};

const saveAndSyncGame = (game) => {
  normalizeAndAutostart(game);
  games.set(game.id, game);
  io.to(game.id).emit('game_sync', game);
};

const getOnlineNamesForGame = (gameId) => {
  const room = io.sockets.adapter.rooms.get(gameId);
  if (!room) return [];

  const names = [];
  for (const socketId of room) {
    const meta = socketMetadata.get(socketId);
    if (meta?.userName) names.push(meta.userName);
  }
  return [...new Set(names)];
};

const getEnrichedGamesList = () => {
  const ts = now();
  const valid = [];

  for (const [id, game] of games.entries()) {
    ensureGameShape(game);

    if (game.status === 'waiting' && (ts - game.createdAt) > GAME_TIMEOUT_MS) {
      console.log(`[Server] Removing stale waiting room: ${id}`);
      games.delete(id);
      continue;
    }

    valid.push(game);
  }

  return valid.map((game) => {
    const room = io.sockets.adapter.rooms.get(game.id);
    const onlineCount = room ? room.size : 0;

    return {
      ...game,
      guestId: game.guestId || game.state.player2.uid || '',
      hostId: game.hostId || game.state.player1.uid || '',
      guestName: game.guestName || '',
      hostName: game.hostName || '',
      guestAvatar: game.guestAvatar || '',
      hostAvatar: game.hostAvatar || '',
      onlineCount,
      onlineNames: getOnlineNamesForGame(game.id)
    };
  });
};

const broadcastGamesList = () => {
  const list = getEnrichedGamesList();
  io.sockets.emit('games_list', list);
};

const assignSocketIdentity = (socket, { userId, userName, sessionId }) => {
  socketMetadata.set(socket.id, {
    userId: userId || 'spectator',
    userName: userName || 'Spectator',
    sessionId
  });
};

const findPlayerSlotByUserId = (game, userId) => {
  if (!userId) return null;
  if (game.state.player1.uid === userId) return 'player1';
  if (game.state.player2.uid === userId) return 'player2';
  return null;
};

const reserveAvailableSlot = (game, userId) => {
  if (!game.state.player1.uid) {
    game.state.player1.uid = userId;
    game.hostId = userId;
    return 'player1';
  }
  if (!game.state.player2.uid) {
    game.state.player2.uid = userId;
    game.guestId = userId;
    return 'player2';
  }
  return null;
};

io.on('connection', (socket) => {
  console.log(`[Server] Connected: ${socket.id}`);

  socket.on('get_games_list', () => {
    socket.emit('games_list', getEnrichedGamesList());
  });

  socket.on('get_game', (sessionId) => {
    const game = games.get(sessionId);
    socket.emit('game_sync', game || null);
  });

  socket.on('create_game', (session) => {
    try {
      if (!session?.id) return;
      const game = ensureGameShape({ ...session, phase: 'mulligan', status: 'waiting', createdAt: now() });
      games.set(game.id, game);

      socket.join(game.id);
      assignSocketIdentity(socket, {
        userId: game.hostId || game.state.player1.uid,
        userName: game.hostName,
        sessionId: game.id
      });

      socket.emit('game_sync', game);
      broadcastGamesList();
      console.log(`[Server] Game created: ${game.id}`);
    } catch (e) {
      console.error('[Server] create_game error:', e?.message || e);
    }
  });

  socket.on('join_game', ({ sessionId, updates }) => {
    try {
      const game = games.get(sessionId);
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      ensureGameShape(game);

      if (updates?.state) {
        game.state = mergeState(game.state, updates.state);
      }

      if (updates?.guestId !== undefined) game.guestId = updates.guestId;
      if (updates?.guestName !== undefined) game.guestName = updates.guestName;
      if (updates?.guestAvatar !== undefined) game.guestAvatar = updates.guestAvatar;
      if (updates?.hostName !== undefined) game.hostName = updates.hostName;
      if (updates?.hostAvatar !== undefined) game.hostAvatar = updates.hostAvatar;

      if (updates?.status) game.status = updates.status;
      if (updates?.currentTurnId !== undefined) game.currentTurnId = updates.currentTurnId;

      normalizeAndAutostart(game);
      games.set(sessionId, game);

      const joinedUserId = updates?.guestId || updates?.hostId || game.guestId || game.hostId || '';
      const joinedUserName = updates?.guestName || updates?.hostName || game.guestName || game.hostName || 'Player';

      socket.join(sessionId);
      assignSocketIdentity(socket, {
        userId: joinedUserId,
        userName: joinedUserName,
        sessionId
      });

      io.to(sessionId).emit('game_sync', game);
      broadcastGamesList();
      console.log(`[Server] Player joined: ${sessionId}`);
    } catch (e) {
      console.error('[Server] join_game error:', e?.message || e);
    }
  });

  socket.on('rejoin_game', (data) => {
    try {
      const sessionId = typeof data === 'string' ? data : data?.sessionId;
      const userData = typeof data === 'object' ? data?.userData : null;
      const game = games.get(sessionId);
      if (!game) return;

      socket.join(sessionId);

      if (userData) {
        assignSocketIdentity(socket, {
          userId: userData.userId,
          userName: userData.userName,
          sessionId
        });
      }

      socket.emit('game_sync', game);
      broadcastGamesList();
    } catch (e) {
      console.error('[Server] rejoin_game error:', e?.message || e);
    }
  });

  socket.on('confirm_mulligan', ({ sessionId, userId, statePatch }) => {
    try {
      const game = games.get(sessionId);
      if (!game) {
        socket.emit('confirm_mulligan_ack', { ok: false, error: 'Game not found' });
        return;
      }

      ensureGameShape(game);
      if (game.phase === 'battle') {
        socket.emit('confirm_mulligan_ack', { ok: true, alreadyStarted: true });
        return;
      }

      let slot = findPlayerSlotByUserId(game, userId);
      if (!slot) slot = reserveAvailableSlot(game, userId);
      if (!slot) {
        socket.emit('confirm_mulligan_ack', { ok: false, error: 'No free player slot' });
        return;
      }

      if (statePatch) {
        game.state[slot] = shallowMergePlayer(game.state[slot], statePatch);
      }
      game.state[slot].mulliganDone = true;

      saveAndSyncGame(game);
      broadcastGamesList();

      socket.emit('confirm_mulligan_ack', {
        ok: true,
        phase: game.phase,
        bothReady: !!(game.state.player1.mulliganDone && game.state.player2.mulliganDone)
      });
    } catch (e) {
      socket.emit('confirm_mulligan_ack', { ok: false, error: e?.message || 'Unknown error' });
      console.error('[Server] confirm_mulligan error:', e?.message || e);
    }
  });

  socket.on('update_game', ({ sessionId, updates }) => {
    try {
      const game = games.get(sessionId);
      if (!game) return;

      ensureGameShape(game);

      if (updates?.state) {
        game.state = mergeState(game.state, updates.state);
      }

      if (updates?.currentTurnId !== undefined) game.currentTurnId = updates.currentTurnId;
      if (updates?.lastAction) game.lastAction = updates.lastAction;
      if (updates?.status) game.status = updates.status;
      if (updates?.winnerId !== undefined) game.winnerId = updates.winnerId;
      if (updates?.phase) game.phase = updates.phase;

      saveAndSyncGame(game);
      broadcastGamesList();
    } catch (e) {
      console.error('[Server] update_game error:', e?.message || e);
    }
  });

  socket.on('delete_game', (sessionId) => {
    if (!games.has(sessionId)) return;
    games.delete(sessionId);
    io.in(sessionId).socketsLeave(sessionId);
    broadcastGamesList();
  });

  socket.on('join_matchmaking', (userData) => {
    try {
      if (!userData?.userId) return;

      const existing = matchmakingQueue.findIndex((p) => p.userId === userData.userId);
      const payload = { ...userData, socketId: socket.id };
      if (existing >= 0) matchmakingQueue[existing] = payload;
      else matchmakingQueue.push(payload);

      io.emit('matchmaking_count', matchmakingQueue.length);

      if (matchmakingQueue.length >= 2) {
        const player1 = matchmakingQueue.shift();
        const player2 = matchmakingQueue.shift();

        const gameId = Math.random().toString(36).slice(2, 11);
        const newGame = ensureGameShape({
          id: gameId,
          status: 'waiting',
          phase: 'mulligan',
          hostId: player1.userId,
          hostName: player1.userName,
          hostAvatar: player1.userAvatar || '',
          guestId: player2.userId,
          guestName: player2.userName,
          guestAvatar: player2.userAvatar || '',
          currentTurnId: player1.userId,
          createdAt: now(),
          state: {
            player1: defaultPlayerState(player1.userId, true),
            player2: defaultPlayerState(player2.userId, false)
          }
        });

        games.set(gameId, newGame);
        io.to(player1.socketId).emit('match_found', newGame);
        io.to(player2.socketId).emit('match_found', newGame);

        io.emit('matchmaking_count', matchmakingQueue.length);
        broadcastGamesList();
      }
    } catch (e) {
      console.error('[Server] join_matchmaking error:', e?.message || e);
    }
  });

  socket.on('leave_matchmaking', () => {
    const idx = matchmakingQueue.findIndex((p) => p.socketId === socket.id);
    if (idx >= 0) {
      matchmakingQueue.splice(idx, 1);
      io.emit('matchmaking_count', matchmakingQueue.length);
    }
  });

  socket.on('get_matchmaking_count', () => {
    socket.emit('matchmaking_count', matchmakingQueue.length);
  });

  socket.on('disconnect', (reason) => {
    try {
      const meta = socketMetadata.get(socket.id);
      socketMetadata.delete(socket.id);

      const idx = matchmakingQueue.findIndex((p) => p.socketId === socket.id);
      if (idx >= 0) {
        matchmakingQueue.splice(idx, 1);
        io.emit('matchmaking_count', matchmakingQueue.length);
      }

      if (meta) {
        console.log(`[Server] Disconnected: ${meta.userName} (${reason})`);
      }
      broadcastGamesList();
    } catch (e) {
      console.error('[Server] disconnect error:', e?.message || e);
    }
  });

  socket.on('error', (err) => {
    console.error(`[Server] Socket error (${socket.id}):`, err);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Arena server listening on ${PORT}`);
});
