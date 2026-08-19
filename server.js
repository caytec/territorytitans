const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const db = new Database('game.db');

// Initialize the database
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  level INTEGER DEFAULT 1,
  xp INTEGER DEFAULT 0,
  allTimeScore INTEGER DEFAULT 0,
  gamesPlayed INTEGER DEFAULT 0,
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  playerId TEXT,
  score INTEGER,
  xp INTEGER,
  duration INTEGER,
  endedAt TEXT
);
`);

const upsertPlayer = db.prepare(`
INSERT INTO players (id, username, level, xp, allTimeScore, gamesPlayed, createdAt) 
VALUES (?, ?, ?, ?, ?, ?, ?) 
ON CONFLICT(username) DO UPDATE SET 
  allTimeScore = players.allTimeScore + excluded.allTimeScore,
  gamesPlayed = players.gamesPlayed + 1,
  level = excluded.level,
  xp = excluded.xp
`);

const insertSession = db.prepare(`
INSERT INTO sessions (id, playerId, score, xp, duration, endedAt) 
VALUES (?, ?, ?, ?, ?, ?)
`);

const getTopPlayers = db.prepare(`
SELECT id, username, allTimeScore FROM players 
ORDER BY allTimeScore DESC LIMIT 10
`);

const PORT = 3000;
const TICK_RATE = 50;
const WORLD_W = 3000;
const WORLD_H = 3000;
const MAX_ROOM = 10;
const BOT_COUNT = 5;
const SPEED = 4;
const ATTACK_RANGE = 60;
const ATTACK_DMG = 10;

class Player {
  constructor(id, username) {
    this.id = id;
    this.username = username;
    this.x = Math.random() * WORLD_W;
    this.y = Math.random() * WORLD_H;
    this.hp = 100;
    this.maxHp = 100;
    this.score = 0;
    this.xp = 0;
    this.level = 1;
    this.alive = true;
    this.speed = SPEED;
    this.inputBuffer = [];
    this.lastInput = { dx: 0, dy: 0, action: null };
    this.speedBoostUntil = 0;
    this.sessionStart = Date.now();
  }
}

class Bot {
  constructor(id) {
    this.id = id;
    this.name = 'Bot ' + id;
    this.x = Math.random() * WORLD_W;
    this.y = Math.random() * WORLD_H;
    this.hp = 100;
    this.maxHp = 100;
    this.score = 0;
    this.state = 'idle';
    this.stateTimer = 0;
    this.target = null;
    this.attackCooldown = 0;
    this.wanderDx = 0;
    this.wanderDy = 0;
  }

  update(players) {
    switch (this.state) {
      case 'idle':
        this.stateTimer++;
        if (this.stateTimer > 60) {
          this.state = 'wander';
          this.stateTimer = 0;
          this.wanderDx = (Math.random() * 4 - 2);
          this.wanderDy = (Math.random() * 4 - 2);
        }
        break;

      case 'wander':
        this.x += this.wanderDx;
        this.y += this.wanderDy;
        this.x = Math.max(0, Math.min(WORLD_W, this.x));
        this.y = Math.max(0, Math.min(WORLD_H, this.y));
        let closestPlayer = null;
        let closestDist = Infinity;
        players.forEach(player => {
          if (player.alive) {
            const dist = Math.hypot(player.x - this.x, player.y - this.y);
            if (dist < closestDist && dist < 300) {
              closestDist = dist;
              closestPlayer = player;
            }
          }
        });
        if (closestPlayer) {
          this.target = closestPlayer;
          this.state = 'chase';
        }
        this.stateTimer++;
        if (this.stateTimer > 120) {
          this.wanderDx = (Math.random() * 4 - 2);
          this.wanderDy = (Math.random() * 4 - 2);
          this.stateTimer = 0;
        }
        break;

      case 'chase':
        if (!this.target || !this.target.alive) {
          this.state = 'idle';
          return;
        }
        const dist = Math.hypot(this.target.x - this.x, this.target.y - this.y);
        if (dist < ATTACK_RANGE) {
          this.state = 'attack';
        } else {
          const angle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
          this.x += Math.cos(angle) * 2;
          this.y += Math.sin(angle) * 2;
        }
        if (dist > 400) {
          this.state = 'idle';
        }
        break;

      case 'attack':
        if (!this.target || !this.target.alive) {
          this.state = 'idle';
          return;
        }
        const attackDist = Math.hypot(this.target.x - this.x, this.target.y - this.y);
        if (attackDist > ATTACK_RANGE) {
          this.state = 'chase';
        } else {
          if (this.attackCooldown === 0) {
            this.target.hp = Math.max(0, this.target.hp - ATTACK_DMG);
            this.attackCooldown = 40;
            if (this.target.hp <= 0) {
              this.target.alive = false;
              this.target.score -= 10;
            }
          }
          if (this.attackCooldown > 0) {
            this.attackCooldown--;
          }
          if (this.hp < this.maxHp * 0.25) {
            this.state = 'flee';
          }
        }
        break;

      case 'flee':
        let nearestPlayer = null;
        players.forEach(player => {
          if (player.alive) {
            const dist = Math.hypot(player.x - this.x, player.y - this.y);
            if (!nearestPlayer || dist < Math.hypot(nearestPlayer.x - this.x, nearestPlayer.y - this.y)) {
              nearestPlayer = player;
            }
          }
        });
        if (nearestPlayer) {
          const angle = Math.atan2(nearestPlayer.y - this.y, nearestPlayer.x - this.x);
          this.x -= Math.cos(angle) * 3;
          this.y -= Math.sin(angle) * 3;
        }
        this.x = Math.max(0, Math.min(WORLD_W, this.x));
        this.y = Math.max(0, Math.min(WORLD_H, this.y));
        this.stateTimer++;
        if (this.stateTimer > 200 || nearestPlayer === null) {
          this.state = 'idle';
        }
        break;
    }
  }
}

class CollectibleManager {
  constructor() {
    this.collectibles = [];
  }

  spawnCollectibles() {
    if (this.collectibles.length < 20) {
      this.collectibles.push({
        id: Date.now().toString() + Math.random(),
        type: Math.random() < 0.5 ? 'health' : 'speed',
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
      });
    }
  }

  checkPickups(player) {
    this.collectibles.forEach((collectible, index) => {
      const dist = Math.hypot(collectible.x - player.x, collectible.y - player.y);
      if (dist < 25) {
        if (collectible.type === 'health') {
          player.hp = Math.min(player.maxHp, player.hp + 40);
        } else if (collectible.type === 'speed') {
          player.speedBoostUntil = Date.now() + 10000;
        }
        player.score += 5;
        player.xp += 10;
        this.collectibles.splice(index, 1);
      }
    });
  }
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.bots = [];
    this.collectibleMgr = new CollectibleManager();
    this.gameTimer = 600;
    this.tickInterval = null;
  }

  addPlayer(player) {
    if (this.players.size >= MAX_ROOM) {
      return false;
    } else {
      this.players.set(player.id, player);
      return true;
    }
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  populateBots() {
    for (let i = 0; i < BOT_COUNT; i++) {
      this.bots.push(new Bot(i.toString()));
    }
  }

  startGameLoop(io) {
    if (this.tickInterval) return;
    this.populateBots();
    this.tickInterval = setInterval(() => this.gameLoop(io), TICK_RATE);
  }

  gameLoop(io) {
    this.gameTimer--;
    if (this.gameTimer <= 0) {
      this.players.forEach(player => savePlayerSession(player));
      io.to(this.id).emit('matchEnd', [...this.players.values()].map(p => ({ id: p.id, score: p.score })));
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      return;
    }
    this.players.forEach(player => {
      if (player.inputBuffer.length > 0) {
        const input = player.inputBuffer.shift();
        player.x += input.dx * player.speed;
        player.y += input.dy * player.speed;
        player.x = Math.max(0, Math.min(WORLD_W, player.x));
        player.y = Math.max(0, Math.min(WORLD_H, player.y));
        if (Date.now() > player.speedBoostUntil) {
          player.speed = SPEED;
        } else {
          player.speed = SPEED * 1.5;
        }
      }
    });
    this.bots.forEach(bot => bot.update(this.players));
    this.collectibleMgr.spawnCollectibles();
    this.players.forEach(player => this.collectibleMgr.checkPickups(player));

    // Bot-player collision
    this.bots.forEach(bot => {
      this.players.forEach(player => {
        const dist = Math.hypot(bot.x - player.x, bot.y - player.y);
        if (dist < 40 && bot.attackCooldown === 0) {
          player.hp -= ATTACK_DMG;
          bot.attackCooldown = 40;
        }
        if (player.hp <= 0) {
          player.alive = false;
          player.score -= 10;
          io.to(this.id).emit('playerDied', { playerId: player.id });
        }
      });
    });

    this.broadcastState(io);
  }

  broadcastState(io) {
    const state = {
      players: [...this.players.values()].map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        score: p.score,
        xp: p.xp,
        level: p.level,
        alive: p.alive,
      })),
      bots: this.bots.map(b => ({
        id: b.id,
        name: b.name,
        x: b.x,
        y: b.y,
        hp: b.hp,
        maxHp: b.maxHp,
      })),
      collectibles: this.collectibleMgr.collectibles,
      gameTimer: this.gameTimer,
    };
    io.to(this.id).emit('gameState', state);
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  findOrCreateRoom() {
    for (const room of this.rooms.values()) {
      if (room.players.size < MAX_ROOM) {
        return room;
      }
    }
    const newRoom = new Room(Date.now().toString());
    this.rooms.set(newRoom.id, newRoom);
    return newRoom;
  }

  destroyRoom(room) {
    if (room.tickInterval) {
      clearInterval(room.tickInterval);
    }
    this.rooms.delete(room.id);
  }
}

const roomManager = new RoomManager();

function savePlayerSession(player) {
  const duration = Math.floor((Date.now() - player.sessionStart) / 1000);
  const sessionId = Date.now().toString();
  insertSession.run(sessionId, player.id, player.score, player.xp, duration, new Date().toISOString());
  upsertPlayer.run(player.id, player.username, player.level, player.xp, player.score, player.gamesPlayed + 1, new Date().toISOString());
}

function loadPlayerProfile(username) {
  return db.prepare('SELECT * FROM players WHERE username = ?').get(username);
}

function getGlobalLeaderboard() {
  return getTopPlayers.all();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ username }) => {
    if (!username) return;
    const profile = loadPlayerProfile(username) || { username, level: 1, xp: 0, allTimeScore: 0, gamesPlayed: 0 };
    const player = new Player(socket.id, profile.username);
    player.level = profile.level;
    player.xp = profile.xp;

    const room = roomManager.findOrCreateRoom();
    if (room.addPlayer(player)) {
      socket.join(room.id);
      socket.currentRoomId = room.id;
      socket.currentPlayerId = socket.id;

      const leaderboard = getGlobalLeaderboard();
      io.to(room.id).emit('roomJoined', {
        roomId: room.id,
        playerId: player.id,
        profile: { level: player.level, xp: player.xp, allTimeScore: profile.allTimeScore },
        leaderboard,
      });
      room.startGameLoop(io);
    }
  });

  socket.on('playerInput', (input) => {
    const room = roomManager.rooms.get(socket.currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.currentPlayerId);
    if (!player || !player.alive) return;

    player.inputBuffer.push({ dx: input.dx, dy: input.dy, action: input.action });
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });

  socket.on('requestLeaderboard', () => {
    const leaderboard = getGlobalLeaderboard();
    socket.emit('globalLeaderboard', leaderboard);
  });

  socket.on('disconnect', () => {
    const room = roomManager.rooms.get(socket.currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.currentPlayerId);
    if (player) {
      savePlayerSession(player);
      room.removePlayer(socket.currentPlayerId);
      if (room.players.size === 0) {
        roomManager.destroyRoom(room);
      }
    }
  });
});

app.use(express.static('public'));
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});