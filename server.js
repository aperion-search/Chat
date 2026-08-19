require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { Storage } = require('megajs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.json({ limit: '100mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'lovers_secret_session',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 Days Session
}));

const JSON_FILE_PATH = path.join(__dirname, 'database.json');
const MEGA_FILE_NAME = 'lovers_chat_db.json';

const P1_NAME = process.env.PARTNER_1_NAME || 'Partner A';
const P1_PASS = process.env.PARTNER_1_PASS || 'pass1234';
const P2_NAME = process.env.PARTNER_2_NAME || 'Partner B';
const P2_PASS = process.env.PARTNER_2_PASS || 'pass5678';

// --- MEGA DATABASE STORAGE & CREDENTIAL SYNC ---
async function getMegaStorage() {
  const storage = new Storage({
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASSWORD
  });
  await storage.ready;
  return storage;
}

async function syncFromMega() {
  try {
    const storage = await getMegaStorage();
    const file = storage.root.children.find(f => f.name === MEGA_FILE_NAME);
    if (file) {
      const data = await file.downloadBuffer();
      fs.writeFileSync(JSON_FILE_PATH, data);
    } else {
      if (!fs.existsSync(JSON_FILE_PATH)) {
        fs.writeFileSync(JSON_FILE_PATH, JSON.stringify({ users: [], messages: [] }));
      }
    }
  } catch (err) {
    if (!fs.existsSync(JSON_FILE_PATH)) {
      fs.writeFileSync(JSON_FILE_PATH, JSON.stringify({ users: [], messages: [] }));
    }
  }
  await updatePartnerCredentials();
}

async function updatePartnerCredentials() {
  let data = readData();
  const hash1 = await bcrypt.hash(P1_PASS, 10);
  const hash2 = await bcrypt.hash(P2_PASS, 10);

  data.users = [
    { username: P1_NAME, passwordHash: hash1 },
    { username: P2_NAME, passwordHash: hash2 }
  ];

  fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(data, null, 2));
  await syncToMega();
}

async function syncToMega() {
  try {
    const storage = await getMegaStorage();
    const file = storage.root.children.find(f => f.name === MEGA_FILE_NAME);
    if (file) await file.delete();
    const content = fs.readFileSync(JSON_FILE_PATH);
    await storage.upload(MEGA_FILE_NAME, content).complete;
  } catch (err) { console.error('MEGA Sync Error:', err); }
}

function readData() {
  if (!fs.existsSync(JSON_FILE_PATH)) return { users: [], messages: [] };
  return JSON.parse(fs.readFileSync(JSON_FILE_PATH, 'utf-8'));
}

// --- AUTHENTICATION MIDDLEWARE ---
function checkUserAuth(req, res, next) {
  if (req.session && req.session.username) return next();
  res.status(401).json({ status: 'error', message: 'Unauthorized. Please login.' });
}

function checkAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).send('Unauthorized');
}

// --- LOGIN & AUTH ROUTES ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const data = readData();
  const user = data.users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());

  if (!user) return res.status(401).json({ status: 'error', message: 'User not found' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (match) {
    req.session.username = user.username;
    return res.json({ status: 'ok', username: user.username });
  }

  res.status(401).json({ status: 'error', message: 'Invalid password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ status: 'ok' });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.username) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.json({ authenticated: false });
});

// --- ADMIN API ---
app.post('/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ status: 'ok' });
  }
  res.status(401).json({ status: 'error' });
});

app.get('/admin/download/json', checkAdmin, (req, res) => {
  res.download(JSON_FILE_PATH, 'chat_database.json');
});

app.get('/admin/download/pdf', checkAdmin, (req, res) => {
  const data = readData();
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=chat_history.pdf');
  doc.pipe(res);
  doc.fontSize(18).text('Secret Chat Logs', { align: 'center' }).moveDown();
  data.messages.forEach(m => {
    doc.fontSize(10).fillColor('gray').text(`[${m.timestamp}] ${m.sender} (${m.type}):`);
    doc.fontSize(12).fillColor('black').text(m.type === 'text' ? m.encryptedText : '[Encrypted Media/File]').moveDown(0.5);
  });
  doc.end();
});

// --- CHAT API ---
app.get('/api/messages', checkUserAuth, (req, res) => res.json(readData().messages));

app.post('/api/messages', checkUserAuth, async (req, res) => {
  const { encryptedText, type, fileData, fileName } = req.body;
  const data = readData();
  const msg = {
    id: Date.now(),
    sender: req.session.username,
    type: type || 'text',
    encryptedText,
    fileData: fileData || null,
    fileName: fileName || null,
    timestamp: new Date().toLocaleTimeString()
  };
  data.messages.push(msg);
  fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(data, null, 2));
  await syncToMega();
  io.emit('new_message', msg);
  res.json(msg);
});

// --- SOCKET.IO SIGNALLING FOR WEBRTC ---
io.on('connection', (socket) => {
  socket.on('join', () => socket.join('lovers_room'));
  
  socket.on('call_user', (data) => {
    socket.to('lovers_room').emit('incoming_call', { signal: data.signal, from: data.from, video: data.video });
  });

  socket.on('answer_call', (data) => {
    socket.to('lovers_room').emit('call_accepted', data.signal);
  });

  socket.on('end_call', () => {
    socket.to('lovers_room').emit('call_ended');
  });
});

// --- ADMIN PANEL UI ---
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><title>Admin Panel</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { background: #111b21; color: #e9edef; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .card { background: #202c33; padding: 20px; border-radius: 12px; text-align: center; width: 90%; max-width: 350px; }
      input, button { width: 100%; padding: 10px; margin: 8px 0; border-radius: 6px; border: none; box-sizing: border-box; }
      button { background: #00a884; color: white; font-weight: bold; cursor: pointer; }
    </style></head><body>
    <div class="card" id="app">
      <h2>Admin Login</h2>
      <input type="password" id="pass" placeholder="Admin Password">
      <button onclick="login()">Login</button>
    </div>
    <script>
      async function login() {
        const res = await fetch('/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: document.getElementById('pass').value }) });
        if(res.ok) {
          document.getElementById('app').innerHTML = \`
            <h2>Admin Dashboard</h2>
            <button onclick="window.location='/admin/download/json'">Download JSON</button>
            <button onclick="window.location='/admin/download/pdf'">Download PDF</button>
          \`;
        } else alert('Wrong password');
      }
    </script></body></html>
  `);
});

// --- MAIN FRONTEND APP ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Lovers Chat</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #111b21; color: #e9edef; font-family: sans-serif; display: flex; flex-direction: column; height: 100vh; }
      .hidden { display: none !important; }
      .auth-card { background: #202c33; padding: 24px; border-radius: 12px; text-align: center; width: 90%; max-width: 350px; margin: auto; }
      .auth-card select, .auth-card input, .auth-card button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 8px; border: none; box-sizing: border-box; }
      .auth-card select, .auth-card input { background: #2a3942; color: white; }
      .auth-card button { background: #00a884; color: white; font-weight: bold; cursor: pointer; }
      .header { background: #202c33; padding: 10px; display: flex; align-items: center; gap: 8px; }
      .search-bar { background: #111b21; border: none; padding: 8px; border-radius: 8px; color: #fff; flex: 1; font-size: 14px; }
      .icon-btn { background: none; border: none; font-size: 18px; cursor: pointer; color: #00a884; }
      .chat-box { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; background: #0b141a; }
      .msg { max-width: 80%; padding: 8px 12px; border-radius: 8px; font-size: 15px; word-wrap: break-word; }
      .sent { background: #005c4b; align-self: flex-end; }
      .received { background: #202c33; align-self: flex-start; }
      .time { font-size: 10px; color: #8696a0; text-align: right; margin-top: 4px; }
      .input-area { background: #202c33; padding: 10px; display: flex; gap: 6px; align-items: center; }
      .input-area input[type="text"] { flex: 1; background: #2a3942; border: none; padding: 10px; border-radius: 8px; color: white; outline: none; }
      .input-area button { background: #00a884; border: none; padding: 10px 14px; border-radius: 8px; color: white; font-weight: bold; }
      audio, video { width: 100%; max-width: 250px; margin-top: 5px; border-radius: 6px; }
      #video-modal { display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.9); z-index:99; flex-direction:column; align-items:center; justify-content:center; }
      video.call-stream { width: 45%; max-height: 40vh; background: #000; border-radius: 8px; }
    </style></head><body>

      <!-- LOGIN SCREEN -->
      <div id="loginSection" class="auth-card">
        <h2>Lovers Login</h2>
        <select id="loginUser">
          <option value="${P1_NAME}">${P1_NAME}</option>
          <option value="${P2_NAME}">${P2_NAME}</option>
        </select>
        <input type="password" id="loginPass" placeholder="Password">
        <button onclick="doLogin()">Login</button>
      </div>

      <!-- CHAT INTERFACE -->
      <div id="chatSection" class="hidden" style="display:flex; flex-direction:column; height:100vh;">
        <div class="header">
          <input type="text" id="searchKey" class="search-bar" placeholder="Secret Key..." oninput="decryptAll()">
          <button class="icon-btn" onclick="startCall(false)">📞</button>
          <button class="icon-btn" onclick="startCall(true)">📹</button>
          <button class="icon-btn" onclick="doLogout()" style="color:#f15c6d;">🚪</button>
        </div>

        <div class="chat-box" id="chat"></div>

        <div class="input-area">
          <input type="file" id="fileInput" style="display:none" onchange="sendFile()">
          <button type="button" class="icon-btn" onclick="document.getElementById('fileInput').click()">📎</button>
          <button type="button" class="icon-btn" id="recBtn" onclick="toggleRecord()">🎙️</button>
          <input type="text" id="text" placeholder="Message">
          <button onclick="sendText()">Send</button>
        </div>
      </div>

      <!-- WEBRTC CALL MODAL -->
      <div id="video-modal">
        <h3 id="callStatus" style="color:white; margin-bottom:10px;">In Call...</h3>
        <div style="display:flex; gap:10px; width:100%; justify-content:center;">
          <video id="localVideo" class="call-stream" autoplay muted playsinline></video>
          <video id="remoteVideo" class="call-stream" autoplay playsinline></video>
        </div>
        <button onclick="endCall()" style="background:red; padding:10px 20px; border:none; border-radius:8px; color:white; margin-top:15px; font-weight:bold;">End Call</button>
      </div>

      <script>
        const socket = io();
        let currentUser = null, rawMessages = [], mediaRecorder, audioChunks = [], pc, localStream;
        const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

        function cipher(str, key) {
          if (!key) return "🔒 Encrypted Message";
          return str.split('').map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
        }

        async function checkAuth() {
          const res = await fetch('/api/me');
          const data = await res.json();
          if(data.authenticated) {
            currentUser = data.username;
            document.getElementById('loginSection').classList.add('hidden');
            document.getElementById('chatSection').classList.remove('hidden');
            socket.emit('join');
            fetchMessages();
          }
        }

        async function doLogin() {
          const username = document.getElementById('loginUser').value;
          const password = document.getElementById('loginPass').value;
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if(res.ok) {
            checkAuth();
          } else {
            alert(data.message || 'Login failed');
          }
        }

        async function doLogout() {
          await fetch('/api/logout', { method: 'POST' });
          location.reload();
        }

        async function fetchMessages() {
          const res = await fetch('/api/messages');
          if(res.ok) {
            rawMessages = await res.json();
            decryptAll();
          }
        }

        function decryptAll() {
          const key = document.getElementById('searchKey').value;
          const chat = document.getElementById('chat');
          chat.innerHTML = '';
          rawMessages.forEach(m => {
            const div = document.createElement('div');
            div.className = 'msg ' + (m.sender === currentUser ? 'sent' : 'received');
            
            let content = '';
            if (m.type === 'text') {
              content = cipher(m.encryptedText, key);
            } else if (m.type === 'audio') {
              const src = cipher(m.fileData, key);
              content = \`<audio controls src="\${src}"></audio>\`;
            } else if (m.type === 'file') {
              const src = cipher(m.fileData, key);
              content = \`<a href="\${src}" download="\${m.fileName}" style="color:#00a884;">📄 \${m.fileName}</a>\`;
            }

            div.innerHTML = \`<div><b>\${m.sender}</b>: \${content}</div><div class="time">\${m.timestamp}</div>\`;
            chat.appendChild(div);
          });
          chat.scrollTop = chat.scrollHeight;
        }

        async function postMessage(payload) {
          await fetch('/api/messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
          });
        }

        async function sendText() {
          const key = document.getElementById('searchKey').value;
          const text = document.getElementById('text').value;
          if(!key) return alert('Enter secret key in top bar!');
          if(!text) return;

          await postMessage({ encryptedText: cipher(text, key), type: 'text' });
          document.getElementById('text').value = '';
        }

        function sendFile() {
          const key = document.getElementById('searchKey').value;
          const file = document.getElementById('fileInput').files[0];
          if(!key) return alert('Enter secret key in top bar!');
          if(!file) return;

          const reader = new FileReader();
          reader.onload = async () => {
            const encryptedData = cipher(reader.result, key);
            await postMessage({ fileData: encryptedData, fileName: file.name, type: 'file' });
          };
          reader.readAsDataURL(file);
        }

        async function toggleRecord() {
          const key = document.getElementById('searchKey').value;
          const btn = document.getElementById('recBtn');
          if(!key) return alert('Enter secret key in top bar!');

          if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
            btn.style.color = '#00a884';
          } else {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
              const blob = new Blob(audioChunks, { type: 'audio/webm' });
              const reader = new FileReader();
              reader.onload = async () => {
                const encryptedData = cipher(reader.result, key);
                await postMessage({ fileData: encryptedData, type: 'audio' });
              };
              reader.readAsDataURL(blob);
            };
            mediaRecorder.start();
            btn.style.color = 'red';
          }
        }

        // --- WEBRTC CALLING ---
        async function startCall(video) {
          document.getElementById('video-modal').style.display = 'flex';
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video });
          document.getElementById('localVideo').srcObject = localStream;

          pc = new RTCPeerConnection(rtcConfig);
          localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

          pc.ontrack = e => document.getElementById('remoteVideo').srcObject = e.streams[0];
          pc.onicecandidate = e => {
            if(e.candidate) socket.emit('call_user', { signal: pc.localDescription, from: currentUser, video });
          };

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('call_user', { signal: offer, from: currentUser, video });
        }

        socket.on('incoming_call', async (data) => {
          if (confirm(\`Incoming \${data.video ? 'Video' : 'Audio'} call from \${data.from}. Accept?\`)) {
            document.getElementById('video-modal').style.display = 'flex';
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: data.video });
            document.getElementById('localVideo').srcObject = localStream;

            pc = new RTCPeerConnection(rtcConfig);
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

            pc.ontrack = e => document.getElementById('remoteVideo').srcObject = e.streams[0];
            pc.onicecandidate = e => {
              if(e.candidate) socket.emit('answer_call', { signal: pc.localDescription });
            };

            await pc.setRemoteDescription(new RTCSessionDescription(data.signal));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('answer_call', { signal: answer });
          }
        });

        socket.on('call_accepted', async (signal) => {
          if(pc) await pc.setRemoteDescription(new RTCSessionDescription(signal));
        });

        socket.on('call_ended', () => endCall(false));

        function endCall(notify = true) {
          if (notify) socket.emit('end_
