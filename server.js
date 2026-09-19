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

const MONGO_URL = process.env.MONGODB_URI;
if(!MONGO_URL) console.log("WARNING: MONGODB_URI not set!");
mongoose.connect(MONGO_URL).then(()=> console.log("MongoDB Connected - Permanent DB")).catch(e=> console.log("MongoDB Error:", e.message));

const UserSchema = new mongoose.Schema({ id: String, email: {type:String, unique:true}, password: String });
const CodeSchema = new mongoose.Schema({ code: String, userId: String, exp: Number });
const DeviceSchema = new mongoose.Schema({
  id: {type:String, unique:true},
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

function verifyToken(t){
  try{ return jwt.verify(t, JWT_SECRET_NEW); }
  catch(e){ return jwt.verify(t, JWT_SECRET_OLD); }
}

let alexaTokens = {};
let googleTokens = {};

async function getUserDevices(userId){
  try{ return await Device.find({ userId }); }catch(e){ return []; }
}
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
    const token = googleTokens[userId]; if(!token) return;
    // Google ReportState - optional, requires service account. We will use requestSync instead via Homegraph API if needed.
    // For now just log - Google will QUERY after EXECUTE anyway.
    console.log(`Google device updated ${dev.id} state ${dev.state}`);
  }catch(e){}
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

app.get('/privacy',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px;font-family:sans-serif"><h1>Privacy Policy - Thavayil SmartHome</h1><p>We collect email and device states for smart home control. Contact: thavayil.ckm@gmail.com</p></div>`); });
app.get('/terms',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px"><h1>Terms</h1></div>`); });
app.get('/support',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px"><h1>Support - thavayil.ckm@gmail.com</h1><p>https://thavayil-smarthome.onrender.com</p></div>`); });
app.get('/health',(req,res)=>{ res.json({status:'ok', mongo: mongoose.connection.readyState===1?'connected':'disconnected'}); });

// AUTH
app.post('/auth/register', async (req,res)=>{
  try{
    const {email,password}=req.body;
    if(!email||!password) return res.status(400).json({error:'email pass required'});
    if(mongoose.connection.readyState!==1) return res.status(500).json({error:'database not ready, wait 10 sec'});
    if(await User.findOne({email})) return res.status(400).json({error:'user exists, please login'});
    const user={id:Date.now().toString(),email,password};
    await User.create(user);
    const token=jwt.sign({userId:user.id,email}, JWT_SECRET_NEW, {noTimestamp:true});
    res.json({token,userId:user.id});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/auth/login', async (req,res)=>{
  try{
    if(mongoose.connection.readyState!==1) return res.status(500).json({error:'database not ready'});
    const user=await User.findOne({email:req.body.email, password:req.body.password});
    if(!user) return res.status(401).json({error:'invalid login - register first'});
    const token=jwt.sign({userId:user.id,email:user.email}, JWT_SECRET_NEW, {noTimestamp:true});
    res.json({token,userId:user.id});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// OAUTH FOR BOTH ALEXA & GOOGLE
app.get('/oauth/authorize',(req,res)=>{
  const {redirect_uri,state,client_id}=req.query;
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#08080c;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#14141e;padding:28px;border-radius:24px;width:360px}input{width:100%;padding:14px;margin:8px 0;border-radius:12px;border:1px solid #333;background:#0d0d13;color:#fff;box-sizing:border-box}button{width:100%;padding:14px;background:#fff;color:#000;border:0;border-radius:12px;font-weight:700;margin-top:12px;cursor:pointer}</style></head><body><div class="card"><h2>Thavayil SmartHome</h2><p style="color:#999;font-size:13px">Link your account to ${client_id?.includes('google')?'Google Home':'Alexa'}</p><form method="POST" action="/oauth/authorize?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}"><input name="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button type="submit">Link Account</button></form></div></body></html>`);
});
app.post('/oauth/authorize', async (req,res)=>{
  try{
    const user=await User.findOne({email:req.body.email, password:req.body.password});
    if(!user) return res.send('Invalid credentials <a href="javascript:history.back()">Back</a>');
    const code=Math.random().toString(36).substring(10);
    await Code.create({code,userId:user.id,exp:Date.now()+600000});
    res.redirect(`${req.query.redirect_uri}?code=${code}&state=${req.query.state}`);
  }catch(e){ res.send('Error: '+e.message); }
});
app.post('/oauth/token', async (req,res)=>{
  try{
    const entry=await Code.findOne({code:req.body.code});
    if(!entry) return res.status(400).json({error:'invalid code'});
    const token=jwt.sign({userId:entry.userId}, JWT_SECRET_NEW, {noTimestamp:true});
    res.json({access_token:token,refresh_token:token,token_type:'Bearer',expires_in:31536000});
  }catch(e){ res.status(500).json({error:e.message}); }
});

function authMiddleware(req,res,next){
  try{
    const token=req.headers.authorization?.replace('Bearer ','');
    if(!token) throw new Error('no token');
    req.user=verifyToken(token); next();
  }catch(e){ res.status(401).json({error:'unauth - login again'}); }
}

// DEVICE APIS
app.get('/api/devices', authMiddleware, async (req,res)=>{
  try{ const devs=await Device.find({userId:req.user.userId}); res.json(devs); }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/devices', authMiddleware, async (req,res)=>{
  try{
    const {name,type,id,color,brightness,speed}=req.body;
    if(!name||!type) return res.status(400).json({error:'name type required'});
    const deviceId=id||type.toLowerCase()+'_'+Date.now().toString().slice(-4);
    const upper=type.toUpperCase(); let cat=upper==='LIGHT'?'LIGHT':upper==='FAN'?'FAN':'SWITCH';
    let dev={id:deviceId,deviceId,userId:req.user.userId,name,type:upper,displayCategory:cat,state:'OFF',createdAt:new Date().toISOString()};
    if(upper==='LIGHT'){
      let hsb={hue:45,saturation:1,brightness:100};
      if(color&&typeof color==='object'&&color.hue!==undefined) hsb=color;
      if(brightness) hsb.brightness=parseInt(brightness);
      dev.color=hsb; dev.brightness=hsb.brightness;
    }else if(upper==='FAN'){ dev.speed=speed?parseInt(speed):3; }
    const created = await Device.create(dev);
    await emitDevice(req.user.userId, created);
    res.json(created);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/devices/:id', authMiddleware, async (req,res)=>{
  try{ await Device.deleteOne({id:req.params.id, userId:req.user.userId}); io.to('user_'+req.user.userId).emit('device_deleted',{id:req.params.id}); res.json({success:true}); }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/device/control', authMiddleware, async (req,res)=>{
  try{
    const {deviceId,action,color,brightness,speed}=req.body;
    let dev=await Device.findOne({id:deviceId, userId:req.user.userId});
    if(!dev) dev=await Device.findOne({deviceId, userId:req.user.userId});
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

// ==================== ALEXA SMART HOME ====================
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

// ==================== GOOGLE HOME SMART HOME ====================
function googleDeviceTraits(d){
  let traits = ['action.devices.traits.OnOff'];
  if(d.type==='LIGHT'){ traits.push('action.devices.traits.Brightness','action.devices.traits.ColorSetting'); }
  if(d.type==='FAN'){ traits.push('action.devices.traits.FanSpeed'); }
  return traits;
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
    try{ googleTokens[userId]=token; }catch(e){}
    const requestId = req.body.requestId;
    const intent = req.body.inputs?.[0]?.intent;
    console.log(`GOOGLE ${intent} for user ${userId}`);

    if(intent==='action.devices.SYNC'){
      const userDevices=await Device.find({userId});
      const devices=userDevices.map(d=>{
        let traits = googleDeviceTraits(d);
        let attributes = {};
        if(d.type==='LIGHT'){ attributes.colorModel='hsv'; }
        if(d.type==='FAN'){ attributes.availableFanSpeeds={speeds:[{speed_name:'Low',speed_values:[{speed_synonym:['low','1'],lang:'en'},{speed_synonym:['1'],lang:'en'}]},{speed_name:'Medium',speed_values:[{speed_synonym:['medium','2','3'],lang:'en'}]},{speed_name:'High',speed_values:[{speed_synonym:['high','4','5'],lang:'en'}]}], ordered:true}; attributes.reversible=false; }
        return {
          id:d.id,
          type: googleDeviceType(d),
          traits,
          name:{defaultNames:[d.deviceId], name:d.name, nicknames:[d.name]},
          willReportState:false,
          attributes,
          deviceInfo:{manufacturer:'Thavayil Electronics', model:'SmartHome v2', hwVersion:'1.0', swVersion:'1.0'}
        };
      });
      return res.json({requestId, payload:{agentUserId:userId, devices}});
    }

    if(intent==='action.devices.QUERY'){
      const payloadDevices = req.body.inputs[0].payload.devices;
      const userDevices=await Device.find({userId});
      let devicesState = {};
      for(const q of payloadDevices){
        const d = userDevices.find(x=>x.id===q.id);
        if(!d){ devicesState[q.id]={online:false}; continue; }
        let state = {online:true, on: d.state==='ON'};
        if(d.type==='LIGHT' && d.brightness!==undefined) state.brightness = d.brightness;
        if(d.type==='LIGHT' && d.color){
          // Google wants color.spectrumHsv hue 0-360, sat 0-1, value 0-1
          state.color={spectrumHsv:{hue:d.color.hue, saturation:d.color.saturation, value:(d.color.brightness||100)/100}};
        }
        if(d.type==='FAN' && d.speed!==undefined){
          const map = {1:'Low',2:'Medium',3:'Medium',4:'High',5:'High'};
          state.currentFanSpeedSetting = map[d.speed]||'Medium';
        }
        devicesState[q.id]=state;
      }
      return res.json({requestId, payload:{devices:devicesState}});
    }

    if(intent==='action.devices.EXECUTE'){
      const commands = req.body.inputs[0].payload.commands;
      let results = [];
      for(const cmd of commands){
        for(const devReq of cmd.devices){
          const id = devReq.id;
          let dev=await Device.findOne({id, userId});
          if(!dev) dev=await Device.findOne({deviceId:id, userId});
          if(!dev) { results.push({ids:[id], status:'ERROR', errorCode:'deviceNotFound'}); continue; }
          let newState = {online:true};
          for(const ex of cmd.execution){
            const params = ex.params;
            switch(ex.command){
              case 'action.devices.commands.OnOff':
                dev.state = params.on ? 'ON' : 'OFF';
                newState.on = params.on;
                io.to('user_'+userId).emit('alexa_cmd',{deviceId:id, action: params.on?'TurnOn':'TurnOff'});
                break;
              case 'action.devices.commands.BrightnessAbsolute':
                dev.brightness = params.brightness;
                if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
                dev.color.brightness = params.brightness;
                dev.state='ON';
                newState.brightness = params.brightness;
                newState.on = true;
                io.to('user_'+userId).emit('alexa_cmd',{deviceId:id, action:'SetBrightness', brightness:params.brightness});
                break;
              case 'action.devices.commands.ColorAbsolute':
                if(params.color && params.color.spectrumHSV){
                  const hsv = params.color.spectrumHSV;
                  dev.color = {hue: Math.round(hsv.hue), saturation: parseFloat(hsv.saturation), brightness: Math.round((hsv.value||1)*100)};
                  dev.brightness = dev.color.brightness;
                  dev.state='ON';
                  newState.color = {spectrumHsv:{hue:dev.color.hue, saturation:dev.color.saturation, value:hsv.value}};
                  newState.on = true;
                  io.to('user_'+userId).emit('alexa_cmd',{deviceId:id, action:'SetColor', color:dev.color});
                }
                break;
              case 'action.devices.commands.SetFanSpeed':
                const speedMap = {Low:1, Medium:3, High:5, 'low':1, 'medium':3, 'high':5};
                let speedNum = speedMap[params.fanSpeed] || 3;
                if(params.fanSpeed==='Low') speedNum=1;
                if(params.fanSpeed==='Medium') speedNum=3;
                if(params.fanSpeed==='High') speedNum=5;
                dev.speed = speedNum;
                dev.state='ON';
                newState.currentFanSpeedSetting = params.fanSpeed;
                newState.on = true;
                io.to('user_'+userId).emit('alexa_cmd',{deviceId:id, action:'SetSpeed', speed:speedNum});
                break;
            }
          }
          await dev.save();
          await emitDevice(userId, dev);
          results.push({ids:[id], status:'SUCCESS', states:newState});
        }
      }
      return res.json({requestId, payload:{commands: results}});
    }

    res.status(400).json({error:'unsupported intent '+intent});
  }catch(e){
    console.error('GOOGLE ERROR',e);
    res.status(500).json({error:e.message});
  }
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
  try{
    const userDevs=await Device.find({userId:socket.userId});
    socket.emit('devices_updated', userDevs);
  }catch(e){}
  socket.on('disconnect',()=>console.log('Disconnected',socket.userId));
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Thavayil SmartHome ALEXA+GOOGLE - Port ${PORT}`));
