const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET_NEW = 'thavayil-smarthome-secret-2024-fixed';
const JWT_SECRET_OLD = 'my-super-secret-123-change-this';
const DB_FILE = 'db.json';

let lastDBContent = '';
let lastEmitTime = 0;

function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[], codes:[], devices:[]}, null, 2));
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users) data.users = [];
    if (!data.codes) data.codes = [];
    if (!data.devices) data.devices = [];
    return data;
  } catch(e) { return {users:[], codes:[], devices:[]}; }
}
function writeDB(data) { 
  const str = JSON.stringify(data, null, 2);
  fs.writeFileSync(DB_FILE, str); 
  lastDBContent = str;
}

function hexToHsb(hex) {
  if (!hex) return { hue: 0, saturation: 1, brightness: 100 };
  hex = hex.replace('#','');
  const r = parseInt(hex.slice(0,2),16)/255, g = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max * 100;
  return { hue: Math.round(h), saturation: parseFloat(s.toFixed(2)), brightness: Math.round(v) };
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET_NEW); }
  catch(e) { try { return jwt.verify(token, JWT_SECRET_OLD); } catch(e2) { throw e2; } }
}

function emitToUser(userId) {
  const db = readDB();
  const devices = db.devices.filter(d => d.userId === userId);
  io.to('user_'+userId).emit('devices_updated', devices);
}

function emitAllUsersFromDB() {
  const now = Date.now();
  if (now - lastEmitTime < 500) return;
  lastEmitTime = now;
  try {
    const content = fs.readFileSync(DB_FILE, 'utf8');
    if (content === lastDBContent) return;
    lastDBContent = content;
    const db = JSON.parse(content);
    const userIds = [...new Set((db.devices||[]).map(d => d.userId).concat((db.users||[]).map(u => u.id)))];
    userIds.forEach(userId => {
      if (!userId) return;
      const devices = (db.devices||[]).filter(d => d.userId === userId);
      io.to('user_'+userId).emit('devices_updated', devices);
    });
  } catch(e) {}
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.post('/auth/register', (req, res) => {
  const db = readDB(); 
  const { email, password } = req.body;
  if (db.users.find(u => u.email === email)) return res.status(400).json({error: 'user exists'});
  const user = { id: Date.now().toString(), email, password };
  db.users.push(user); writeDB(db);
  const token = jwt.sign({ userId: user.id, email }, JWT_SECRET_NEW, { noTimestamp: true });
  res.json({ token, userId: user.id });
});

app.post('/auth/login', (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.email === req.body.email && u.password === req.body.password);
  if (!user) return res.status(401).json({error: 'invalid'});
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET_NEW, { noTimestamp: true });
  res.json({ token, userId: user.id });
});

app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  res.send(`<form method="POST" action="/oauth/authorize?redirect_uri=${redirect_uri}&state=${state}">Email: <input name="email"/><br/>Password: <input name="password" type="password"/><br/><button>Link</button></form>`);
});

app.post('/oauth/authorize', (req, res) => {
  const db = readDB(); 
  const user = db.users.find(u => u.email === req.body.email && u.password === req.body.password);
  if (!user) return res.send('Invalid');
  const code = Math.random().toString(36).substring(7);
  db.codes.push({ code, userId: user.id, exp: Date.now() + 600000 }); writeDB(db);
  res.redirect(`${req.query.redirect_uri}?code=${code}&state=${req.query.state}`);
});

app.post('/oauth/token', (req, res) => {
  const db = readDB(); 
  const entry = db.codes.find(c => c.code === req.body.code);
  if (!entry) return res.status(400).json({error: 'invalid'});
  const token = jwt.sign({ userId: entry.userId }, JWT_SECRET_NEW, { noTimestamp: true });
  res.json({ access_token: token, refresh_token: token, token_type: 'Bearer', expires_in: 31536000 });
});

function authMiddleware(req, res, next) {
  try { 
    const token = req.headers.authorization?.replace('Bearer ',''); 
    req.user = verifyToken(token);
    next(); 
  } catch(e) { res.status(401).json({error: 'unauth'}); }
}

app.get('/api/devices', authMiddleware, (req, res) => {
  const db = readDB(); 
  res.json(db.devices.filter(d => d.userId === req.user.userId));
});

app.post('/api/devices', authMiddleware, (req, res) => {
  const db = readDB(); 
  const { name, type, id, color, brightness, speed } = req.body;
  if (!name || !type) return res.status(400).json({error: 'name type required'});
  const deviceId = id || type.toLowerCase() + '_' + Date.now().toString().slice(-4);
  const upperType = type.toUpperCase();
  let displayCategory = upperType === 'LIGHT' ? 'LIGHT' : upperType === 'FAN' ? 'FAN' : 'SWITCH';
  let newDevice = { id: deviceId, deviceId, userId: req.user.userId, name, type: upperType, displayCategory, state: 'OFF', createdAt: new Date().toISOString() };
  if (upperType === 'LIGHT') {
    let hsb = { hue: 45, saturation: 1, brightness: 100 };
    if (color && typeof color === 'object') {
      if (color.hue !== undefined) hsb = { hue: parseInt(color.hue), saturation: parseFloat(color.saturation), brightness: parseInt(color.brightness||100) };
    } else if (typeof color === 'string' && color) {
      hsb = hexToHsb(color);
    }
    newDevice.color = hsb;
    newDevice.brightness = brightness !== undefined ? parseInt(brightness) : 80;
  } else if (upperType === 'FAN') newDevice.speed = speed ? parseInt(speed) : 3;
  db.devices.push(newDevice); writeDB(db);
  emitToUser(req.user.userId);
  res.json(newDevice);
});

app.delete('/api/devices/:id', authMiddleware, (req, res) => {
  const db = readDB(); 
  db.devices = db.devices.filter(d => !(d.id === req.params.id && d.userId === req.user.userId));
  writeDB(db); 
  emitToUser(req.user.userId);
  res.json({ success: true });
});

app.post('/api/device/control', authMiddleware, (req, res) => {
  const db = readDB(); 
  const { deviceId, action, color, brightness, speed } = req.body;
  
  let hsb = null;
  if (color && typeof color === 'object' && color.hue !== undefined) {
    hsb = { hue: parseInt(color.hue), saturation: parseFloat(color.saturation), brightness: parseInt(color.brightness||100) };
  }
  
  io.to('user_'+req.user.userId).emit('alexa_cmd', { deviceId, action, color: hsb, brightness, speed });
  
  let dev = db.devices.find(d => d.id === deviceId && d.userId === req.user.userId);
  if (dev) { 
    if(action === 'TurnOn') dev.state = 'ON';
    if(action === 'TurnOff') dev.state = 'OFF';
    if (hsb && dev.type === 'LIGHT') { 
      dev.color = hsb;
    }
    if (brightness !== undefined && dev.type === 'LIGHT') { 
      dev.brightness = parseInt(brightness);
    }
    if (speed !== undefined && dev.type === 'FAN') dev.speed = parseInt(speed);
    writeDB(db); 
  }
  emitToUser(req.user.userId);
  res.json({ success: true, device: dev });
});

io.use((socket, next) => { 
  try { 
    const token = socket.handshake.auth.token || socket.handshake.query.token; 
    const decoded = verifyToken(token);
    socket.userId = decoded.userId; 
    next(); 
  } catch(e) { next(new Error('auth failed')); } 
});

io.on('connection', (socket) => { 
  socket.join('user_'+socket.userId);
  const db = readDB();
  socket.emit('devices_updated', db.devices.filter(d => d.userId === socket.userId));
});

try { lastDBContent = fs.readFileSync(DB_FILE, 'utf8'); } catch(e) { lastDBContent = ''; }
fs.watchFile(DB_FILE, { interval: 500 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) emitAllUsersFromDB();
});

server.listen(3000, () => console.log('Thavayil SmartHome - http://localhost:3000'));
