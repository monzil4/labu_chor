const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let res = '';
  for (let i = 0; i < 4; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

// ১০০% র‍্যান্ডম লটারির মাধ্যমে রাউন্ড শুরু
function initiateRound(room) {
  // কোনো সিরিয়াল নেই, সম্পূর্ণ আনপ্রেডিক্টেবল লটারি
  const randIndex = Math.floor(Math.random() * room.players.length);
  room.thiefId = room.players[randIndex].id;
  room.targetId = null;
  room.predictions = {};
  room.turnOrder = [];
  room.currentTurnIndex = 0;
  room.status = 'WHEEL_SPINNING';

  // যার যার রোল পাঠানো
  room.players.forEach(p => {
    io.to(p.id).emit('roleAssigned', { isThief: p.id === room.thiefId });
  });

  io.to(room.code).emit('updateRoom', room);

  // ৩.৫ সেকেন্ড পর হুইল শেষ হয়ে ইশারা পর্ব শুরু হবে
  setTimeout(() => {
    if (rooms[room.code] && rooms[room.code].status === 'WHEEL_SPINNING') {
      rooms[room.code].status = 'GESTURE';
      io.to(room.code).emit('updateRoom', rooms[room.code]);
    }
  }, 3500);
}

io.on('connection', (socket) => {
  // ১. রুম তৈরি
  socket.on('createRoom', ({ name }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0 }],
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

    room.players.push({ id: socket.id, name, score: 0 });
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

  // ৪. চোর ইশারা দেওয়ার টার্গেট সিলেক্ট করল
  socket.on('selectTarget', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.thiefId) return;

    room.targetId = targetId;
    const thief = room.players.find(p => p.id === room.thiefId);

    // যে ইশারা পেল শুধুমাত্র তাকে জানিয়ে দেওয়া যে কে ইশারা দিল
    io.to(targetId).emit('youGotGesture', { thiefName: thief.name });
    io.to(room.code).emit('updateRoom', room);
  });

  // ৫. "আমি ইশারা পেয়েছি" কনফার্মেশন
  socket.on('claimGesture', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'GESTURE') return;

    const clicker = room.players.find(p => p.id === socket.id);

    // সঠিক ব্যক্তি কনফার্ম করলে
    if (room.targetId && room.targetId === socket.id) {
      room.status = 'PREDICTION_PHASE';

      // ইশারা পাওয়া ব্যক্তি বাদে বাকিদের সিরিয়াল তৈরি (টার্গেটের বামের জন থেকে শুরু)
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
      // 🚨 ভুল যে-ই চাপবে, সাথে সাথে সবার স্ক্রিনে ট্রল পপ-আপ যাবে
      const blufferName = clicker ? clicker.name : 'একজন';
      io.to(room.code).emit('globalFakeWarning', { blufferName });
    }
  });

  // ৬. ক্রমানুসারে অনুমান সাবমিট
  socket.on('submitPrediction', ({ roomCode, suspectId }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'PREDICTION_PHASE') return;

    const currentPredictorId = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== currentPredictorId) return;

    const predictor = room.players.find(p => p.id === socket.id);
    const suspect = room.players.find(p => p.id === suspectId);

    room.predictions[socket.id] = {
      predictorName: predictor.name,
      suspectId: suspectId,
      suspectName: suspect.name
    };

    room.currentTurnIndex++;

    // সবার অনুমান শেষ হলে চূড়ান্ত রায়ের জন্য টার্গেটের কাছে যাবে
    if (room.currentTurnIndex >= room.turnOrder.length) {
      room.status = 'FINAL_VERDICT';
    }

    io.to(room.code).emit('updateRoom', room);
  });

  // ৭. চূড়ান্ত রায় ও ১০০% নিখুঁত স্কোর ক্যালকুলেশন
  socket.on('submitFinalVerdict', ({ roomCode, accusedId }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'FINAL_VERDICT' || socket.id !== room.targetId) return;

    const thief = room.players.find(p => p.id === room.thiefId);
    const target = room.players.find(p => p.id === room.targetId);

    let atLeastOneWrong = false;

    // ১. সাধারণ খেলোয়াড়দের পয়েন্ট: যারা সঠিক চোর ধরেছে তারা প্রত্যেকে ১০ পয়েন্ট পাবে
    Object.keys(room.predictions).forEach(pId => {
      if (pId !== room.thiefId) {
        if (room.predictions[pId].suspectId === room.thiefId) {
          const player = room.players.find(p => p.id === pId);
          if (player) player.score += 10;
        } else {
          atLeastOneWrong = true; // ভুল অনুমান করেছে
        }
      }
    });

    // ২. ইশারা পাওয়া ব্যক্তির পয়েন্ট: সে নিশ্চিতভাবেই ১০ পয়েন্ট পাবে
    target.score += 10;

    // ৩. চোরের পয়েন্ট: অন্তত একজন ভুল অনুমান করলেই চোর ফাঁকি দিতে পেরেছে, তাই চোর পাবে ১০
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

  // ৮. পরবর্তী রাউন্ড শুরু
  socket.on('nextRound', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    initiateRound(room);
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