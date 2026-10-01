const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const AVATARS = ['🍋', '🕵️', '😎', '🥸', '🐱', '🦊', '🐸', '🐼'];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = '';
  for (let i = 0; i < 4; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

function initiateRound(room) {
  const randIndex = Math.floor(Math.random() * room.players.length);
  room.thiefId = room.players[randIndex].id;
  room.targetId = null;
  room.predictions = {};
  room.turnOrder = [];
  room.currentTurnIndex = 0;
  room.status = 'WHEEL_SPINNING';

  room.players.forEach(p => {
    io.to(p.id).emit('roleAssigned', { isThief: p.id === room.thiefId });
  });

  io.to(room.code).emit('updateRoom', room);

  setTimeout(() => {
    if (rooms[room.code] && rooms[room.code].status === 'WHEEL_SPINNING') {
      rooms[room.code].status = 'GESTURE';
      io.to(room.code).emit('updateRoom', rooms[room.code]);
    }
  }, 3800);
}

io.on('connection', (socket) => {
  // ১. রুম তৈরি
  socket.on('createRoom', ({ name }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: [{ id: socket.id, name, avatar: AVATARS[0], score: 0 }],
      status: 'LOBBY',
      thiefId: null,
      targetId: null,
      turnOrder: [],
      currentTurnIndex: 0,
      predictions: {},
      lastRoundResult: null
    };
    socket.join(roomCode);
    socket.emit('roomJoined', { roomCode, myId: socket.id });
    io.to(roomCode).emit('updateRoom', rooms[roomCode]);
  });

  // ২. রুমে জয়েন
  socket.on('joinRoom', ({ roomCode, name }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('errorMsg', 'এই কোডের কোনো রুম নেই!');
    if (room.status !== 'LOBBY') return socket.emit('errorMsg', 'খেলা ইতিমধ্যে চলছে!');

    const avatar = AVATARS[room.players.length % AVATARS.length];
    room.players.push({ id: socket.id, name, avatar, score: 0 });
    socket.join(code);
    socket.emit('roomJoined', { roomCode: code, myId: socket.id });
    io.to(code).emit('updateRoom', room);
  });

  // ৩. গেম শুরু
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return socket.emit('errorMsg', 'কমপক্ষে ৩ জন প্লেয়ার লাগবে!');
    initiateRound(room);
  });

  // ৪. চোর টার্গেট বেছে নিল
  socket.on('selectTarget', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.thiefId) return;

    room.targetId = targetId;
    const thief = room.players.find(p => p.id === room.thiefId);

    io.to(targetId).emit('youGotGesture', { thiefName: thief.name });
    io.to(room.code).emit('updateRoom', room);
  });

  // ৫. ইশারা কনফার্ম
  socket.on('claimGesture', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'GESTURE') return;

    const clicker = room.players.find(p => p.id === socket.id);

    if (room.targetId && room.targetId === socket.id) {
      room.status = 'PREDICTION_PHASE';

      const targetIdx = room.players.findIndex(p => p.id === room.targetId);
      const total = room.players.length;
      room.turnOrder = [];

      for (let i = 1; i < total; i++) {
        const nextIdx = (targetIdx + i) % total;
        if (room.players[nextIdx].id !== room.targetId) {
          room.turnOrder.push(room.players[nextIdx].id);
        }
      }
      room.currentTurnIndex = 0;
      io.to(room.code).emit('updateRoom', room);
    } else {
      const blufferName = clicker ? clicker.name : 'একজন';
      io.to(room.code).emit('globalFakeWarning', { blufferName });
    }
  });

  // ৬. অনুমান সাবমিট
  socket.on('submitPrediction', ({ roomCode, suspectId }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'PREDICTION_PHASE') return;

    const currentPredictorId = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== currentPredictorId) return;

    const predictor = room.players.find(p => p.id === socket.id);
    const suspect = room.players.find(p => p.id === suspectId);

    room.predictions[socket.id] = {
      predictorId: socket.id,
      predictorName: predictor.name,
      suspectId: suspectId,
      suspectName: suspect.name
    };

    io.to(room.code).emit('aimLaser', { fromId: socket.id, toId: suspectId });

    room.currentTurnIndex++;

    if (room.currentTurnIndex >= room.turnOrder.length) {
      room.status = 'FINAL_VERDICT';
    }

    io.to(room.code).emit('updateRoom', room);
  });

  // ৭. চূড়ান্ত রায় ও স্কোর
  socket.on('submitFinalVerdict', ({ roomCode, accusedId }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'FINAL_VERDICT' || socket.id !== room.targetId) return;

    const thief = room.players.find(p => p.id === room.thiefId);
    const target = room.players.find(p => p.id === room.targetId);

    let atLeastOneWrong = false;

    Object.keys(room.predictions).forEach(pId => {
      if (pId !== room.thiefId) {
        if (room.predictions[pId].suspectId === room.thiefId) {
          const player = room.players.find(p => p.id === pId);
          if (player) player.score += 10;
        } else {
          atLeastOneWrong = true;
        }
      }
    });

    target.score += 10;

    let thiefGotPoints = false;
    if (atLeastOneWrong) {
      thief.score += 10;
      thiefGotPoints = true;
    }

    room.status = 'ROUND_OVER';
    room.lastRoundResult = {
      thiefName: thief.name,
      targetName: target.name,
      thiefGotPoints: thiefGotPoints
    };

    io.to(room.code).emit('updateRoom', room);
  });

  // ৮. পরবর্তী রাউন্ড
  socket.on('nextRound', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    initiateRound(room);
  });

  // ৯. ম্যাচ সম্পূর্ণ শেষ
  socket.on('endMatch', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.status = 'MATCH_ENDED';
    io.to(room.code).emit('updateRoom', room);
  });

  // ১০. লাইভ ইমোজি ব্রডকাস্ট
  socket.on('sendEmoji', ({ roomCode, emoji }) => {
    io.to(roomCode).emit('floatingEmoji', { emoji });
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          io.to(code).emit('updateRoom', room);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`লেবু চোর সার্ভার চালু হয়েছে: http://localhost:${PORT}`);
});