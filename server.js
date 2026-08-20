require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'lovers_secret_session',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const JSON_FILE_PATH = path.join(__dirname, 'database.json');
const MEGA_FILE_NAME = 'lovers_chat_db.json';

const P1_NAME = process.env.PARTNER_1_NAME || 'Partner A';
const P1_PASS = process.env.PARTNER_1_PASS || 'pass1234';
const P2_NAME = process.env.PARTNER_2_NAME || 'Partner B';
const P2_PASS = process.env.PARTNER_2_PASS || 'pass5678';
const CHAT_SECRET_KEY = process.env.CHAT_SECRET_KEY || 'default_shared_secret_key';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

async function getMegaStorage() {
  const email = process.env.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD;

  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password.trim()) {
    return null;
  }

  try {
    const { Storage } = require('megajs');
    const storage = new Storage({ email: email.trim(), password: password.trim() });
    await storage.ready;
    return storage;
  } catch (err) {
    return null;
  }
}

async function syncFromMega() {
  try {
    const storage = await getMegaStorage();
    if (storage) {
      const file = storage.root.children.find(f => f.name === MEGA_FILE_NAME);
      if (file) {
        const data = await file.downloadBuffer();
        fs.writeFileSync(JSON_FILE_PATH, data);
      }
    }
  } catch (err) {}

  if (!fs.existsSync(JSON_FILE_PATH)) {
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify({ users: [], messages: [] }));
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
    if (!storage) return;

    const file = storage.root.children.find(f => f.name === MEGA_FILE_NAME);
    if (file) await file.delete();
    
    const content = fs.readFileSync(JSON_FILE_PATH);
    await storage.upload(MEGA_FILE_NAME, content).complete;
  } catch (err) {}
}

function readData() {
  if (!fs.existsSync(JSON_FILE_PATH)) return { users: [], messages: [] };
  return JSON.parse(fs.readFileSync(JSON_FILE_PATH, 'utf-8'));
}

function checkUserAuth(req, res, next) {
  if (req.session && req.session.username) return next();
  res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

function checkAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).send('Unauthorized Admin Access');
}

// --- USER AUTH ROUTES ---
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
    const partner = req.session.username === P1_NAME ? P2_NAME : P1_NAME;
    return res.json({ 
      authenticated: true, 
      username: req.session.username,
      partnerName: partner,
      secretKey: CHAT_SECRET_KEY 
    });
  }
  res.json({ authenticated: false });
});

// --- RESTORED ADMIN ROUTES ---
app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ status: 'ok' });
  }
  res.status(401).json({ status: 'error', message: 'Invalid Admin Password' });
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

// --- CHAT MESSAGES ROUTES ---
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
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  data.messages.push(msg);
  fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(data, null, 2));
  await syncToMega();
  io.emit('new_message', msg);
  res.json(msg);
});

// --- WEBRTC SOCKET LOGIC ---
io.on('connection', (socket) => {
  socket.on('join', () => socket.join('lovers_room'));
  socket.on('call_user', (data) => socket.to('lovers_room').emit('incoming_call', data));
  socket.on('answer_call', (data) => socket.to('lovers_room').emit('call_accepted', data.signal));
  socket.on('end_call', () => socket.to('lovers_room').emit('call_ended'));
});

const PORT = process.env.PORT || 3000;
syncFromMega().then(() => {
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
