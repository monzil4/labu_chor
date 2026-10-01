const socket = io();

let currentRoom = null;
let myId = null;
let isThief = false;
let alertTimer = null;
let countdownTimer = null;

// --- অডিও সিন্থেসাইজার ইঞ্জিন ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, type = 'sine', duration = 0.15) {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {}
}

const SFX = {
  click: () => playTone(600, 'triangle', 0.05),
  spin: () => {
    let count = 0;
    const interval = setInterval(() => {
      playTone(400 + count * 30, 'square', 0.05);
      count++;
      if (count > 20) clearInterval(interval);
    }, 120);
  },
  gesture: () => {
    playTone(523, 'sine', 0.1);
    setTimeout(() => playTone(659, 'sine', 0.1), 100);
    setTimeout(() => playTone(784, 'sine', 0.2), 200);
  },
  fakeAlarm: () => {
    playTone(200, 'sawtooth', 0.3);
    setTimeout(() => playTone(150, 'sawtooth', 0.4), 250);
  },
  win: () => {
    playTone(440, 'triangle', 0.1);
    setTimeout(() => playTone(554, 'triangle', 0.1), 120);
    setTimeout(() => playTone(659, 'triangle', 0.25), 240);
  }
};

// --- ফুলপ্রুফ লাইভ ভয়েস ইঞ্জিন (WebRTC) ---
let localStream = null;
let isMuted = true;
const peers = {};

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

async function initVoice() {
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.getAudioTracks()[0].enabled = false; // শুরুতে মিউট
      setupAudioAnalysis(localStream);
    }
  } catch (e) {
    console.log('মাইক্রোফোন চালু করা যায়নি:', e);
  }
}

function createPeerConnection(targetId) {
  const pc = new RTCPeerConnection(rtcConfig);
  peers[targetId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // অডিও পাওয়ার সাথে সাথে জোরপূর্বক বাজানো (Autoplay bypass)
  pc.ontrack = (event) => {
    let audio = document.getElementById(`audio_${targetId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio_${targetId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.play().catch(e => {
      console.log('Autoplay restriction bypassed on interaction');
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('voiceSignal', { to: targetId, signal: { candidate: event.candidate } });
    }
  };

  return pc;
}

// সিগন্যাল আদান প্রদান
socket.on('voiceSignal', async ({ from, signal }) => {
  let pc = peers[from];
  if (!pc) pc = createPeerConnection(from);

  try {
    if (signal.desc) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.desc));
      if (signal.desc.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voiceSignal', { to: from, signal: { desc: pc.localDescription } });
      }
    } else if (signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (err) {}
});

async function callUser(targetId) {
  const pc = createPeerConnection(targetId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('voiceSignal', { to: targetId, signal: { desc: pc.localDescription } });
  } catch (e) {}
}

async function toggleMic() {
  SFX.click();
  if (!localStream) {
    await initVoice();
  }
  
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  // ব্রাউজারের অডিও চালু নিশ্চিত করা
  document.querySelectorAll('audio').forEach(a => a.play().catch(() => {}));

  const track = localStream.getAudioTracks()[0];
  isMuted = !isMuted;
  track.enabled = !isMuted;

  const btn = document.getElementById('micBtn');
  if (!isMuted) {
    btn.classList.add('active');
    btn.innerText = '🎙️ মাইক অন';
  } else {
    btn.classList.remove('active');
    btn.innerText = '🎙️ মাইক অফ';
  }
}

// সাউন্ড মিটার
function setupAudioAnalysis(stream) {
  try {
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    setInterval(() => {
      if (isMuted) {
        setSpeakingUI(myId, false);
        return;
      }
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      setSpeakingUI(myId, avg > 15);
    }, 150);
  } catch (e) {}
}

function setSpeakingUI(playerId, isSpeaking) {
  const node = document.querySelector(`.player-node[data-id="${playerId}"]`);
  if (!node) return;
  if (isSpeaking) node.classList.add('speaking');
  else node.classList.remove('speaking');
}

// --- ফ্রন্টএন্ড বাটন কন্ট্রোল ---
function createRoom() {
  SFX.click();
  const name = document.getElementById('playerName').value.trim();
  if (!name) return alert('অনুগ্রহ করে আপনার নাম দিন!');
  socket.emit('createRoom', { name });
}

function joinRoom() {
  SFX.click();
  const name = document.getElementById('playerName').value.trim();
  const roomCode = document.getElementById('roomCodeInput').value.trim();
  if (!name || !roomCode) return alert('নাম এবং রুম কোড দুটোই লাগবে!');
  socket.emit('joinRoom', { roomCode, name });
}

function startGame() {
  SFX.click();
  socket.emit('startGame', { roomCode: currentRoom.code });
}

function claimGesture() {
  SFX.click();
  socket.emit('claimGesture', { roomCode: currentRoom.code });
}

function selectTarget(targetId) {
  SFX.click();
  socket.emit('selectTarget', { roomCode: currentRoom.code, targetId });
}

function submitPrediction(suspectId) {
  SFX.click();
  clearInterval(countdownTimer);
  socket.emit('submitPrediction', { roomCode: currentRoom.code, suspectId });
}

function submitFinalVerdict(accusedId) {
  SFX.click();
  socket.emit('submitFinalVerdict', { roomCode: currentRoom.code, accusedId });
}

function nextRound() {
  SFX.click();
  socket.emit('nextRound', { roomCode: currentRoom.code });
}

function endMatch() {
  SFX.click();
  socket.emit('endMatch', { roomCode: currentRoom.code });
}

function sendEmoji(emoji) {
  socket.emit('sendEmoji', { roomCode: currentRoom.code, emoji });
}

// --- সকেট ইভেন্টস ---
socket.on('roomJoined', async ({ roomCode, myId: id }) => {
  myId = id;
  await initVoice();
});

socket.on('roleAssigned', (data) => isThief = data.isThief);
socket.on('errorMsg', (msg) => alert(msg));

socket.on('youGotGesture', ({ thiefName }) => {
  SFX.gesture();
  const gBox = document.getElementById('gestureReceivedBox');
  gBox.innerHTML = `🍋 আপনাকে <b>${thiefName}</b> ইশারা দিয়েছে! নিশ্চিত করতে নিচের বাটনে চাপুন!`;
  gBox.classList.remove('hidden');
});

socket.on('globalFakeWarning', ({ blufferName }) => {
  SFX.fakeAlarm();
  document.getElementById('mainApp').classList.add('shake-screen');
  setTimeout(() => document.getElementById('mainApp').classList.remove('shake-screen'), 400);

  const alertBox = document.getElementById('globalAlert');
  alertBox.innerHTML = `🚨 <b>${blufferName}</b> ভং ধরছে! সে কোনো ইশারা পায়নি! 😂`;
  alertBox.style.display = 'block';

  if (alertTimer) clearTimeout(alertTimer);
  alertTimer = setTimeout(() => alertBox.style.display = 'none', 3500);
});

socket.on('aimLaser', ({ fromId, toId }) => drawLaser(fromId, toId));

socket.on('floatingEmoji', ({ emoji }) => {
  const el = document.createElement('div');
  el.className = 'flying-emoji';
  el.innerText = emoji;
  el.style.left = `${Math.random() * 80 + 10}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
});

socket.on('updateRoom', (room) => {
  currentRoom = room;

  // যখনই কোনো প্লেয়ার যোগ দেবে, স্বয়ংক্রিয়ভাবে অডিও কানেকশন তৈরি
  if (localStream) {
    room.players.forEach(p => {
      if (p.id !== myId && !peers[p.id]) {
        callUser(p.id);
      }
    });
  }

  renderUI(room);
});

// লেজার রশ্মি
function drawLaser(fromId, toId) {
  const fromNode = document.querySelector(`.player-node[data-id="${fromId}"]`);
  const toNode = document.querySelector(`.player-node[data-id="${toId}"]`);
  const svg = document.getElementById('laserSvg');
  if (!fromNode || !toNode || !svg) return;

  const x1 = parseFloat(fromNode.style.left);
  const y1 = parseFloat(fromNode.style.top);
  const x2 = parseFloat(toNode.style.left);
  const y2 = parseFloat(toNode.style.top);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x2);
  line.setAttribute('y2', y2);
  line.setAttribute('stroke', '#38bdf8');
  line.setAttribute('stroke-width', '4');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-dasharray', '8');
  line.style.filter = 'drop-shadow(0 0 8px #38bdf8)';

  svg.appendChild(line);
  setTimeout(() => line.remove(), 2500);
}

// UI রেন্ডার
function renderUI(room) {
  document.getElementById('homeScreen').classList.add('hidden');
  document.getElementById('topNav').classList.remove('hidden');
  document.getElementById('topScoreboardCard').classList.remove('hidden');
  document.getElementById('gameArenaScreen').classList.remove('hidden');
  document.getElementById('emojiDock').classList.remove('hidden');
  document.getElementById('codeBadge').innerText = room.code;

  if (room.status !== 'GESTURE') {
    document.getElementById('gestureReceivedBox').classList.add('hidden');
  }

  // ১. লিডারবোর্ড টেবিল
  const tbody = document.getElementById('scoreTableBody');
  tbody.innerHTML = room.players.map(p => {
    let state = 'অপেক্ষারত';
    if (room.status === 'PREDICTION_PHASE') {
      const curTurnId = room.turnOrder[room.currentTurnIndex];
      if (p.id === curTurnId) state = '👉 অনুমান করছে...';
      else if (room.predictions[p.id]) state = `সন্দেহ: ${room.predictions[p.id].suspectName}`;
    } else if (p.id === room.targetId && room.status !== 'GESTURE') {
      state = '🍋 ইশারা পেয়েছে';
    }
    return `
      <tr>
        <td><b>${p.avatar} ${p.name}</b> ${p.id === myId ? '(আপনি)' : ''}</td>
        <td style="color:var(--lemon); font-weight:bold; font-size:15px;">${p.score}</td>
        <td style="font-size:12px; color:var(--accent);">${state}</td>
      </tr>
    `;
  }).join('');

  // ২. সার্কেল এরিনা
  const circle = document.getElementById('arenaCircle');
  circle.querySelectorAll('.player-node').forEach(el => el.remove());

  const total = room.players.length;
  const radius = 115;

  room.players.forEach((p, idx) => {
    const angle = (idx / total) * (2 * Math.PI) - (Math.PI / 2);
    const x = 155 + radius * Math.cos(angle);
    const y = 155 + radius * Math.sin(angle);

    const node = document.createElement('div');
    node.className = 'player-node';
    node.dataset.id = p.id;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;

    if (room.targetId && p.id === room.targetId && room.status !== 'GESTURE') {
      node.classList.add('got-target');
    }

    const activeTurnId = (room.status === 'PREDICTION_PHASE') ? room.turnOrder[room.currentTurnIndex] : null;
    if (p.id === activeTurnId) {
      node.classList.add('active-turn');
    }

    node.onclick = () => {
      if (room.status === 'GESTURE' && isThief && p.id !== myId) {
        selectTarget(p.id);
      } else if (room.status === 'PREDICTION_PHASE' && activeTurnId === myId && p.id !== myId) {
        submitPrediction(p.id);
      } else if (room.status === 'FINAL_VERDICT' && room.targetId === myId && p.id !== myId) {
        submitFinalVerdict(p.id);
      }
    };

    node.innerHTML = `
      <span class="node-avatar">${p.avatar}</span>
      <span class="node-name">${p.name}</span>
    `;
    circle.appendChild(node);
  });

  // ৩. কন্ট্রোল প্যানেল
  const instr = document.getElementById('statusInstruction');
  const startBtn = document.getElementById('startGameBtn');
  const claimBtn = document.getElementById('claimGestureBtn');
  const selBox = document.getElementById('selectionBox');
  const selTitle = document.getElementById('selectionTitle');
  const selBtns = document.getElementById('selectionButtons');
  const wheel = document.getElementById('centerWheel');
  const timerBadge = document.getElementById('turnTimer');

  startBtn.classList.add('hidden');
  claimBtn.classList.add('hidden');
  selBox.classList.add('hidden');
  timerBadge.classList.add('hidden');
  selBtns.innerHTML = '';
  clearInterval(countdownTimer);

  if (room.status === 'LOBBY') {
    instr.innerText = `লবি: খেলোয়াড় সংখ্যা (${room.players.length}/৩+)`;
    wheel.classList.remove('spinning');
    if (room.hostId === myId) startBtn.classList.remove('hidden');
  }
  else if (room.status === 'WHEEL_SPINNING') {
    instr.innerText = 'চোর নির্বাচন চলছে... ভাগ্যের চাকা ঘুরছে!';
    wheel.classList.add('spinning');
    SFX.spin();
  }
  else if (room.status === 'GESTURE') {
    wheel.classList.remove('spinning');
    claimBtn.classList.remove('hidden');

    if (isThief) {
      instr.innerText = '🍋 আপনি লেবু চোর! কাউকে বাস্তবে ইশারা দিয়ে তাকে সিলেক্ট করুন:';
      selBox.classList.remove('hidden');
      selTitle.innerText = 'কাকে ইশারা দিয়েছেন? সিলেক্ট করুন:';
      selBtns.innerHTML = room.players.filter(p => p.id !== myId).map(p => `
        <button class="btn-3d btn-secondary" onclick="selectTarget('${p.id}')">👉 ${p.avatar} ${p.name}</button>
      `).join('');
    } else {
      instr.innerText = 'ইশারা পর্ব চলছে! কেউ ইশারা দিলে বাটনে চাপুন...';
    }
  }
  else if (room.status === 'PREDICTION_PHASE') {
    wheel.classList.remove('spinning');
    const activeId = room.turnOrder[room.currentTurnIndex];
    const activePlayer = room.players.find(p => p.id === activeId);

    timerBadge.classList.remove('hidden');
    let timeLeft = 15;
    document.getElementById('timerSeconds').innerText = timeLeft;
    countdownTimer = setInterval(() => {
      timeLeft--;
      document.getElementById('timerSeconds').innerText = timeLeft;
      if (timeLeft <= 0) {
        clearInterval(countdownTimer);
        if (activeId === myId) {
          const fallback = room.players.find(p => p.id !== myId);
          submitPrediction(fallback.id);
        }
      }
    }, 1000);

    if (activeId === myId) {
      instr.innerText = '🎯 আপনার পালা! কাকে চোর মনে হচ্ছে সিলেক্ট করুন:';
      selBox.classList.remove('hidden');
      selTitle.innerText = 'সন্দেহভাজন বেছে নিন:';
      selBtns.innerHTML = room.players.filter(p => p.id !== myId).map(p => `
        <button class="btn-3d btn-secondary" onclick="submitPrediction('${p.id}')">🕵️ ${p.avatar} ${p.name}</button>
      `).join('');
    } else {
      instr.innerText = `${activePlayer?.name} এখন অনুমান করছে... অপেক্ষা করুন।`;
    }
  }
  else if (room.status === 'FINAL_VERDICT') {
    wheel.classList.remove('spinning');
    const target = room.players.find(p => p.id === room.targetId);
    if (room.targetId === myId) {
      instr.innerText = 'সবার অনুমান শেষ! আপনার চূড়ান্ত রায় দিন: আসল চোর কে?';
      selBox.classList.remove('hidden');
      selTitle.innerText = 'চূড়ান্ত রায় (আসল চোর):';
      selBtns.innerHTML = room.players.filter(p => p.id !== myId).map(p => `
        <button class="btn-3d btn-warning" onclick="submitFinalVerdict('${p.id}')">🎯 ${p.avatar} ${p.name} আসল চোর!</button>
      `).join('');
    } else {
      instr.innerText = `${target?.name} এখন চূড়ান্ত রায় দিচ্ছে...`;
    }
  }
  else if (room.status === 'ROUND_OVER') {
    wheel.classList.remove('spinning');
    SFX.win();
    const res = room.lastRoundResult;

    let summary = `রাউন্ড শেষ! লেবু চোর ছিল <b style="color:var(--danger); font-size:18px;">${res.thiefName}</b>।<br/>`;
    summary += `<span style="color:var(--success);">🎯 ${res.targetName} সঠিক চোর চিহ্নিত করে ১০ পয়েন্ট পেয়েছে!</span>`;

    if (res.thiefGotPoints) {
      summary += `<br/><span style="color:var(--lemon);">😈 চোর সাধারণদের ফাঁকি দিয়ে ১০ পয়েন্ট পেয়েছে!</span>`;
    } else {
      summary += `<br/><span style="color:var(--accent);">👏 সবাই চোরকে ধরতে পেরেছে! চোর ০ পয়েন্ট পেয়েছে!</span>`;
    }

    instr.innerHTML = summary;

    if (room.hostId === myId) {
      selBox.classList.remove('hidden');
      selTitle.innerText = 'পরবর্তী পদক্ষেপ:';
      selBtns.innerHTML = `
        <button class="btn-3d btn-primary" onclick="nextRound()">🚀 পরবর্তী রাউন্ড শুরু করুন</button>
        <button class="btn-3d btn-secondary" onclick="endMatch()">🏆 খেলা সমাপ্ত করুন (Final Winner)</button>
      `;
    }
  }
  else if (room.status === 'MATCH_ENDED') {
    showMatchOverScreen(room);
  }
}

function showMatchOverScreen(room) {
  document.getElementById('gameArenaScreen').classList.add('hidden');
  document.getElementById('matchEndedScreen').classList.remove('hidden');

  try {
    confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
  } catch (e) {}

  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const champ = sorted[0];
  const loser = sorted[sorted.length - 1];

  document.getElementById('winnerPodium').innerHTML = `
    <div style="font-size: 22px; margin-bottom: 8px;">👑 লেবু রাজা: <b style="color:var(--lemon);">${champ.name}</b> (${champ.score} পয়েন্ট)</div>
    <div style="font-size: 15px; color:#f87171;">🤪 পাকা বোকা: <b>${loser.name}</b> (${loser.score} পয়েন্ট)</div>
  `;
}