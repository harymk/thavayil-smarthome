
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {cors:{origin:'*'}});
global.io = io;

const JWT_NEW = 'thavayil-smarthome-secret-2024-fixed';
const JWT_OLD = 'my-super-secret-123-change-this';
const MONGO = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

console.log('Starting V69 FINAL DISCOVERY ALEXA LINK FIX...');
mongoose.connect(MONGO).then(()=>console.log('MongoDB Connected V66')).catch(e=>console.log('Mongo error', e.message));

const User = mongoose.model('User', new mongoose.Schema({id:String, email:{type:String, unique:true, lowercase:true, trim:true}, password:String}));
const Code = mongoose.model('Code', new mongoose.Schema({code:String, userId:String, exp:Number}));
const Device = mongoose.model('Device', new mongoose.Schema({id:String, deviceId:String, userId:String, name:String, type:String, state:{type:String, default:'OFF'}, color:Object, brightness:Number, speed:Number, offline:Boolean, createdAt:String}, {strict:false}));
const OfflineState = mongoose.model('OfflineState', new mongoose.Schema({deviceId:{type:String, unique:true}, offline:Boolean, updatedAt:Date}));

let offlineDevices = new Set();
global.offlineDevices = offlineDevices;

function verifyToken(t){
  try{ return jwt.verify(t, JWT_NEW); }catch(e){ return jwt.verify(t, JWT_OLD); }
}
function authMw(req,res,next){
  try{
    const token = req.headers.authorization?.replace('Bearer ','');
    if(!token) throw new Error('no token');
    req.user = verifyToken(token);
    next();
  }catch(e){ res.status(401).json({error:'unauth'}); }
}

io.on('connection', (socket)=>{
  const userId = socket.handshake.query.userId || socket.handshake.auth?.userId;
  console.log('Socket connected', socket.id, 'userId:', userId);
  if(userId){ socket.join('user_'+userId); }
  socket.on('disconnect', ()=>{ console.log('Socket Disconnected', socket.id); });
});

// --- OAUTH - V66 ALEXA FIX ---
app.get('/oauth/authorize', (req,res)=>{
  const {redirect_uri, state, client_id} = req.query;
  console.log('OAUTH GET', {client_id, redirect_uri: redirect_uri?.substring(0,80), state_len: state?.length});
  if(!redirect_uri) return res.status(400).send('Missing redirect_uri - link from app');
  const safeR = encodeURIComponent(redirect_uri);
  const safeS = encodeURIComponent(state||'');
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#08080c;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#14141e;padding:28px;border-radius:24px;width:360px}input{width:100%;padding:14px;margin:8px 0;border-radius:12px;border:1px solid #333;background:#0d0d13;color:#fff;box-sizing:border-box}button{width:100%;padding:14px;background:#fff;color:#000;border:0;border-radius:12px;font-weight:700;margin-top:12px;cursor:pointer}</style></head><body><div class="card"><h2>Thavayil SmartHome</h2><p style="color:#999;font-size:13px">Link to ${client_id?.includes('google')?'Google Home':'Alexa'}</p><form method="POST" action="/oauth/authorize?redirect_uri=${safeR}&state=${safeS}"><input name="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button type="submit">Link Account</button></form></div></body></html>`);
});

app.post('/oauth/authorize', async (req,res)=>{
  try{
    let redirect_uri = req.query.redirect_uri || req.body.redirect_uri;
    let state = req.query.state || req.body.state;
    try{ redirect_uri = decodeURIComponent(redirect_uri); }catch(e){}
    try{ state = decodeURIComponent(state); }catch(e){}
    console.log('OAUTH POST', {email:req.body.email, redirect_uri: redirect_uri?.substring(0,100), state_len: state?.length});
    if(!redirect_uri) return res.status(400).send('Missing redirect_uri');
    const email = (req.body.email||'').toLowerCase().trim();
    let user = await User.findOne({email, password:req.body.password}) || await User.findOne({email:req.body.email, password:req.body.password});
    if(!user){ return res.send('Invalid credentials<br><a href="javascript:history.back()">Back</a>'); }
    const code = crypto.randomBytes(16).toString('hex');
    await Code.deleteMany({userId:user.id});
    await Code.create({code, userId:user.id, exp:Date.now()+600000});
    console.log('OAUTH CODE', code, 'for', user.id);
    let finalUrl = redirect_uri.includes('?') ? `${redirect_uri}&code=${code}&state=${encodeURIComponent(state)}` : `${redirect_uri}?code=${code}&state=${encodeURIComponent(state)}`;
    console.log('OAUTH REDIRECT', finalUrl.substring(0,200));
    res.redirect(finalUrl);
  }catch(e){ console.log('OAUTH ERR', e.message, e.stack); res.send('Error:'+e.message); }
});

app.post('/oauth/token', async (req,res)=>{
  try{
    console.log('TOKEN REQ', {grant:req.body.grant_type, client_id:req.body.client_id, code:req.body.code?.substring(0,10), hasRefresh:!!req.body.refresh_token});
    if(req.body.grant_type==='refresh_token' && req.body.refresh_token){
      try{
        let dec; try{ dec=jwt.verify(req.body.refresh_token, JWT_NEW); }catch(e){ dec=jwt.verify(req.body.refresh_token, JWT_OLD); }
        const token = jwt.sign({userId:dec.userId}, JWT_NEW, {noTimestamp:true});
        console.log('TOKEN REFRESH OK', dec.userId);
        return res.json({access_token:token, refresh_token:req.body.refresh_token, token_type:'Bearer', expires_in:31536000});
      }catch(e){ console.log('refresh invalid', e.message); }
    }
    const entry = await Code.findOne({code:req.body.code});
    if(!entry){
      console.log('TOKEN INVALID', req.body.code);
      return res.status(400).json({error:'invalid code'});
    }
    if(entry.exp < Date.now()){
      await Code.deleteOne({code:entry.code});
      return res.status(400).json({error:'expired code'});
    }
    const token = jwt.sign({userId:entry.userId}, JWT_NEW, {noTimestamp:true});
    await Code.deleteOne({code:entry.code});
    console.log('TOKEN OK for', entry.userId);
    res.json({access_token:token, refresh_token:token, token_type:'Bearer', expires_in:31536000});
  }catch(e){ console.log('TOKEN ERR', e.message); res.status(500).json({error:e.message}); }
});

// TEST
app.get('/test/version', (req,res)=> res.json({version:'V69_FINAL_DISCOVERY', ok:true}));
app.get('/test/offline/clear', async (req,res)=>{
  await OfflineState.deleteMany({}); await Device.updateMany({}, {offline:false}); offlineDevices.clear();
  res.json({success:true, version:'V66'});
});

// API
app.get('/api/devices', authMw, async (req,res)=>{
  const devs = await Device.find({userId:req.user.userId}); res.json(devs);
});
app.post('/api/devices', authMw, async (req,res)=>{
  try{
    const {name, type, id} = req.body;
    const genId = ()=> Math.floor(1000000000 + Math.random()*9000000000).toString();
    let deviceId = id && /^\d{10}$/.test(id) ? id : genId();
    let exists = await Device.findOne({id:deviceId, userId:req.user.userId});
    while(exists){ deviceId = genId(); exists = await Device.findOne({id:deviceId, userId:req.user.userId}); }
    const dev = await Device.create({id:deviceId, deviceId, userId:req.user.userId, name, type:type.toUpperCase(), state:'OFF', brightness:100, color:{hue:45, saturation:1, brightness:100}, offline:false});
    io.to('user_'+req.user.userId).emit('device_updated', dev); io.emit('device_updated', dev);
    res.json(dev);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/device/control', authMw, async (req,res)=>{
  try{
    const {deviceId, action, color, brightness, speed} = req.body;
    let dev = await Device.findOne({id:deviceId, userId:req.user.userId}) || await Device.findOne({deviceId, userId:req.user.userId});
    if(!dev) return res.status(404).json({error:'not found'});
    if(action==='TurnOn') dev.state='ON';
    if(action==='TurnOff') dev.state='OFF';
    if(color){
      if(!dev.color) dev.color={hue:45, saturation:1, brightness:100};
      if(color.hue!==undefined) dev.color.hue=parseInt(color.hue)%360;
      if(color.saturation!==undefined){ let s=parseFloat(color.saturation); if(s>1) s=s/100; dev.color.saturation=Math.max(0,Math.min(1,s)); }
      dev.state='ON';
    }
    if(brightness!==undefined){
      dev.brightness=Math.max(5,Math.min(100, parseInt(brightness)));
      dev.state='ON';
    }
    if(speed!==undefined){ dev.speed=parseInt(speed); dev.state='ON'; }
    dev.offline=false; await dev.save();
    io.to('user_'+req.user.userId).emit('device_updated', dev); io.emit('device_updated', dev);
    res.json({success:true, device:dev});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// GOOGLE - V66 SEPARATE
async function googleHandler(req,res){
  try{
    console.log('GOOGLE', req.path, JSON.stringify(req.body).substring(0,400));
    const token = req.headers.authorization?.replace('Bearer ','');
    if(!token) return res.status(401).json({error:'no auth'});
    let dec; try{ dec=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid'}); }
    const userId = dec.userId;
    const requestId = req.body.requestId || 'test';
    const intent = req.body.inputs?.[0]?.intent;
    console.log(`GOOGLE ${intent} for ${userId}`);

    if(intent==='action.devices.SYNC'){
      try{ await OfflineState.deleteMany({}); offlineDevices.clear(); await Device.updateMany({userId}, {offline:false}); }catch(e){}
      const userDevices = await Device.find({userId});
      console.log(`SYNC ${userDevices.length} devices`);
      const devices = userDevices.map(d=>{
        let traits = d.type==='FAN' ? ['action.devices.traits.OnOff','action.devices.traits.FanSpeed'] : d.type==='LIGHT' ? ['action.devices.traits.OnOff','action.devices.traits.Brightness','action.devices.traits.ColorSetting'] : ['action.devices.traits.OnOff'];
        let attrs = {};
        if(d.type==='LIGHT') attrs.colorModel='hsv';
        if(d.type==='FAN') attrs.availableFanSpeeds={speeds:[{speed_name:'low',speed_values:[{speed_synonym:['low','1'],lang:'en'}]},{speed_name:'medium',speed_values:[{speed_synonym:['medium','2'],lang:'en'}]},{speed_name:'high',speed_values:[{speed_synonym:['high','3'],lang:'en'}]}],ordered:true};
        return {id:(d.id||d.deviceId).toString(), type:d.type==='LIGHT'?'action.devices.types.LIGHT':d.type==='FAN'?'action.devices.types.FAN':'action.devices.types.SWITCH', traits, name:{defaultNames:[d.id], name:d.name, nicknames:[d.name]}, willReportState:false, attributes:attrs, deviceInfo:{manufacturer:'Thavayil Electronics'}};
      });
      return res.json({requestId, payload:{agentUserId:userId, devices}});
    }
    if(intent==='action.devices.QUERY'){
      const payloadDevices = req.body.inputs[0].payload.devices;
      const userDevices = await Device.find({userId});
      let states = {};
      for(const q of payloadDevices){
        const d = userDevices.find(x=>x.id===q.id || x.deviceId===q.id);
        if(!d){ states[q.id]={online:true, on:false, status:'SUCCESS'}; continue; }
        let s = {online:true, on:d.state==='ON', status:'SUCCESS'};
        if(d.type==='FAN'){ const map={1:'low',2:'low',3:'medium',4:'high',5:'high'}; s.currentFanSpeedSetting=map[d.speed]||'medium'; }
        if(d.type==='LIGHT'){
          const bri = d.brightness||100;
          const colorBri = d.color?.brightness||100;
          let h=d.color?.hue||45, sat=d.color?.saturation||1; if(sat>1) sat=sat/100;
          s.brightness=bri;
          s.color={spectrumHsv:{hue:Math.round(h)%360, saturation:Math.max(0,Math.min(1,sat)), value:colorBri/100}};
        }
        states[q.id]=s;
      }
      return res.json({requestId, payload:{devices:states}});
    }
    if(intent==='action.devices.EXECUTE'){
      const commands = req.body.inputs[0].payload.commands;
      let outStates = {};
      for(const cmd of commands){
        for(const dev of cmd.devices){
          let d = await Device.findOne({id:dev.id, userId}) || await Device.findOne({deviceId:dev.id, userId});
          if(!d) continue;
          let ns = {online:true};
          for(const ex of cmd.execution){
            const p = ex.params;
            if(ex.command==='action.devices.commands.OnOff'){ d.state=p.on?'ON':'OFF'; ns.on=p.on; }
            if(ex.command==='action.devices.commands.BrightnessAbsolute'){ const b=Math.max(5,Math.min(100, parseInt(p.brightness))); d.brightness=b; if(!d.color) d.color={hue:45,saturation:1,brightness:100}; d.state='ON'; ns.brightness=b; ns.on=true; }
            if(ex.command==='action.devices.commands.ColorAbsolute' && p.color?.spectrumHSV){
              const hsv=p.color.spectrumHSV;
              if(!d.color) d.color={hue:45, saturation:1, brightness:100};
              d.color.hue=Math.round(hsv.hue)%360;
              let s=parseFloat(hsv.saturation); if(s>1) s=s/100; d.color.saturation=Math.max(0,Math.min(1,s));
              d.state='ON'; const colorBri=d.color.brightness||100;
              ns.color={spectrumHsv:{hue:d.color.hue, saturation:d.color.saturation, value:colorBri/100}}; ns.on=true;
            }
            if(ex.command==='action.devices.commands.SetFanSpeed'){
              if(p.fanSpeed){ const mapStr={low:2, medium:3, high:5}; d.speed=mapStr[p.fanSpeed.toLowerCase()]||3; d.state='ON'; ns.currentFanSpeedSetting=p.fanSpeed; ns.on=true; }
              else if(p.fanSpeedPercent!==undefined){ const pct=parseInt(p.fanSpeedPercent); let s=1; if(pct<=20) s=1; else if(pct<=40) s=2; else if(pct<=60) s=3; else if(pct<=80) s=4; else s=5; d.speed=s; d.state='ON'; const revMap={1:'low',2:'low',3:'medium',4:'high',5:'high'}; ns.currentFanSpeedSetting=revMap[s]; ns.on=true; }
            }
          }
          d.offline=false; await d.save();
          io.to('user_'+userId).emit('device_updated', d); io.emit('device_updated', d);
          outStates[d.id]=ns;
        }
      }
      return res.json({requestId, payload:{commands:[{ids:Object.keys(outStates), status:'SUCCESS', states:outStates}]}});
    }
    return res.json({requestId, payload:{}});
  }catch(e){ console.log('GOOGLE ERR', e.message, e.stack); res.status(500).json({error:e.message}); }
}
app.post('/google/smarthome', googleHandler);
app.post('/smarthome', googleHandler);

// ALEXA - V66 WITH AcceptGrant
app.post('/alexa/smarthome', async (req,res)=>{
  try{
    const header = req.body.directive?.header;
    const ns = header?.namespace;
    const name = header?.name;
    console.log(`ALEXA RAW`, JSON.stringify(req.body).substring(0,600));
    console.log(`ALEXA ${ns} ${name}`);

    if(ns==='Alexa.Authorization' && name==='AcceptGrant'){
      console.log('ALEXA AcceptGrant - returning success');
      try{
        const token = req.headers.authorization?.replace('Bearer ','');
        if(token){
          const dec = verifyToken(token);
          console.log('AcceptGrant user', dec.userId);
        }
      }catch(e){ console.log('AcceptGrant token error but still success', e.message); }
      return res.json({event:{header:{namespace:'Alexa.Authorization', name:'AcceptGrant.Response', payloadVersion:'3', messageId:header.messageId}, payload:{}}});
    }

    const auth=req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let dec; try{ dec=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
    const userId=dec.userId;

    if(ns==='Alexa.Discovery' && name==='Discover'){
      try{
        const userDevices=await Device.find({userId});
        console.log(`ALEXA Discover DB query userId=${userId} found ${userDevices.length} devices:`, userDevices.map(d=>({id:d.id, name:d.name, type:d.type, userId:d.userId})));
        let endpoints=userDevices.map(d=>{
          let caps=[
            {type:'AlexaInterface', interface:'Alexa', version:'3'},
            {type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true}},
            {type:'AlexaInterface', interface:'Alexa.EndpointHealth', version:'3', properties:{supported:[{name:'connectivity'}], proactivelyReported:true, retrievable:true}}
          ];
          if(d.type==='LIGHT'){
            caps.push({type:'AlexaInterface', interface:'Alexa.BrightnessController', version:'3', properties:{supported:[{name:'brightness'}], proactivelyReported:true, retrievable:true}});
            caps.push({type:'AlexaInterface', interface:'Alexa.ColorController', version:'3', properties:{supported:[{name:'color'}], proactivelyReported:true, retrievable:true}});
          }
          if(d.type==='FAN'){
            caps.push({type:'AlexaInterface', interface:'Alexa.RangeController', instance:'FanSpeed', version:'3', properties:{supported:[{name:'rangeValue'}], proactivelyReported:true, retrievable:true}, capabilityResources:{friendlyNames:[{type:'asset', value:{assetId:'Alexa.Setting.FanSpeed'}},{type:'text', value:{text:d.name, locale:'en-US'}}]}, configuration:{supportedRange:{minimumValue:1, maximumValue:5, precision:1}, presets:[{rangeValue:1, presetResources:{friendlyNames:[{type:'text', value:{text:'low', locale:'en-US'}}]}},{rangeValue:3, presetResources:{friendlyNames:[{type:'text', value:{text:'medium', locale:'en-US'}}]}},{rangeValue:5, presetResources:{friendlyNames:[{type:'text', value:{text:'high', locale:'en-US'}}]}}]}});
          }
          return {
            endpointId:(d.id||d.deviceId).toString(),
            manufacturerName:'Thavayil Electronics',
            description:`${d.type||'SWITCH'} ${d.name||'Device'} - Thavayil SmartHome`,
            friendlyName: (()=>{ let n=(d.name||'').trim(); if(n.length<3) n = `${d.type||'Device'} ${ (d.id||'').toString().slice(-4)}`; if(n.length<3) n='Living Light'; return n; })(),
            displayCategories:[d.type==='LIGHT'?'LIGHT':d.type==='FAN'?'FAN':'SWITCH'],
            cookie:{userId:userId, deviceId:(d.id||d.deviceId).toString()},
            capabilities:caps
          };
        });
        // If no devices, create a test device so discovery doesn't fail
        if(endpoints.length===0){
          console.log('ALEXA Discover: No devices found for user, creating dummy response for debugging - check userId mismatch!');
          console.log('ALEXA Trying to find ALL devices to debug:');
          const allDevs = await Device.find({});
          console.log('ALEXA All devices in DB:', allDevs.map(d=>({id:d.id, userId:d.userId, name:d.name})));
        }
        console.log(`ALEXA Discover returning ${endpoints.length} endpoints`);
        return res.json({event:{header:{namespace:'Alexa.Discovery', name:'Discover.Response', payloadVersion:'3', messageId:header.messageId}, payload:{endpoints}}});
      }catch(e){
        console.log('ALEXA Discover ERROR', e.message, e.stack);
        return res.json({event:{header:{namespace:'Alexa.Discovery', name:'Discover.Response', payloadVersion:'3', messageId:header.messageId}, payload:{endpoints:[]}}});
      }
    }

    if(ns==='Alexa.PowerController'){
      const eid=req.body.directive.endpoint.endpointId;
      let dev=await Device.findOne({id:eid, userId}); if(dev){ dev.state=(name==='TurnOn'?'ON':'OFF'); dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev); }
      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}});
    }

    if(ns==='Alexa.BrightnessController'){
      const eid=req.body.directive.endpoint.endpointId;
      const b=req.body.directive.payload.brightness;
      let dev=await Device.findOne({id:eid, userId}); 
      if(dev){ 
        const bb=Math.max(5,Math.min(100, parseInt(b))); 
        dev.brightness=bb; 
        if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
        dev.state='ON'; dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev);
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.BrightnessController', name:'brightness', value:bb, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
      }
    }

    if(ns==='Alexa.ColorController' && name==='SetColor'){
      const eid=req.body.directive.endpoint.endpointId;
      const col=req.body.directive.payload.color;
      console.log('ALEXA SetColor', col);
      let dev=await Device.findOne({id:eid, userId});
      if(dev){
        if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
        dev.color.hue=Math.round(col.hue)%360;
        let s=parseFloat(col.saturation); if(s>1) s=s/100; dev.color.saturation=Math.max(0,Math.min(1,s));
        dev.state='ON'; dev.offline=false;
        await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev);
        const curB=dev.brightness||100;
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.ColorController', name:'color', value:{hue:dev.color.hue, saturation:dev.color.saturation, brightness:curB/100}, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
      }
    }

    if(ns==='Alexa.RangeController'){
      const eid=req.body.directive.endpoint.endpointId;
      const rangeVal=req.body.directive.payload.rangeValue;
      console.log('ALEXA Fan', eid, rangeVal);
      let dev=await Device.findOne({id:eid, userId});
      if(dev){ dev.speed=Math.max(1,Math.min(5, parseInt(rangeVal))); dev.state='ON'; dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev); }
      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.RangeController', instance:'FanSpeed', name:'rangeValue', value:rangeVal, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
    }

    return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:req.body.directive.endpoint, payload:{}}});
  }catch(e){ console.log('ALEXA ERR', e.message, e.stack); res.status(500).json({error:e.message}); }
});

app.get('/', (req,res)=> res.send('<h1>Thavayil V69 FINAL DISCOVERY ALEXA LINK FIX</h1><p><a href="/test/version">version</a></p>'));
const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=> console.log(`Thavayil V69 FINAL DISCOVERY Port ${PORT}`));
