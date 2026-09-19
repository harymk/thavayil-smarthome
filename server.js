const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET_NEW = 'thavayil-smarthome-secret-2024-fixed';
const JWT_SECRET_OLD = 'my-super-secret-123-change-this';

const MONGO_URL = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if(!MONGO_URL) console.log("WARNING: MONGODB_URI not set!");
else console.log("Mongo URI found...");

mongoose.connect(MONGO_URL).then(()=> console.log("MongoDB Connected ✅")).catch(e=> console.log("MongoDB Error:", e.message));
mongoose.connection.on('error', e=> console.log("Mongo Error:", e.message));
mongoose.connection.on('disconnected', ()=> console.log("Mongo Disconnected!"));

const UserSchema = new mongoose.Schema({ id: String, email: {type:String, unique:true, lowercase:true, trim:true}, password: String });
const CodeSchema = new mongoose.Schema({ code: String, userId: String, exp: Number });
const DeviceSchema = new mongoose.Schema({
  id: String,
  deviceId: String,
  userId: String,
  name: String,
  type: String,
  displayCategory: String,
  state: {type:String, default:'OFF'},
  color: Object,
  brightness: Number,
  speed: Number,
  createdAt: String
}, { strict: false });

const User = mongoose.model('User', UserSchema);
const Code = mongoose.model('Code', CodeSchema);
const Device = mongoose.model('Device', DeviceSchema);

const OfflineSchema = new mongoose.Schema({
  deviceId: {type:String, unique:true},
  offline: {type:Boolean, default:false},
  updatedAt: {type:Date, default: Date.now}
}, {strict:false});
const OfflineState = mongoose.model('OfflineState', OfflineSchema);


function verifyToken(t){
  try{ return jwt.verify(t, JWT_SECRET_NEW); }
  catch(e){ return jwt.verify(t, JWT_SECRET_OLD); }
}

let alexaTokens = {};
let googleTokens = {};
let lastReportedState = {};

async function getUserDevices(userId){ try{ return await Device.find({ userId }); }catch(e){ return []; } }

async function emitDevice(userId, dev){
  try{
    const userDevices = await getUserDevices(userId);
    io.to('user_'+userId).emit('device_updated', dev);
    io.to('user_'+userId).emit('devices_updated_single', dev);
    io.to('user_'+userId).emit('devices_updated', userDevices);
    sendAlexaChangeReport(userId, dev);
    sendGoogleReportState(userId, dev);
  }catch(e){ console.log(e.message); }
}

async function sendAlexaChangeReport(userId, dev){
  try{
    const token = alexaTokens[userId]; if(!token) return;
    const https = require('https');
    let properties = [];
    properties.push({namespace:'Alexa.PowerController',name:'powerState',value:dev.state==='ON'?'ON':'OFF',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    if(dev.type==='LIGHT' && dev.brightness!==undefined) properties.push({namespace:'Alexa.BrightnessController',name:'brightness',value:dev.brightness,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    if(dev.type==='LIGHT' && dev.color) properties.push({namespace:'Alexa.ColorController',name:'color',value:{hue:dev.color.hue,saturation:dev.color.saturation,brightness:dev.color.brightness/100},timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    if(dev.type==='FAN' && dev.speed) properties.push({namespace:'Alexa.PercentageController',name:'percentage',value:dev.speed*20,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    const event = { context:{properties}, event:{ header:{namespace:'Alexa',name:'ChangeReport',payloadVersion:'3',messageId:Date.now().toString()}, endpoint:{endpointId:dev.id,scope:{type:'BearerToken',token}}, payload:{change:{cause:{type:'APP_INTERACTION'},properties}} } };
    const data = JSON.stringify(event);
    ['api.amazonalexa.com','api.eu.amazonalexa.com'].forEach(hostname=>{
      const req = https.request({hostname,path:'/v3/events',method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'Content-Length':Buffer.byteLength(data)}}, res=>{ let b=''; res.on('data',d=>b+=d); res.on('end',()=>console.log(`Alexa report ${dev.id} ${res.statusCode}`)); });
      req.on('error',e=>console.log(e.message)); req.write(data); req.end();
    });
  }catch(e){}
}


async function sendGoogleReportState(userId, dev){
  try{
    if(!lastReportedState[userId]) lastReportedState[userId] = {};
    // V17: If _forceOnline is set, use it directly - this is the relay logic you want
    let isOnline;
    if(dev._forceOnline !== undefined){
      isOnline = dev._forceOnline;
      console.log(`V17 FORCE RELAY device ${dev.id} -> online:${isOnline} (if online true, if offline false)`);
    } else {
      // Fallback: check OfflineState collection
      try{
        const off = await OfflineState.findOne({deviceId: dev.id});
        isOnline = !(off && off.offline);
      }catch(e){ isOnline = true; }
      console.log(`V17 AUTO RELAY device ${dev.id} -> online:${isOnline}`);
    }
    let state = { online: isOnline, on: dev.state==='ON' };
    if(dev.type==='FAN'){
      const map = {1:'low',2:'low',3:'medium',4:'high',5:'high'};
      state.currentFanSpeedSetting = map[dev.speed] || 'medium';
    }
        if(dev.type==='LIGHT'){
      if(dev.brightness!==undefined) state.brightness = dev.brightness;
      let h=0,s=0,v=1;
      if(dev.color){
        if(dev.color.hue!==undefined) h=dev.color.hue;
        if(dev.color.saturation!==undefined){ s=dev.color.saturation; if(s>1) s=s/100; }
        if(dev.color.brightness!==undefined) v=dev.color.brightness/100;
      }
      state.color = { spectrumHsv:{ hue:Math.round(h)%360, saturation:Math.max(0,Math.min(1,s)), value:Math.max(0,Math.min(1,v)) } };
    }
    lastReportedState[userId][dev.id] = {...state, ts: Date.now() };
    console.log(`ReportState (local) ${dev.id} ->`, JSON.stringify(state));

    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
    if(!saJson){
      console.log('V17 NO GOOGLE_SERVICE_ACCOUNT env var - cannot send to Google!');
      return;
    }
    try{
      const { JWT } = require('google-auth-library');
      const sa = JSON.parse(saJson);
      const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/homegraph'] });
      const tokens = await client.authorize();
      const https = require('https');
      const body = JSON.stringify({ requestId: 'thavayil-'+Date.now(), agentUserId: userId, payload: { devices: { states: { [dev.id]: state } } } });
      const req = https.request({ hostname: 'homegraph.googleapis.com', path: '/v1/devices:reportStateAndNotification', method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${tokens.access_token}` } }, res=>{ 
        let data=''; res.on('data', d=>data+=d); res.on('end',()=>console.log(`HomeGraph Report ${dev.id} online:${isOnline} ${res.statusCode} ${data.slice(0,200)}`));
      });
      req.on('error', e=>console.log('HomeGraph error', e.message));
      req.write(body); req.end();
    }catch(e){ console.log('HomeGraph auth error', e.message); }
  }catch(e){ console.log('ReportState error', e.message); }
}

async function forceReportOnline(deviceId, isOnline){
  try{
    const dev = await Device.findOne({id:deviceId}) || await Device.findOne({deviceId:deviceId});
    if(!dev){ console.log('V17 forceReport no dev', deviceId); return; }
    dev._forceOnline = isOnline;
    console.log(`V17 FORCE CALL device ${deviceId} online=${isOnline} -> will relay online:${isOnline}`);
    await sendGoogleReportState(dev.userId, dev);
  }catch(e){ console.log('V17 forceReport error', e.message); }
}

app.get('/test/report', async (req,res)=>{
  try{
    const id = req.query.id || '6328761164';
    const online = req.query.online !== 'false';
    await forceReportOnline(id, online);
    res.json({success:true, device:id, online:online, message: `Relayed online:${online}`});
  }catch(e){ res.status(500).json({error:e.message}); }
});


app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

app.get('/privacy',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px;font-family:sans-serif"><h1>Privacy Policy - Thavayil SmartHome</h1><p>We collect email and device states for smart home control. Contact: thavayil.ckm@gmail.com</p></div>`); });
app.get('/terms',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px"><h1>Terms</h1><p>Thavayil SmartHome</p></div>`); });
app.get('/support',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px"><h1>Support - thavayil.ckm@gmail.com</h1></div>`); });
app.get('/health',(req,res)=>{ res.json({status:'ok', mongo: mongoose.connection.readyState, mongoLabel: ['disconnected','connected','connecting','disconnecting'][mongoose.connection.readyState], time: new Date().toISOString()}); });
app.get('/debug', async (req,res)=>{
  res.json({
    mongo_state: mongoose.connection.readyState,
    MONGO_URL_exists: !!MONGO_URL,
    user_count: await User.countDocuments().catch(e=>e.message),
  });
});

app.post('/auth/register', async (req,res)=>{
  try{
    const email = (req.body.email||'').toLowerCase().trim();
    const password = (req.body.password||'').trim();
    if(!email||!password) return res.status(400).json({error:'email and password required'});
    const existing = await User.findOne({email});
    if(existing) return res.status(400).json({error:'user exists, please login'});
    const user={id:Date.now().toString(), email, password};
    const created = await User.create(user);
    const token=jwt.sign({userId:created.id,email}, JWT_SECRET_NEW, {noTimestamp:true});
    res.json({token,userId:created.id});
  }catch(e){ console.error("REGISTER ERROR", e); res.status(500).json({error: e.message}); }
});

app.post('/auth/login', async (req,res)=>{
  try{
    const email = (req.body.email||'').toLowerCase().trim();
    const password = (req.body.password||'').trim();
    if(!email||!password) return res.status(400).json({error:'email and password required'});
    const user = await User.findOne({email});
    if(!user) return res.status(401).json({error:'user not found - register first. Checked email: '+email});
    if(user.password !== password) return res.status(401).json({error:'wrong password'});
    const token=jwt.sign({userId:user.id,email:user.email}, JWT_SECRET_NEW, {noTimestamp:true});
    res.json({token,userId:user.id});
  }catch(e){ console.error("LOGIN ERROR", e); res.status(500).json({error: e.message}); }
});

app.get('/oauth/authorize',(req,res)=>{
  const {redirect_uri,state,client_id}=req.query;
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#08080c;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#14141e;padding:28px;border-radius:24px;width:360px}input{width:100%;padding:14px;margin:8px 0;border-radius:12px;border:1px solid #333;background:#0d0d13;color:#fff;box-sizing:border-box}button{width:100%;padding:14px;background:#fff;color:#000;border:0;border-radius:12px;font-weight:700;margin-top:12px;cursor:pointer}</style></head><body><div class="card"><h2>Thavayil SmartHome</h2><p style="color:#999;font-size:13px">Link your account to ${client_id?.includes('google')?'Google Home':'Alexa'}</p><form method="POST" action="/oauth/authorize?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}"><input name="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button type="submit">Link Account</button></form></div></body></html>`);
});
app.post('/oauth/authorize', async (req,res)=>{
  try{
    const email = req.body.email.toLowerCase().trim();
    const user=await User.findOne({email, password:req.body.password}) || await User.findOne({email:req.body.email, password:req.body.password});
    if(!user) return res.send('Invalid credentials <a href="javascript:history.back()">Back</a>');
    const code=Math.random().toString(36).substring(10);
    await Code.create({code,userId:user.id,exp:Date.now()+600000});
    res.redirect(`${req.query.redirect_uri}?code=${code}&state=${req.query.state}`);
  }catch(e){ res.send('Error: '+e.message); }
});
app.post('/oauth/token', async (req,res)=>{
  try{
    console.log('OAUTH TOKEN REQ:', req.body.grant_type, 'code?', !!req.body.code, 'refresh?', !!req.body.refresh_token);
    let userId = null;
    if(req.body.code){
      const entry=await Code.findOne({code:req.body.code});
      if(entry) userId = entry.userId;
    }
    if(!userId && req.body.refresh_token){
      try{ const dec = require('jsonwebtoken').verify(req.body.refresh_token, JWT_SECRET_NEW); userId = dec.userId; }catch(e){ try{ userId = require('jsonwebtoken').decode(req.body.refresh_token)?.userId; }catch(e2){} }
    }
    if(!userId) return res.status(400).json({error:'invalid_grant'});
    const token=require('jsonwebtoken').sign({userId:userId}, JWT_SECRET_NEW, {noTimestamp:true});
    console.log('OAUTH TOKEN OK for', userId);
    res.json({access_token:token, refresh_token:token, token_type:'Bearer', expires_in:31536000});
  }catch(e){ console.log('TOKEN ERROR', e.message); res.status(500).json({error:e.message}); }
});

function authMiddleware(req,res,next){
  try{
    const token=req.headers.authorization?.replace('Bearer ','');
    if(!token) throw new Error('no token');
    req.user=verifyToken(token); next();
  }catch(e){ res.status(401).json({error:'unauth - login again'}); }
}

app.get('/api/devices', authMiddleware, async (req,res)=>{
  try{ const devs=await Device.find({userId:req.user.userId}); res.json(devs); }catch(e){ res.status(500).json({error:e.message}); }
});
function gen10DigitId(){ return Math.floor(1000000000 + Math.random()*9000000000).toString(); }

app.post('/api/devices', authMiddleware, async (req,res)=>{
  try{
    const {name,type,id,color,brightness,speed}=req.body;
    if(!name||!type) return res.status(400).json({error:'name type required'});
    let deviceId = id && /^\d{10}$/.test(id)? id : gen10DigitId();
    let exists = await Device.findOne({id: deviceId, userId: req.user.userId});
    while(exists){ deviceId = gen10DigitId(); exists = await Device.findOne({id: deviceId, userId: req.user.userId}); }
    const upper=type.toUpperCase(); let cat=upper==='LIGHT'?'LIGHT':upper==='FAN'?'FAN':'SWITCH';
    let dev={id:deviceId,deviceId,userId:req.user.userId,name,type:upper,displayCategory:cat,state:'OFF',createdAt:new Date().toISOString()};
    if(upper==='LIGHT'){ let hsb={hue:45,saturation:1,brightness:100}; if(color&&typeof color==='object'&&color.hue!==undefined) hsb=color; if(brightness) hsb.brightness=parseInt(brightness); dev.color=hsb; dev.brightness=hsb.brightness; }
    else if(upper==='FAN'){ dev.speed=speed?parseInt(speed):3; }
    const created = await Device.create(dev);
    await emitDevice(req.user.userId, created);
    res.json(created);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.patch('/api/devices/:id/rename', authMiddleware, async (req,res)=>{
  try{
    const {name}=req.body;
    if(!name || name.trim().length<2) return res.status(400).json({error:'valid name required'});
    let dev = await Device.findOne({id:req.params.id, userId:req.user.userId});
    if(!dev) return res.status(404).json({error:'device not found'});
    dev.name = name.trim();
    await dev.save();
    await emitDevice(req.user.userId, dev);
    res.json({success:true, device:dev});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/devices/:id', authMiddleware, async (req,res)=>{
  try{ await Device.deleteOne({id:req.params.id, userId:req.user.userId}); io.to('user_'+req.user.userId).emit('device_deleted',{id:req.params.id}); res.json({success:true}); }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/device/control', authMiddleware, async (req,res)=>{
  try{
    const {deviceId,action,color,brightness,speed}=req.body;
    let dev=await Device.findOne({id:deviceId, userId:req.user.userId}) || await Device.findOne({deviceId, userId:req.user.userId});
    if(dev){
      if(action==='TurnOn') dev.state='ON';
      if(action==='TurnOff') dev.state='OFF';
      if(color&&dev.type==='LIGHT'){ dev.color=color; dev.brightness=color.brightness||dev.brightness; }
      if(brightness!==undefined&&dev.type==='LIGHT'){ if(!dev.color) dev.color={hue:45,saturation:1,brightness:100}; dev.color.brightness=parseInt(brightness); dev.brightness=parseInt(brightness); dev.state='ON'; }
      if(speed!==undefined&&dev.type==='FAN'){ dev.speed=parseInt(speed); dev.state='ON'; }
      await dev.save(); await emitDevice(req.user.userId, dev);
      io.to('user_'+req.user.userId).emit('alexa_cmd',{deviceId,action:action||'TurnOn',color,brightness,speed});
    }
    res.json({success:true,device:dev});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/alexa/smarthome', async (req,res)=>{
  try{
    const auth=req.headers.authorization; if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let decoded; try{ decoded=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
    const userId=decoded.userId;
    const directive=req.body.directive; if(!directive) return res.status(400).json({error:'no directive'});
    const header=directive.header; const ns=header.namespace; const name=header.name;
    try{ let alexaToken = directive.payload?.scope?.token || directive.endpoint?.scope?.token || token; if(alexaToken) alexaTokens[userId]=alexaToken; }catch(e){}
    if(ns==='Alexa.Authorization' && name==='AcceptGrant') return res.json({event:{header:{namespace:'Alexa.Authorization',name:'AcceptGrant.Response',payloadVersion:'3',messageId:header.messageId},payload:{}}});
    if(ns==='Alexa.Discovery' && name==='Discover'){
      const userDevices=await Device.find({userId});
      const endpoints=userDevices.map(d=>{
        let caps=[{type:'AlexaInterface',interface:'Alexa',version:'3'},{type:'AlexaInterface',interface:'Alexa.PowerController',version:'3',properties:{supported:[{name:'powerState'}],proactivelyReported:true,retrievable:true}}];
        if(d.type==='LIGHT'){ caps.push({type:'AlexaInterface',interface:'Alexa.BrightnessController',version:'3',properties:{supported:[{name:'brightness'}],proactivelyReported:true,retrievable:true}}); caps.push({type:'AlexaInterface',interface:'Alexa.ColorController',version:'3',properties:{supported:[{name:'color'}],proactivelyReported:true,retrievable:true}}); }
        if(d.type==='FAN') caps.push({type:'AlexaInterface',interface:'Alexa.PercentageController',version:'3',properties:{supported:[{name:'percentage'}],proactivelyReported:true,retrievable:true}});
        return { endpointId:d.id, manufacturerName:'Thavayil Electronics', friendlyName:d.name, description:`${d.type} via Thavayil SmartHome`, displayCategories:[d.displayCategory||'SWITCH'], capabilities:caps };
      });
      return res.json({event:{header:{namespace:'Alexa.Discovery',name:'Discover.Response',payloadVersion:'3',messageId:header.messageId},payload:{endpoints}}});
    }
    if(ns==='Alexa.PowerController'){
      const endpointId=directive.endpoint.endpointId; const action=name==='TurnOn'?'TurnOn':'TurnOff';
      let dev=await Device.findOne({id:endpointId, userId}); if(dev){ dev.state=action==='TurnOn'?'ON':'OFF'; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action}); }
      return res.json({event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},context:{properties:[{namespace:'Alexa.PowerController',name:'powerState',value:action==='TurnOn'?'ON':'OFF',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}});
    }
    if(ns==='Alexa.BrightnessController'){
      const endpointId=directive.endpoint.endpointId; let dev=await Device.findOne({id:endpointId, userId}); let brightness=directive.payload.brightness;
      if(name==='AdjustBrightness' && dev) brightness=Math.min(100,Math.max(1,(dev.brightness||50)+(directive.payload.brightnessDelta||0)));
      if(dev){ dev.state='ON'; dev.brightness=brightness; if(!dev.color) dev.color={hue:45,saturation:1,brightness:100}; dev.color.brightness=brightness; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action:'SetBrightness',brightness}); }
      return res.json({event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},context:{properties:[{namespace:'Alexa.PowerController',name:'powerState',value:'ON',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500},{namespace:'Alexa.BrightnessController',name:'brightness',value:brightness,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}});
    }
    if(ns==='Alexa.ColorController' && name==='SetColor'){
      const endpointId=directive.endpoint.endpointId; const color=directive.payload.color; let h=Math.round(color.hue); let s=parseFloat(color.saturation); let b=Math.round((color.brightness||1)*100);
      let dev=await Device.findOne({id:endpointId, userId}); if(dev){ dev.state='ON'; dev.color={hue:h,saturation:s,brightness:b}; dev.brightness=b; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action:'SetColor',color:{hue:h,saturation:s,brightness:b}}); }
      return res.json({event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},context:{properties:[{namespace:'Alexa.ColorController',name:'color',value:{hue:h,saturation:s,brightness:color.brightness},timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}});
    }
    if(ns==='Alexa.PercentageController'){
      const endpointId=directive.endpoint.endpointId; const perc=directive.payload.percentage; let speed=Math.ceil(perc/20); if(speed<1)speed=1; if(speed>5)speed=5;
      let dev=await Device.findOne({id:endpointId, userId}); if(dev){ dev.state='ON'; dev.speed=speed; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action:'SetSpeed',speed}); }
      return res.json({event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},context:{properties:[{namespace:'Alexa.PercentageController',name:'percentage',value:perc,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}});
    }
    if(ns==='Alexa' && name==='ReportState'){
      const endpointId=directive.endpoint.endpointId; let dev=await Device.findOne({id:endpointId, userId}); if(!dev) dev=await Device.findOne({id:endpointId}); let props=[];
      if(dev){ props.push({namespace:'Alexa.PowerController',name:'powerState',value:dev.state==='ON'?'ON':'OFF',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}); if(dev.brightness!==undefined) props.push({namespace:'Alexa.BrightnessController',name:'brightness',value:parseInt(dev.brightness),timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}); if(dev.color) props.push({namespace:'Alexa.ColorController',name:'color',value:{hue:dev.color.hue||0,saturation:dev.color.saturation||0,brightness:(dev.color.brightness||100)/100},timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}); if(dev.speed!==undefined) props.push({namespace:'Alexa.PercentageController',name:'percentage',value:(dev.speed||3)*20,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}); }
      return res.json({context:{properties:props},event:{header:{namespace:'Alexa',name:'StateReport',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}}});
    }
    res.status(400).json({error:'unsupported'});
  }catch(e){ console.error('ALEXA ERROR',e); res.status(500).json({error:e.message}); }
});

function googleDeviceTraits(d){
  if(d.type==='FAN') return ['action.devices.traits.OnOff','action.devices.traits.FanSpeed'];
  if(d.type==='LIGHT') return ['action.devices.traits.OnOff','action.devices.traits.Brightness','action.devices.traits.ColorSetting'];
  return ['action.devices.traits.OnOff'];
}
function googleDeviceType(d){
  if(d.type==='LIGHT') return 'action.devices.types.LIGHT';
  if(d.type==='FAN') return 'action.devices.types.FAN';
  return 'action.devices.types.SWITCH';
}

app.post('/google/smarthome', async (req,res)=>{
  try{
    const auth=req.headers.authorization; if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let decoded; try{ decoded=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
    const userId=decoded.userId;
    googleTokens[userId]=token;
    const requestId = req.body.requestId;
    const intent = req.body.inputs?.[0]?.intent;
    console.log(`GOOGLE ${intent} for user ${userId}`);

    if(intent==='action.devices.SYNC'){
      const userDevices=await Device.find({userId});
      const devices=userDevices.map(d=>{
        let traits = googleDeviceTraits(d);
        let attributes = {};
        if(d.type==='LIGHT'){ attributes.colorModel='hsv'; }
        if(d.type==='FAN'){
          attributes.availableFanSpeeds={
            speeds:[
              {speed_name:'low', speed_values:[{speed_synonym:['low','1','slow'], lang:'en'}]},
              {speed_name:'medium', speed_values:[{speed_synonym:['medium','2','3','mid'], lang:'en'}]},
              {speed_name:'high', speed_values:[{speed_synonym:['high','4','5','max'], lang:'en'}]}
            ], ordered:true
          };
          attributes.reversible=false;
        }
        return {
          id:d.id,
          type: googleDeviceType(d),
          traits,
          name:{defaultNames:[d.id], name:d.name, nicknames:[d.name]},
          willReportState: false,
          attributes,
          deviceInfo:{manufacturer:'Thavayil Electronics', model:'Thavayil SmartHome v1', hwVersion:'1.0', swVersion:'1.0'}
        };
      });
      return res.json({requestId, payload:{agentUserId:userId, devices}});
    }

                    console.log('V17 QUERY intent user', userId);
    if(intent==='action.devices.QUERY'){
      const payloadDevices = req.body.inputs[0].payload.devices;
      const userDevices=await Device.find({userId});
      let devicesState = {};
      let dbOfflineIds = [];
      try{
        const offStates = await OfflineState.find({offline:true});
        dbOfflineIds = offStates.map(s=>s.deviceId);
      }catch(e){ console.log('query offline fetch error', e.message); }
      for(const q of payloadDevices){
        const d = userDevices.find(x=>x.id===q.id || x.deviceId===q.id);
        let isOffline = false;
        if(dbOfflineIds.includes(q.id)) isOffline=true;
        if(global.offlineDevices.has(q.id)) isOffline=true;
        if(d && d.offline===true) isOffline=true;
        let online = !isOffline;
        if(!d){
          devicesState[q.id]={online:online, on:false, status:'SUCCESS'};
          continue;
        }
        let state = {online:online, on: d.state==='ON', status:'SUCCESS'};
        if(d.type==='FAN'){
          const map = {1:'low',2:'low',3:'medium',4:'high',5:'high'};
          state.currentFanSpeedSetting = map[d.speed] || 'medium';
        }
        if(d.type==='LIGHT'){
          const bri = (d.brightness!==undefined)? d.brightness : 80;
          const col = d.color || {hue:45, saturation:1, brightness: bri};
          state.brightness = bri;
          state.color = { spectrumHsv:{ hue: col.hue||45, saturation: (col.saturation!==undefined?col.saturation:1), value: ((col.brightness||bri)/100) } };
        }
        devicesState[q.id]=state;
      }
      console.log('QUERY V12', JSON.stringify({dbOffline: dbOfflineIds, memory:Array.from(global.offlineDevices)}));
      return res.json({requestId, payload:{devices:devicesState}});
    }

    if(intent==='action.devices.EXECUTE'){
      const commands = req.body.inputs[0].payload.commands;
      let results = [];
      for(const cmd of commands){
        for(const devReq of cmd.devices){
          const id = devReq.id;
          let dev=await Device.findOne({id, userId}) || await Device.findOne({deviceId:id, userId});
          if(!dev) { results.push({ids:[id], status:'ERROR', errorCode:'deviceNotFound'}); continue; }
          let newState = {online:true};
          for(const ex of cmd.execution){
            const params = ex.params;
            if(ex.command==='action.devices.commands.OnOff'){
              dev.state = params.on? 'ON' : 'OFF';
              newState.on = params.on;
              if(dev.type==='FAN'){
                if(params.on && !dev.speed) dev.speed = 3;
                const map = {1:'low',2:'low',3:'medium',4:'high',5:'high'};
                newState.currentFanSpeedSetting = map[dev.speed] || 'medium';
              }
              if(dev.type==='LIGHT' && dev.brightness!==undefined) newState.brightness = dev.brightness;
            }
            if(ex.command==='action.devices.commands.SetFanSpeed'){
              const mapStr = {low:1, medium:3, high:5};
              let num = mapStr[params.fanSpeed.toLowerCase()] || 3;
              dev.speed = num;
              dev.state = 'ON';
              newState.on = true;
              newState.currentFanSpeedSetting = params.fanSpeed.toLowerCase();
            }
            if(ex.command==='action.devices.commands.BrightnessAbsolute'){
              dev.brightness = params.brightness;
              if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
              dev.color.brightness = params.brightness;
              dev.state='ON';
              newState.on = true;
              newState.brightness = params.brightness;
            }
            if(ex.command==='action.devices.commands.ColorAbsolute' && params.color?.spectrumHSV){
              const hsv=params.color.spectrumHSV;
              dev.color={hue:Math.round(hsv.hue), saturation:parseFloat(hsv.saturation), brightness:Math.round(hsv.value*100)};
              dev.brightness=dev.color.brightness;
              dev.state='ON';
              newState.on = true;
              newState.color = {spectrumHsv:{hue:dev.color.hue, saturation:dev.color.saturation, value:hsv.value}};
            }
          }
          await dev.save();
          await emitDevice(userId, dev);
          io.to('user_'+userId).emit('alexa_cmd',{deviceId:id, action: newState.on?'TurnOn':'TurnOff'});
          results.push({ids:[id], status:'SUCCESS', states:newState});
        }
      }
      return res.json({requestId, payload:{commands: results}});
    }

    if(intent==='action.devices.DISCONNECT'){ return res.json({requestId, payload:{}}); }
    res.status(400).json({error:'unsupported intent '+intent});
  }catch(e){ console.error('GOOGLE ERROR',e); res.status(500).json({error:e.message}); }
});

io.use((socket,next)=>{
  try{
    const token=socket.handshake.auth?.token || socket.handshake.query?.token;
    if(!token) throw new Error('no token');
    const dec=verifyToken(token);
    socket.userId=dec.userId; next();
  }catch(e){ next(new Error('auth failed')); }
});
io.on('connection', async (socket)=>{
  console.log('Connected user:',socket.userId);
  socket.join('user_'+socket.userId);
  try{ const userDevs=await Device.find({userId:socket.userId}); socket.emit('devices_updated', userDevs); }catch(e){}
  socket.on('disconnect',()=>console.log('Disconnected',socket.userId));
});

const PORT=process.env.PORT||10000;



app.get('/test/report-both', async (req,res)=>{
  try{
    const id=req.query.id||'1875336409';
    const userId='1789741458155';
    const dev=await Device.findOne({id:id});
    if(!dev) return res.status(404).json({error:'not found'});
    // Force ON
    dev.state='ON';
    dev.brightness=100;
    await dev.save();
    await sendGoogleReportState(userId, dev);
    // Also try Alexa
    try{ await sendAlexaReportState(userId, dev); }catch(e){ console.log('Alexa report failed', e.message); }
    res.json({ok:true, sent: {id, state: dev.state}});
  }catch(e){ res.status(500).json({error:e.message}); }
});


// V37 OVERRIDE: Force ALL fulfillment paths to use fixed handler with online:true
app.post('/google/smarthome', async (req,res)=>{
  // Reuse handleGoogleSmarthome logic inline to ensure latest
  try{
    const auth=req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let decoded; try{ decoded=require('jsonwebtoken').verify(token, JWT_SECRET_NEW); }catch(e){ try{ decoded=require('jsonwebtoken').verify(token, JWT_SECRET_OLD); }catch(e2){ decoded=require('jsonwebtoken').decode(token); } }
    const userId = decoded?.userId || token;
    const requestId = req.body.requestId;
    const input = req.body.inputs?.[0];
    const intent = input?.intent;
    console.log(`=== GOOGLE V37 ${intent} user ${userId} ===`);

    if(intent==='action.devices.SYNC'){
      const userDevices=await Device.find({userId});
      console.log('V37 SYNC found', userDevices.length);
      const devices=userDevices.map(d=>{
        let traits=[]; let type='action.devices.types.SWITCH'; let attrs={};
        if(d.type==='LIGHT'){ traits=['action.devices.traits.OnOff','action.devices.traits.Brightness','action.devices.traits.ColorSetting']; type='action.devices.types.LIGHT'; attrs={colorModel:'hsv', colorTemperatureRange:{temperatureMinK:2000, temperatureMaxK:9000}}; }
        else if(d.type==='FAN'){ traits=['action.devices.traits.OnOff','action.devices.traits.FanSpeed']; type='action.devices.types.FAN'; attrs={availableFanSpeeds:{speeds:[{speed_name:'low',speed_values:[{speed_synonym:['low'],lang:'en'}]},{speed_name:'medium',speed_values:[{speed_synonym:['medium'],lang:'en'}]},{speed_name:'high',speed_values:[{speed_synonym:['high'],lang:'en'}]}],ordered:true}}; }
        else traits=['action.devices.traits.OnOff'];
        return {id:d.id, type, traits, name:{name:d.name||d.id, defaultNames:[d.name||d.id], nicknames:[d.name||d.id]}, willReportState:true, attributes:attrs, deviceInfo:{manufacturer:'Thavayil', model:'v1', hwVersion:'1', swVersion:'1'}};
      });
      return res.json({requestId, payload:{agentUserId:userId, devices}});
    }
    if(intent==='action.devices.QUERY'){
      const devicesState={};
      const userDevices=await Device.find({userId});
      for(let d of userDevices){
        let state={online:true, status:'SUCCESS', on: d.state==='ON'};
        if(d.type==='LIGHT'){
          const bri=d.brightness!==undefined?d.brightness:100;
          let h=0,s=0,v=1;
          if(d.color){ if(d.color.hue!==undefined) h=d.color.hue; if(d.color.saturation!==undefined){ s=d.color.saturation; if(s>1) s=s/100; } if(d.color.brightness!==undefined) v=d.color.brightness/100; }
          state.brightness=bri;
          state.color={ spectrumHsv:{ hue:Math.round(h)%360, saturation:Math.max(0,Math.min(1,s)), value:Math.max(0,Math.min(1,v)) } };
        }
        if(d.type==='FAN'){ state.currentFanSpeedSetting=d.speed||'low'; }
        devicesState[d.id]=state;
      }
      console.log('V37 QUERY', JSON.stringify(devicesState).slice(0,800));
      return res.json({requestId, payload:{devices:devicesState}});
    }
    if(intent==='action.devices.EXECUTE'){
      const commands=input.payload.commands;
      const results=[];
      for(let cmd of commands){
        for(let devInfo of cmd.devices){
          const id=devInfo.id;
          const d=await Device.findOne({id:id, userId:userId}) || await Device.findOne({id:id});
          if(!d) continue;
          console.log('V37 EXECUTE', id, JSON.stringify(cmd.execution));
          let newState={online:true};
          for(let ex of cmd.execution){
            if(ex.command==='action.devices.commands.OnOff'){ d.state=ex.params.on?'ON':'OFF'; newState.on=ex.params.on; }
            if(ex.command==='action.devices.commands.BrightnessAbsolute'){ d.brightness=ex.params.brightness; d.state='ON'; newState.brightness=ex.params.brightness; newState.on=true; }
            if(ex.command==='action.devices.commands.ColorAbsolute'){
              console.log('COLOR COMMAND params:', JSON.stringify(ex.params));
              let hsv = null;
              if(ex.params.color?.spectrumHSV){
                hsv = ex.params.color.spectrumHSV;
                console.log('Received spectrumHSV', hsv);
              } else if(ex.params.color?.spectrumHsv){
                hsv = ex.params.color.spectrumHsv;
                console.log('Received spectrumHsv', hsv);
              } else if(ex.params.color?.spectrumRgb){
                // Convert RGB int to HSV
                const rgbInt = ex.params.color.spectrumRgb;
                const r = (rgbInt >> 16) & 255;
                const g = (rgbInt >> 8) & 255;
                const b = rgbInt & 255;
                console.log('Received spectrumRgb', rgbInt, '->', r,g,b);
                // RGB to HSV conversion
                const r1=r/255, g1=g/255, b1=b/255;
                const max=Math.max(r1,g1,b1), min=Math.min(r1,g1,b1);
                let h=0,s=0,v=max;
                const d=max-min;
                s = max===0 ? 0 : d/max;
                if(max!==min){
                  switch(max){
                    case r1: h=(g1-b1)/d + (g1<b1?6:0); break;
                    case g1: h=(b1-r1)/d + 2; break;
                    case b1: h=(r1-g1)/d + 4; break;
                  }
                  h/=6;
                }
                hsv = {hue: Math.round(h*360), saturation: s, value: v};
                console.log('Converted RGB to HSV', hsv);
              }
              if(hsv){
                d.color={hue:Math.round(hsv.hue)%360, saturation:Math.max(0,Math.min(1,hsv.saturation)), brightness:Math.round(Math.max(0,Math.min(1,hsv.value))*100)};
                d.brightness=d.color.brightness;
                d.state='ON';
                newState.color={spectrumHsv:{hue:d.color.hue, saturation:d.color.saturation, value:hsv.value}};
                newState.brightness=d.brightness;
                newState.on=true;
              }
            }
            if(ex.command==='action.devices.commands.SetFanSpeed'){ d.speed=ex.params.fanSpeed; d.state='ON'; newState.currentFanSpeedSetting=d.speed; newState.on=true; }
          }
          await d.save();
          // Ensure return full state like QUERY
          if(d.type==='LIGHT' && !newState.brightness) newState.brightness=d.brightness||100;
          if(d.type==='LIGHT' && !newState.color && d.color){ let h=d.color.hue||0,s=d.color.saturation||0,v=(d.color.brightness||100)/100; if(s>1) s/=100; newState.color={spectrumHsv:{hue:Math.round(h)%360, saturation:s, value:v}}; }
          console.log('V37 EXECUTE RETURN', id, JSON.stringify(newState));
          try{ await sendGoogleReportState(userId, d); }catch(e){ console.log('Report fail', e.message); }
          results.push({ids:[id], status:'SUCCESS', states:newState});
        }
      }
      console.log('V37 EXECUTE FINAL', JSON.stringify(results).slice(0,1000));
      return res.json({requestId, payload:{commands:results}});
    }
  }catch(e){ console.log('V37 ERROR', e.message, e.stack); res.status(500).json({error:e.message}); }
});

app.post('/smarthome', (req,res)=>{ 
  // Forward to same logic by reusing the above handler
  req.url='/google/smarthome'; 
  app._router.handle(req,res);
});

server.listen(PORT,()=>console.log(`Thavayil SmartHome FIXED FAN - Port ${PORT} - Mongo: ${mongoose.connection.readyState}`));




global.offlineDevices = global.offlineDevices || new Set();
global.qCount = global.qCount || {};

app.get('/test/offline', async (req,res)=>{
  try{
    const dbStates = await OfflineState.find({offline:true});
    const dbList = dbStates.map(d=>d.deviceId);
    const memList = Array.from(global.offlineDevices);
    const merged = [...new Set([...dbList, ...memList])];
    res.json({offlineDevices: merged, db: dbList, memory: memList, source:'V12 DB collection'});
  }catch(e){ res.json({offlineDevices: Array.from(global.offlineDevices), error:e.message}); }
});
app.get('/test/offline/clear', async (req,res)=>{
  try{
    await OfflineState.deleteMany({});
    await Device.updateMany({}, {$set:{offline:false}});
  }catch(e){ console.log('clear error', e.message); }
  global.offlineDevices = new Set();
  global.qCount = {};
  console.log('V17 CLEARED ALL - relaying online:true for all');
  try{ const all = await Device.find({}); for(const d of all){ await forceReportOnline(d.id, true); } }catch(e){ console.log('clear report err', e.message); }
  res.json({success:true, cleared:true, offlineDevices:[]});
});
app.get('/test/offline/set', async (req,res)=>{
  try{
    const id = req.query.id;
    const onlineParam = req.query.online;
    if(!id) return res.status(400).json({error:'id required'});
    const isOnline = (onlineParam==='true' || onlineParam==='1');
    const isOffline = !isOnline;
    if(isOffline) global.offlineDevices.add(id); else global.offlineDevices.delete(id);
    try{
      await OfflineState.findOneAndUpdate({deviceId:id}, {deviceId:id, offline:isOffline, updatedAt:new Date()}, {upsert:true, new:true});
      const dev = await Device.findOne({id:id}) || await Device.findOne({deviceId:id});
      if(dev){ dev.offline = isOffline; await dev.save(); }
      console.log(`V17 SET ${id} offline=${isOffline} -> relay online:${!isOffline}`);
    }catch(e){ console.log('V17 set error', e.message); }
    global.qCount[id]=0;
    await forceReportOnline(id, !isOffline);
    res.json({success:true, device:id, online:isOnline, offline:isOffline, relay:`online:${!isOffline}`});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/test/offline', async (req,res)=>{
  try{
    const {deviceId, online} = req.body || {};
    if(!deviceId) return res.status(400).json({error:'deviceId required'});
    const isOnline = (online===true || online==='true');
    const isOffline = !isOnline;
    if(isOffline) global.offlineDevices.add(deviceId); else global.offlineDevices.delete(deviceId);
    global.qCount[deviceId]=0;
    try{
      await OfflineState.findOneAndUpdate({deviceId:deviceId}, {deviceId:deviceId, offline:isOffline, updatedAt:new Date()}, {upsert:true, new:true});
      const dev = await Device.findOne({id:deviceId}) || await Device.findOne({deviceId:deviceId});
      if(dev){ dev.offline = isOffline; await dev.save(); if(io && dev.userId) io.to('user_'+dev.userId).emit('device_updated', dev); }
      console.log(`V17 POST ${deviceId} offline=${isOffline} -> relay online:${!isOffline}`);
    }catch(e){ console.log('V17 post error', e.message); }
    await forceReportOnline(deviceId, !isOffline);
    res.json({success:true, device:deviceId, online:isOnline, offline:isOffline, relay:`online:${!isOffline}`});
  }catch(e){ res.status(500).json({error:e.message}); }
});




app.post('/google', async (req,res)=>{
  try{
    const accessToken = (req.headers.authorization||'').replace('Bearer ','');
    let userId=null;
    if(accessToken){
      try{ const decoded=jwt.verify(accessToken, JWT_SECRET); userId=decoded.id; }catch(e){
        const tokenDoc = await Token.findOne({accessToken}); if(tokenDoc) userId=tokenDoc.userId;
      }
    }
    if(!userId) return res.status(401).json({error:'auth'});
    const requestId = req.body.requestId;
    const intent = req.body.inputs[0].intent;

    if(intent==='action.devices.SYNC'){
      const userDevices=await Device.find({userId});
      const devices=userDevices.map(d=>{
        let traits=[];
        let type='action.devices.types.SWITCH';
        let attrs={};
        if(d.type==='LIGHT'){ traits=['action.devices.traits.OnOff','action.devices.traits.Brightness','action.devices.traits.ColorSetting']; type='action.devices.types.LIGHT'; attrs={colorModel:'hsv', colorTemperatureRange:{temperatureMinK:2000, temperatureMaxK:9000}}; }
        else if(d.type==='FAN'){ traits=['action.devices.traits.OnOff','action.devices.traits.FanSpeed']; type='action.devices.types.FAN'; attrs={availableFanSpeeds:{speeds:[{speed_name:'low',speed_values:[{speed_synonym:['low','slow'],lang:'en'}]},{speed_name:'medium',speed_values:[{speed_synonym:['medium'],lang:'en'}]},{speed_name:'high',speed_values:[{speed_synonym:['high','fast'],lang:'en'}]}]},ordered:true,reversible:false}; }
        else { traits=['action.devices.traits.OnOff']; type='action.devices.types.SWITCH'; }
        return {id:d.id, type:type, traits:traits, name:{defaultNames:[d.name], name:d.name, nicknames:[d.name]}, willReportState:false, attributes:attrs, deviceInfo:{manufacturer:'Thavayil', model:'Smart', hwVersion:'1.0', swVersion:'1.0'}, customData:{deviceId:d.id}};
      });
      return res.json({requestId, payload:{agentUserId:userId, devices}});
    }

                    console.log('V17 QUERY intent user', userId);
    if(intent==='action.devices.QUERY'){
      const payloadDevices = req.body.inputs[0].payload.devices;
      const userDevices=await Device.find({userId});
      let devicesState = {};
      let dbOfflineIds = [];
      try{
        const offStates = await OfflineState.find({offline:true});
        dbOfflineIds = offStates.map(s=>s.deviceId);
      }catch(e){ console.log('query offline fetch error', e.message); }
      for(const q of payloadDevices){
        const d = userDevices.find(x=>x.id===q.id || x.deviceId===q.id);
        let isOffline = false;
        if(dbOfflineIds.includes(q.id)) isOffline=true;
        if(global.offlineDevices.has(q.id)) isOffline=true;
        if(d && d.offline===true) isOffline=true;
        let online = !isOffline;
        if(!d){
          devicesState[q.id]={online:online, on:false, status:'SUCCESS'};
          continue;
        }
        let state = {online:online, on: d.state==='ON', status:'SUCCESS'};
        if(d.type==='FAN'){
          const map = {1:'low',2:'low',3:'medium',4:'high',5:'high'};
          state.currentFanSpeedSetting = map[d.speed] || 'medium';
        }
        if(d.type==='LIGHT'){
          const bri = (d.brightness!==undefined)? d.brightness : 80;
          const col = d.color || {hue:45, saturation:1, brightness: bri};
          state.brightness = bri;
          state.color = { spectrumHsv:{ hue: col.hue||45, saturation: (col.saturation!==undefined?col.saturation:1), value: ((col.brightness||bri)/100) } };
        }
        devicesState[q.id]=state;
      }
      console.log('QUERY V12', JSON.stringify({dbOffline: dbOfflineIds, memory:Array.from(global.offlineDevices)}));
      return res.json({requestId, payload:{devices:devicesState}});
    }

    if(intent==='action.devices.EXECUTE'){
      const commands = req.body.inputs[0].payload.commands;
      let results=[];
      for(const cmd of commands){
        for(const device of cmd.devices){
          const dev = await Device.findOne({id:device.id, userId}) || await Device.findOne({deviceId:device.id, userId});
          if(!dev){ results.push({ids:[device.id], status:'ERROR', errorCode:'deviceNotFound'}); continue; }
          let newState = {online:true};
          for(const ex of cmd.execution){
            const params = ex.params;
            if(ex.command==='action.devices.commands.OnOff'){
              dev.state = params.on? 'ON' : 'OFF';
              newState.on = params.on;
              if(dev.type==='FAN'){
                if(params.on && !dev.speed) dev.speed = 3;
                const map = {1:'low',2:'low',3:'medium',4:'high',5:'high'};
                newState.currentFanSpeedSetting = map[dev.speed] || 'medium';
              }
              if(dev.type==='LIGHT'){
                const bri = (dev.brightness!==undefined)? dev.brightness : 80;
                const col = dev.color || {hue:45, saturation:1, brightness: bri};
                newState.brightness = bri;
                newState.color = { spectrumHsv:{ hue: col.hue||45, saturation: col.saturation||1, value: (col.brightness||bri)/100 } };
              }
            }
            if(ex.command==='action.devices.commands.BrightnessAbsolute'){
              dev.brightness=params.brightness;
              if(dev.color) dev.color.brightness=params.brightness;
              newState.brightness=params.brightness;
              newState.on = dev.state==='ON';
              if(dev.color){
                newState.color={ spectrumHsv:{ hue: dev.color.hue||45, saturation: dev.color.saturation||1, value: params.brightness/100 } };
              }
            }
            if(ex.command==='action.devices.commands.ColorAbsolute'){
              if(params.color && params.color.spectrumHsv){
                const hsv=params.color.spectrumHsv;
                dev.color={hue:hsv.hue, saturation:hsv.saturation, brightness: (hsv.value*100)};
                dev.brightness=Math.round(hsv.value*100);
                newState.color={spectrumHsv:hsv};
                newState.brightness=dev.brightness;
                newState.on=true; dev.state='ON';
              }
            }
            if(ex.command==='action.devices.commands.SetFanSpeed'){
              const speedMap={'low':2,'medium':3,'high':5};
              dev.speed=speedMap[params.fanSpeed]||3;
              dev.state='ON';
              newState.on=true;
              newState.currentFanSpeedSetting=params.fanSpeed;
            }
          }
          await dev.save();
          if(io) io.to('user_'+userId).emit('device_updated', dev);
          results.push({ids:[device.id], status:'SUCCESS', states:newState});
        }
      }
      return res.json({requestId, payload:{commands:results}});
    }

    if(intent==='action.devices.DISCONNECT'){
      return res.json({requestId, payload:{}});
    }

    return res.json({requestId, payload:{}});
  }catch(err){
    console.error('Google error', err);
    return res.status(500).json({error:err.message});
  }
});
