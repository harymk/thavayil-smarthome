
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

const JWT_NEW = 'thavayil-smarthome-secret-2024-fixed';
const JWT_OLD = 'my-super-secret-123-change-this';
const MONGO = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

console.log('Starting V58 CLEAN...');
mongoose.connect(MONGO).then(()=>console.log('MongoDB Connected V58')).catch(e=>console.log('Mongo error', e.message));

// MODELS
const User = mongoose.model('User', new mongoose.Schema({id:String, email:{type:String, unique:true, lowercase:true, trim:true}, password:String}));
const Code = mongoose.model('Code', new mongoose.Schema({code:String, userId:String, exp:Number}));
const Device = mongoose.model('Device', new mongoose.Schema({id:String, deviceId:String, userId:String, name:String, type:String, state:{type:String, default:'OFF'}, color:Object, brightness:Number, speed:Number, offline:Boolean, createdAt:String}, {strict:false}));
const OfflineState = mongoose.model('OfflineState', new mongoose.Schema({deviceId:{type:String, unique:true}, offline:Boolean, updatedAt:Date}));

let offlineDevices = new Set();

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

// --- AUTH ---
app.get('/oauth/authorize', (req,res)=>{
  const {redirect_uri, state, client_id} = req.query;
  console.log('OAUTH GET', {client_id, redirect_uri, state});
  if(!redirect_uri) return res.status(400).send('Missing redirect_uri - link from Google/Alexa app');
  const safeR = encodeURIComponent(redirect_uri);
  const safeS = encodeURIComponent(state||'');
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#08080c;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#14141e;padding:28px;border-radius:24px;width:360px}input{width:100%;padding:14px;margin:8px 0;border-radius:12px;border:1px solid #333;background:#0d0d13;color:#fff;box-sizing:border-box}button{width:100%;padding:14px;background:#fff;color:#000;border:0;border-radius:12px;font-weight:700;margin-top:12px;cursor:pointer}</style></head><body><div class="card"><h2>Thavayil SmartHome</h2><p style="color:#999;font-size:13px">Link to ${client_id?.includes('google')?'Google Home':'Alexa'}</p><form method="POST" action="/oauth/authorize?redirect_uri=${safeR}&state=${safeS}"><input name="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button type="submit">Link Account</button></form></div></body></html>`);
});

app.post('/oauth/authorize', async (req,res)=>{
  try{
    const redirect_uri = req.query.redirect_uri;
    const state = req.query.state;
    console.log('OAUTH POST', {email:req.body.email, redirect_uri});
    if(!redirect_uri) return res.status(400).send('Missing redirect_uri');
    const email = req.body.email.toLowerCase().trim();
    let user = await User.findOne({email, password:req.body.password}) || await User.findOne({email:req.body.email, password:req.body.password});
    if(!user){ return res.send('Invalid credentials<br><a href="javascript:history.back()">Back</a>'); }
    const code = crypto.randomBytes(16).toString('hex');
    await Code.create({code, userId:user.id, exp:Date.now()+600000});
    let finalUrl;
    if(redirect_uri.includes('?')) finalUrl = `${redirect_uri}&code=${code}&state=${state}`;
    else finalUrl = `${redirect_uri}?code=${code}&state=${state}`;
    console.log('OAUTH OK for', user.id, '->', finalUrl.substring(0,100));
    res.redirect(finalUrl);
  }catch(e){ console.log('OAUTH ERR', e); res.send('Error:'+e.message); }
});

app.post('/oauth/token', async (req,res)=>{
  try{
    console.log('TOKEN REQ', {grant:req.body.grant_type, client_id:req.body.client_id, hasCode:!!req.body.code, hasRefresh:!!req.body.refresh_token});
    if(req.body.grant_type==='refresh_token' && req.body.refresh_token){
      try{
        const dec = jwt.verify(req.body.refresh_token, JWT_NEW);
        const token = jwt.sign({userId:dec.userId}, JWT_NEW, {noTimestamp:true});
        console.log('TOKEN REFRESH OK', dec.userId);
        return res.json({access_token:token, refresh_token:token, token_type:'Bearer', expires_in:31536000});
      }catch(e){ console.log('refresh invalid', e.message); }
    }
    const entry = await Code.findOne({code:req.body.code});
    if(!entry) return res.status(400).json({error:'invalid code'});
    const token = jwt.sign({userId:entry.userId}, JWT_NEW, {noTimestamp:true});
    console.log('TOKEN OK for', entry.userId);
    res.json({access_token:token, refresh_token:token, token_type:'Bearer', expires_in:31536000});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// --- TEST ENDPOINTS (GUARANTEED) ---
app.get('/test/version', (req,res)=> res.json({version:'V58_CLEAN_FINAL', ok:true, time:new Date().toISOString()}));
app.get('/test/google-sync/:userId', async (req,res)=>{
  try{
    const devs = await Device.find({userId:req.params.userId});
    res.json({userId:req.params.userId, count:devs.length, devices:devs.map(d=>({id:d.id, deviceId:d.deviceId, name:d.name, type:d.type, brightness:d.brightness, color:d.color, offline:d.offline}))});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/test/offline/clear', async (req,res)=>{
  try{
    await OfflineState.deleteMany({});
    await Device.updateMany({}, {$set:{offline:false}});
    offlineDevices.clear();
    res.json({success:true, cleared:true, version:'V58'});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/test/offline', async (req,res)=>{
  try{
    const db = await OfflineState.find({offline:true});
    const devs = await Device.find({offline:true});
    res.json({offlineDevices:db.map(d=>d.deviceId), offlineDeviceDocs:devs.map(d=>d.id), memory:Array.from(offlineDevices), version:'V58'});
  }catch(e){ res.json({offlineDevices:Array.from(offlineDevices)}); }
});

// --- DASHBOARD ---
app.get('/api/devices', authMw, async (req,res)=>{
  try{ const devs = await Device.find({userId:req.user.userId}); res.json(devs); }catch(e){ res.status(500).json({error:e.message}); }
});
function genId(){ return Math.floor(1000000000 + Math.random()*9000000000).toString(); }
app.post('/api/devices', authMw, async (req,res)=>{
  try{
    const {name, type, id} = req.body;
    if(!name||!type) return res.status(400).json({error:'name type required'});
    let deviceId = id && /^\d{10}$/.test(id) ? id : genId();
    let exists = await Device.findOne({id:deviceId, userId:req.user.userId});
    while(exists){ deviceId = genId(); exists = await Device.findOne({id:deviceId, userId:req.user.userId}); }
    const dev = await Device.create({id:deviceId, deviceId, userId:req.user.userId, name, type:type.toUpperCase(), state:'OFF', brightness:100, color:{hue:45, saturation:1, brightness:100}, offline:false});
    io.to('user_'+req.user.userId).emit('device_created', dev);
    res.json(dev);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/device/control', authMw, async (req,res)=>{
  try{
    const {deviceId, action, color, brightness, speed} = req.body;
    console.log('DASHBOARD', {deviceId, action, color, brightness, speed});
    let dev = await Device.findOne({id:deviceId, userId:req.user.userId}) || await Device.findOne({deviceId, userId:req.user.userId});
    if(!dev) return res.status(404).json({error:'not found'});
    if(action==='TurnOn') dev.state='ON';
    if(action==='TurnOff') dev.state='OFF';
    if(color && dev.type==='LIGHT'){
      if(!dev.color) dev.color={hue:45, saturation:1, brightness:dev.brightness||100};
      if(color.hue!==undefined) dev.color.hue=parseInt(color.hue)%360;
      if(color.saturation!==undefined){ let s=parseFloat(color.saturation); if(s>1) s=s/100; dev.color.saturation=Math.max(0,Math.min(1,s)); }
      dev.state='ON';
    }
    if(brightness!==undefined && dev.type==='LIGHT'){
      const b=Math.max(5,Math.min(100, parseInt(brightness)));
      dev.brightness=b;
      if(!dev.color) dev.color={hue:45, saturation:1, brightness:b};
      dev.color.brightness=b;
      dev.state='ON';
    }
    if(speed!==undefined && dev.type==='FAN'){ dev.speed=parseInt(speed); dev.state='ON'; }
    dev.offline=false;
    await dev.save();
    io.to('user_'+req.user.userId).emit('device_updated', dev);
    io.to('user_'+req.user.userId).emit('alexa_cmd', {deviceId, action, color, brightness, speed});
    res.json({success:true, device:dev});
  }catch(e){ console.log('DASH CTRL ERR', e.message); res.status(500).json({error:e.message}); }
});

// --- GOOGLE ---
async function googleHandler(req,res){
  try{
    console.log('GOOGLE REQ', req.path, JSON.stringify(req.body).substring(0,500));
    const auth = req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token = auth.replace('Bearer ','');
    let dec; try{ dec=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
    const userId = dec.userId;
    const requestId = req.body.requestId || 'test';
    const intent = req.body.inputs?.[0]?.intent;
    console.log(`GOOGLE ${intent} for ${userId}`);

    if(intent==='action.devices.SYNC'){
      try{ await OfflineState.deleteMany({}); offlineDevices.clear(); await Device.updateMany({userId}, {offline:false}); }catch(e){}
      const userDevices = await Device.find({userId});
      console.log(`SYNC found ${userDevices.length} devices, forcing online`);
      const devices = userDevices.map(d=>{
        let traits = d.type==='FAN' ? ['action.devices.traits.OnOff','action.devices.traits.FanSpeed'] : d.type==='LIGHT' ? ['action.devices.traits.OnOff','action.devices.traits.Brightness','action.devices.traits.ColorSetting'] : ['action.devices.traits.OnOff'];
        let attrs = {};
        if(d.type==='LIGHT') attrs.colorModel='hsv';
        if(d.type==='FAN') attrs.availableFanSpeeds={speeds:[{speed_name:'low',speed_values:[{speed_synonym:['low','1'],lang:'en'}]},{speed_name:'medium',speed_values:[{speed_synonym:['medium','2'],lang:'en'}]},{speed_name:'high',speed_values:[{speed_synonym:['high','3'],lang:'en'}]}],ordered:true};
        return {id:(d.id||d.deviceId).toString(), type:d.type==='LIGHT'?'action.devices.types.LIGHT':d.type==='FAN'?'action.devices.types.FAN':'action.devices.types.SWITCH', traits, name:{defaultNames:[d.id], name:d.name, nicknames:[d.name]}, willReportState:false, attributes, deviceInfo:{manufacturer:'Thavayil Electronics', model:'v1', hwVersion:'1.0', swVersion:'1.0'}};
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
          let h=45, sat=1;
          if(d.color){ if(d.color.hue!==undefined) h=d.color.hue; if(d.color.saturation!==undefined){ sat=d.color.saturation; if(sat>1) sat=sat/100; } }
          s.brightness=bri;
          s.color={spectrumHsv:{hue:Math.round(h)%360, saturation:Math.max(0,Math.min(1,sat)), value:bri/100}};
        }
        states[q.id]=s;
      }
      console.log('QUERY RESP', JSON.stringify(states).substring(0,600));
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
            if(ex.command==='action.devices.commands.BrightnessAbsolute'){ const b=Math.max(5,Math.min(100, parseInt(p.brightness))); d.brightness=b; if(!d.color) d.color={hue:45,saturation:1,brightness:b}; d.color.brightness=b; d.state='ON'; ns.brightness=b; ns.on=true; }
            if(ex.command==='action.devices.commands.ColorAbsolute' && p.color?.spectrumHSV){
              const hsv=p.color.spectrumHSV;
              let b=Math.round(Math.max(0.05,Math.min(1,parseFloat(hsv.value)))*100); b=Math.max(5,b);
              d.color={hue:Math.round(hsv.hue)%360, saturation:Math.max(0,Math.min(1, parseFloat(hsv.saturation)>1?parseFloat(hsv.saturation)/100:parseFloat(hsv.saturation))), brightness:b};
              d.brightness=b; d.state='ON'; ns.color={spectrumHsv:{hue:d.color.hue, saturation:d.color.saturation, value:b/100}}; ns.brightness=b; ns.on=true;
            }
          }
          d.offline=false;
          await d.save();
          io.to('user_'+userId).emit('device_updated', d);
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

// --- ALEXA ---
app.post('/alexa/smarthome', async (req,res)=>{
  try{
    const auth=req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let dec; try{ dec=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
    const userId=dec.userId;
    const header=req.body.directive.header;
    const ns=header.namespace, name=header.name;
    console.log(`ALEXA ${ns} ${name} for ${userId}`);

    if(ns==='Alexa.Discovery' && name==='Discover'){
      const devs=await Device.find({userId});
      const endpoints=devs.map(d=>{
        let caps=[{type:'AlexaInterface', interface:'Alexa', version:'3'}, {type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true}}];
        if(d.type==='LIGHT'){
          caps.push({type:'AlexaInterface', interface:'Alexa.BrightnessController', version:'3', properties:{supported:[{name:'brightness'}], proactivelyReported:true, retrievable:true}});
          caps.push({type:'AlexaInterface', interface:'Alexa.ColorController', version:'3', properties:{supported:[{name:'color'}], proactivelyReported:true, retrievable:true}});
        }
        if(d.type==='FAN'){
          caps.push({type:'AlexaInterface', interface:'Alexa.RangeController', instance:'FanSpeed', version:'3', properties:{supported:[{name:'rangeValue'}], proactivelyReported:true, retrievable:true}, capabilityResources:{friendlyNames:[{type:'asset', value:{assetId:'Alexa.Setting.FanSpeed'}}]}, configuration:{supportedRange:{minimumValue:1, maximumValue:5, precision:1}}});
        }
        return {endpointId:d.id, manufacturerName:'Thavayil', description:d.type+' '+d.name, friendlyName:d.name, displayCategories:[d.type==='LIGHT'?'LIGHT':d.type==='FAN'?'FAN':'SWITCH'], capabilities:caps};
      });
      return res.json({event:{header:{namespace:'Alexa.Discovery', name:'Discover.Response', payloadVersion:'3', messageId:header.messageId}, payload:{endpoints}}});
    }

    if(ns==='Alexa.PowerController'){
      const eid=req.body.directive.endpoint.endpointId;
      let dev=await Device.findOne({id:eid, userId}); if(dev){ dev.state=(name==='TurnOn'?'ON':'OFF'); dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); }
      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}});
    }

    if(ns==='Alexa.BrightnessController'){
      const eid=req.body.directive.endpoint.endpointId;
      const b=req.body.directive.payload.brightness;
      let dev=await Device.findOne({id:eid, userId}); if(dev){ const bb=Math.max(5,Math.min(100, parseInt(b))); dev.brightness=bb; if(!dev.color) dev.color={hue:45,saturation:1,brightness:bb}; dev.color.brightness=bb; dev.state='ON'; dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.BrightnessController', name:'brightness', value:bb, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}}); }
    }

    if(ns==='Alexa.ColorController' && name==='SetColor'){
      const eid=req.body.directive.endpoint.endpointId;
      const col=req.body.directive.payload.color;
      console.log('ALEXA SetColor', col);
      let dev=await Device.findOne({id:eid, userId});
      if(dev){
        let b=dev.brightness||100; if(col.brightness!==undefined){ b=Math.round(Math.max(0.05,Math.min(1,col.brightness))*100); b=Math.max(5,b); }
        dev.color={hue:Math.round(col.hue)%360, saturation:parseFloat(col.saturation)>1?parseFloat(col.saturation)/100:parseFloat(col.saturation), brightness:b};
        dev.brightness=b; dev.state='ON'; dev.offline=false;
        await dev.save(); io.to('user_'+userId).emit('device_updated', dev);
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.ColorController', name:'color', value:{hue:dev.color.hue, saturation:dev.color.saturation, brightness:b/100}, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
      }
    }

    return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:req.body.directive.endpoint, payload:{}}});
  }catch(e){ console.log('ALEXA ERR', e.message); res.status(500).json({error:e.message}); }
});

app.get('/privacy', (req,res)=> res.send('Privacy Policy - Thavayil SmartHome V58'));
app.get('/', (req,res)=> res.send('<h1>Thavayil SmartHome V58_CLEAN_FINAL LIVE</h1><p><a href="/test/version">/test/version</a></p>'));

const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=> console.log(`Thavayil SmartHome V58_CLEAN_FINAL Port ${PORT}`));
