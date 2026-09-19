
// server.js - Main entry - combines all modules
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {cors:{origin:'*'}});

const JWT_SECRET_NEW = 'thavayil-smarthome-secret-2024-fixed';
const JWT_SECRET_OLD = 'my-super-secret-123-change-this';
const MONGO_URL = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

console.log('Mongo URI found...', !!MONGO_URL);
mongoose.connect(MONGO_URL).then(()=>console.log('MongoDB Connected ✅')).catch(e=>console.log('Mongo error', e.message));

// --- Models ---
const UserSchema = new mongoose.Schema({ id: String, email: {type:String, unique:true, lowercase:true, trim:true}, password: String });
const CodeSchema = new mongoose.Schema({ code: String, userId: String, exp: Number });
const DeviceSchema = new mongoose.Schema({
  id: String, deviceId: String, userId: String, name: String, type: String,
  state: {type:String, default:'OFF'}, color: Object, brightness: Number, speed: Number, offline: Boolean, createdAt: String
}, {strict:false});
const OfflineSchema = new mongoose.Schema({ deviceId: {type:String, unique:true}, offline: Boolean, updatedAt: Date });

const User = mongoose.model('User', UserSchema);
const Code = mongoose.model('Code', CodeSchema);
const Device = mongoose.model('Device', DeviceSchema);
const OfflineState = mongoose.model('OfflineState', OfflineSchema);

global.offlineDevices = new Set();
global.qCount = {};
let alexaTokens = {};
let googleTokens = {};

function verifyToken(t){
  try{ return jwt.verify(t, JWT_SECRET_NEW); }
  catch(e){ return jwt.verify(t, JWT_SECRET_OLD); }
}

async function emitDevice(userId, dev){
  try{
    const userDevices = await Device.find({userId});
    io.to('user_'+userId).emit('device_updated', dev);
    io.to('user_'+userId).emit('devices_updated', userDevices);
  }catch(e){ console.log(e.message); }
}

io.on('connection', (socket)=>{
  const userId = socket.handshake.query.userId;
  if(userId){ socket.join('user_'+userId); console.log('Connected user:', userId); }
  socket.on('disconnect', ()=>{ console.log('Disconnected', userId); });
});

// --- Routes ---
const authModule = require('./routes/auth')(User, Code, JWT_SECRET_NEW, JWT_SECRET_OLD);
app.use('/', authModule.router);
const authMiddleware = authModule.authMiddleware;

require('./routes/google')(app, Device, OfflineState, verifyToken, googleTokens, global, emitDevice);
require('./routes/alexa')(app, Device, verifyToken, alexaTokens, emitDevice);
require('./routes/dashboard')(app, Device, authMiddleware, io);

// --- Test & Utility ---
app.get('/test/google-sync/:userId', async (req,res)=>{
  try{
    const userDevices=await Device.find({userId:req.params.userId});
    res.json({userId:req.params.userId, count:userDevices.length, devices:userDevices.map(d=>({id:d.id, name:d.name, type:d.type, brightness:d.brightness, color:d.color}))});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/test/offline/clear', async (req,res)=>{
  try{ await OfflineState.deleteMany({}); await Device.updateMany({}, {$set:{offline:false}}); }catch(e){}
  global.offlineDevices=new Set(); res.json({success:true, cleared:true});
});
app.get('/test/offline', async (req,res)=>{
  try{ const dbStates=await OfflineState.find({offline:true}); res.json({offlineDevices: dbStates.map(d=>d.deviceId)}); }catch(e){ res.json({offlineDevices: Array.from(global.offlineDevices)}); }
});
app.get('/test/version', (req,res)=> res.json({version:'V53_MODULAR_SEPARATE', ok:true, time:new Date().toISOString()}));
app.get('/privacy', (req,res)=> res.send('Privacy Policy - Thavayil SmartHome'));

const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=> console.log(`Thavayil SmartHome V53 MODULAR - Port ${PORT}`));
