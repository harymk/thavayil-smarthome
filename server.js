require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// --- MongoDB Models ---
const User = mongoose.model('User', new mongoose.Schema({
  email: String,
  password: String,
}));

const Device = mongoose.model('Device', new mongoose.Schema({
  userId: String,
  deviceId: String,
  name: String,
  type: { type: String, default: 'light' },
  state: {
    on: { type: Boolean, default: false },
    online: { type: Boolean, default: true },
    brightness: { type: Number, default: 100 },
    fanSpeed: { type: String, default: 'low' }
  }
}));

const AuthCode = mongoose.model('AuthCode', new mongoose.Schema({
  code: String,
  userId: String,
  expires: Date
}));

const AccessToken = mongoose.model('AccessToken', new mongoose.Schema({
  token: String,
  userId: String,
  expires: Date
}));

// --- Connect MongoDB - FIXED to support both names ---
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
console.log('Using Mongo URI:', MONGO_URI ? 'Found' : 'NOT FOUND - Set MONGO_URI env var!');

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('Mongo Connected ✅'))
    .catch(err => console.log('Mongo Error:', err));
} else {
  console.log('ERROR: MONGO_URI not set!');
}

// --- FIX 1: Root route - Fixes Cannot GET / ---
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Thavayil SmartHome</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; text-align:center; padding:30px; background:#f5f5f5 }
        .card { background:white; max-width:500px; margin:0 auto; padding:30px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.1) }
        h1 { color:#4285f4 }
        a { display:inline-block; margin:8px; padding:10px 20px; background:#4285f4; color:white; text-decoration:none; border-radius:6px }
        .status { padding:12px; border-radius:8px; margin:15px 0 }
        .ok { background:#e6f4ea; color:#137333 }
        .bad { background:#fce8e6; color:#a50e0e }
      </style>
      </head>
      <body>
        <div class="card">
          <h1>Thavayil SmartHome API Running ✅</h1>
          <div class="status ${mongoose.connection.readyState === 1 ? 'ok' : 'bad'}">
            MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected ✅' : 'Disconnected ❌ - Check MONGO_URI env var'}
          </div>
          <p>Google Home & Alexa Smart Home Backend</p>
          <a href="/health">Health Check</a>
          <a href="/privacy">Privacy</a>
          <p style="margin-top:20px; font-size:12px; color:#666">
            Fulfillment: <code>/google/smarthome</code><br>
            OAuth: <code>/oauth/authorize</code> & <code>/oauth/token</code>
          </p>
        </div>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', time: new Date().toISOString() });
});

app.get('/privacy', (req, res) => res.send('Privacy Policy: We do not share your data. Contact: thavayil.ckm@gmail.com'));
app.get('/terms', (req, res) => res.send('Terms of Service: For smart home control only.'));
app.get('/support', (req, res) => res.send('Support: Email thavayil.ckm@gmail.com'));

// --- GOOGLE OAUTH ---
app.get('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  res.send(`
    <html><body style="font-family: sans-serif; text-align:center; padding:40px">
      <h2>Thavayil SmartHome - Link to Google</h2>
      <form method="POST" action="/oauth/authorize?client_id=${client_id}&redirect_uri=${redirect_uri}&state=${state}">
        <input type="email" name="email" placeholder="Your App Email" required style="padding:10px; width:250px"><br><br>
        <input type="password" name="password" placeholder="Password" required style="padding:10px; width:250px"><br><br>
        <button type="submit" style="padding:10px 30px; background:#4285f4; color:white; border:none; border-radius:6px">Link Account</button>
      </form>
    </body></html>
  `);
});

app.post('/oauth/authorize', async (req, res) => {
  const { email } = req.body;
  const { redirect_uri, state } = req.query;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).send('User not found. Please register on thavayil-smarthome.onrender.com first');
    const code = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    await AuthCode.create({ code, userId: user._id.toString(), expires: new Date(Date.now() + 10 * 60 * 1000) });
    res.redirect(`${redirect_uri}?code=${code}&state=${state}`);
  } catch (e) {
    res.status(500).send('Server error: ' + e.message);
  }
});

app.post('/oauth/token', async (req, res) => {
  const { code, grant_type, refresh_token } = req.body;
  if (grant_type === 'authorization_code') {
    const authCode = await AuthCode.findOne({ code });
    if (!authCode) return res.status(400).json({ error: 'invalid_code' });
    const token = jwt.sign({ userId: authCode.userId }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
    const refresh = jwt.sign({ userId: authCode.userId }, process.env.JWT_REFRESH_SECRET || 'refresh_secret');
    await AccessToken.create({ token, userId: authCode.userId, expires: new Date(Date.now() + 3600000) });
    await AuthCode.deleteOne({ code });
    return res.json({ access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 });
  }
  if (grant_type === 'refresh_token') {
    try {
      const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET || 'refresh_secret');
      const token = jwt.sign({ userId: decoded.userId }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
      await AccessToken.create({ token, userId: decoded.userId, expires: new Date(Date.now() + 3600000) });
      return res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    } catch (e) { return res.status(400).json({ error: 'invalid_grant' }); }
  }
  res.status(400).json({ error: 'unsupported_grant_type' });
});

// --- GOOGLE SMARTHOME FULFILLMENT - CERTIFICATION READY ---
app.post('/google/smarthome', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing auth' });
  const token = authHeader.split(' ')[1];
  let userId;
  try { 
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret'); 
    userId = decoded.userId; 
  } catch (e) { 
    return res.status(401).json({ error: 'Invalid token' }); 
  }

  const { requestId, inputs } = req.body;
  const intent = inputs[0].intent;
  const devices = await Device.find({ userId });

  if (intent === 'action.devices.SYNC') {
    const syncDevices = devices.map(d => {
      let type = 'action.devices.types.LIGHT';
      let traits = ['action.devices.traits.OnOff'];
      if (d.type === 'fan' || d.name.toLowerCase().includes('fan')) {
        type = 'action.devices.types.FAN';
        traits = ['action.devices.traits.OnOff', 'action.devices.traits.FanSpeed'];
      } else if (d.type === 'light') {
        type = 'action.devices.types.LIGHT';
        traits = ['action.devices.traits.OnOff', 'action.devices.traits.Brightness'];
      } else {
        type = 'action.devices.types.SWITCH';
        traits = ['action.devices.traits.OnOff'];
      }
      return {
        id: d.deviceId,
        type,
        traits,
        name: { defaultNames: [d.name], name: d.name, nicknames: [d.name] },
        willReportState: true,
        attributes: {
          availableFanSpeeds: {
            speeds: [
              { speed_name: 'low', speed_values: [{ speed_synonym: ['low','slow'], lang: 'en' }] },
              { speed_name: 'medium', speed_values: [{ speed_synonym: ['medium'], lang: 'en' }] },
              { speed_name: 'high', speed_values: [{ speed_synonym: ['high','fast'], lang: 'en' }] }
            ],
            ordered: true
          }
        },
        deviceInfo: { manufacturer: 'Thavayil Electronics', model: 'Thavayil SmartHome v1', hwVersion: '1.0', swVersion: '1.0' }
      };
    });
    return res.json({ requestId, payload: { agentUserId: userId, devices: syncDevices } });
  }

  if (intent === 'action.devices.QUERY') {
    const queriedDevices = inputs[0].payload.devices;
    const states = {};
    for (const q of queriedDevices) {
      const dev = devices.find(d => d.deviceId === q.id);
      if (dev) {
        states[q.id] = { online: true, on: dev.state.on || false, brightness: dev.state.brightness || 100, currentFanSpeedSetting: dev.state.fanSpeed || 'low' };
      } else {
        states[q.id] = { online: false };
      }
    }
    return res.json({ requestId, payload: { devices: states } });
  }

  if (intent === 'action.devices.EXECUTE') {
    const commands = inputs[0].payload.commands;
    const results = [];
    for (const cmd of commands) {
      for (const device of cmd.devices) {
        const dev = await Device.findOne({ userId, deviceId: device.id });
        if (!dev) continue;
        for (const execution of cmd.execution) {
          const { command, params } = execution;
          if (command === 'action.devices.commands.OnOff') dev.state.on = params.on;
          else if (command === 'action.devices.commands.BrightnessAbsolute') { dev.state.brightness = params.brightness; dev.state.on = true; }
          else if (command === 'action.devices.commands.SetFanSpeed') { dev.state.fanSpeed = params.fanSpeed; dev.state.on = true; }
        }
        await dev.save();
        results.push({ ids: [device.id], status: 'SUCCESS', states: { online: true, on: dev.state.on, brightness: dev.state.brightness, currentFanSpeedSetting: dev.state.fanSpeed } });
      }
    }
    return res.json({ requestId, payload: { commands: results } });
  }

  if (intent === 'action.devices.DISCONNECT') {
    return res.json({ requestId, payload: {} });
  }
  res.status(400).json({ error: 'Unknown intent' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
