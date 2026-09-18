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

// ============= MONGODB SETUP =============
const MONGO_URL = process.env.MONGODB_URI;
if(!MONGO_URL) console.log("WARNING: MONGODB_URI not set!");

mongoose.connect(MONGO_URL).then(()=> console.log("MongoDB Connected - Permanent DB")).catch(e=> console.log(e));

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

async function getUserDevices(userId){
  return await Device.find({ userId });
}

async function emitDevice(userId, dev){
  const userDevices = await getUserDevices(userId);
  io.to('user_'+userId).emit('device_updated', dev);
  io.to('user_'+userId).emit('devices_updated_single', dev);
  io.to('user_'+userId).emit('devices_updated', userDevices);
  sendAlexaChangeReport(userId, dev);
}

async function sendAlexaChangeReport(userId, dev){
  try{
    const token = alexaTokens[userId];
    if(!token) return;
    const https = require('https');
    let properties = [];
    properties.push({namespace:'Alexa.PowerController',name:'powerState',value:dev.state==='ON'?'ON':'OFF',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    if(dev.type==='LIGHT' && dev.brightness!==undefined){
      properties.push({namespace:'Alexa.BrightnessController',name:'brightness',value:dev.brightness,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    }
    if(dev.type==='LIGHT' && dev.color){
      properties.push({namespace:'Alexa.ColorController',name:'color',value:{hue:dev.color.hue,saturation:dev.color.saturation,brightness:dev.color.brightness/100},timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    }
    if(dev.type==='FAN' && dev.speed){
      properties.push({namespace:'Alexa.PercentageController',name:'percentage',value:dev.speed*20,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
    }
    const event = {
      context:{properties},
      event:{
        header:{namespace:'Alexa',name:'ChangeReport',payloadVersion:'3',messageId:Date.now().toString()},
        endpoint:{endpointId:dev.id,scope:{type:'BearerToken',token}},
        payload:{change:{cause:{type:'APP_INTERACTION'},properties}}
      }
    };
    const data = JSON.stringify(event);
    const endpoints = ['api.amazonalexa.com', 'api.eu.amazonalexa.com'];
    endpoints.forEach(hostname => {
      const options = {
        hostname, path:'/v3/events', method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'Content-Length':Buffer.byteLength(data)}
      };
      const req = https.request(options, res=>{
        let b=''; res.on('data',d=>b+=d); res.on('end',()=>console.log(`Proactive report ${hostname} for ${dev.id} -> ${res.statusCode}`));
      });
      req.on('error',e=>console.log(`Proactive report error ${hostname}`,e.message));
      req.write(data); req.end();
    });
  }catch(e){ console.log('sendAlexaChangeReport error',e.message); }
}

function hexToHsb(hex){
  if(!hex) return {hue:45,saturation:1,brightness:100};
  hex=hex.replace('#',''); const r=parseInt(hex.slice(0,2),16)/255,g=parseInt(hex.slice(2,4),16)/255,b=parseInt(hex.slice(4,6),16)/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min; let h=0;
  if(d!==0){ if(max===r) h=((g-b)/d)%6; else if(max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0) h+=360; }
  const s=max===0?0:d/max; const v=max*100; return {hue:Math.round(h),saturation:parseFloat(s.toFixed(2)),brightness:Math.round(v)};
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

app.get('/privacy',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px;font-family:sans-serif;line-height:1.6"><h1>Thavayil Electronics - SmartHome Privacy Policy</h1><p>Last updated: 2026</p><h2>1. Data Collection</h2><p>We collect email and device states.</p><h2>2. Use</h2><p>Used only for smart home control.</p><h2>3. Alexa</h2><p>Token stored for proactive reports.</p><h2>4. Security</h2><p>Passwords stored securely, JWT signed.</p><h2>5. Contact</h2><p>thavayil.ckm@gmail.com, Kodancherry, Kerala, India</p></div>`); });
app.get('/terms',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px;font-family:sans-serif"><h1>Terms of Use</h1><p>Thavayil SmartHome is provided as-is.</p></div>`); });
app.get('/support',(req,res)=>{ res.send(`<div style="max-width:800px;margin:40px auto;padding:20px;font-family:sans-serif"><h1>Support</h1><p>thavayil.ckm@gmail.com<br>https://thavayil-smarthome.onrender.com</p></div>`); });

// AUTH
app.post('/auth/register', async (req,res)=>{
  const {email,password}=req.body;
  if(!email||!password) return res.status(400).json({error:'email pass required'});
  if(await User.findOne({email})) return res.status(400).json({error:'user exists, login'});
  const user={id:Date.now().toString(),email,password};
  await User.create(user);
  const token=jwt.sign({userId:user.id,email}, JWT_SECRET_NEW, {noTimestamp:true});
  res.json({token,userId:user.id});
});
app.post('/auth/login', async (req,res)=>{
  const user=await User.findOne({email:req.body.email, password:req.body.password});
  if(!user) return res.status(401).json({error:'invalid login'});
  const token=jwt.sign({userId:user.id,email:user.email}, JWT_SECRET_NEW, {noTimestamp:true});
  res.json({token,userId:user.id});
});

// OAUTH FOR ALEXA
app.get('/oauth/authorize',(req,res)=>{
  const {redirect_uri,state}=req.query;
  res.send(`<div style="font-family:sans-serif;padding:40px;max-width:400px;margin:60px auto;background:#14141e;color:#fff;border-radius:20px;text-align:center"><h2>Thavayil SmartHome</h2><p>Link to Alexa</p><form method="POST" action="/oauth/authorize?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}"><input name="email" placeholder="Email" style="width:100%;padding:12px;margin:8px 0;border-radius:10px;border:0"/><br/><input name="password" type="password" placeholder="Password" style="width:100%;padding:12px;margin:8px 0;border-radius:10px;border:0"/><br/><button style="width:100%;padding:14px;background:#00d9ff;color:#000;border-radius:10px;border:0;font-weight:700;margin-top:10px">Link Account</button></form></div>`);
});
app.post('/oauth/authorize', async (req,res)=>{
  const user=await User.findOne({email:req.body.email, password:req.body.password});
  if(!user) return res.send('Invalid credentials <a href="javascript:history.back()">Back</a>');
  const code=Math.random().toString(36).substring(8);
  await Code.create({code,userId:user.id,exp:Date.now()+600000});
  res.redirect(`${req.query.redirect_uri}?code=${code}&state=${req.query.state}`);
});
app.post('/oauth/token', async (req,res)=>{
  const entry=await Code.findOne({code:req.body.code});
  if(!entry) return res.status(400).json({error:'invalid code'});
  const token=jwt.sign({userId:entry.userId}, JWT_SECRET_NEW, {noTimestamp:true});
  res.json({access_token:token,refresh_token:token,token_type:'Bearer',expires_in:31536000});
});

function authMiddleware(req,res,next){
  try{
    const token=req.headers.authorization?.replace('Bearer ','');
    if(!token) throw new Error('no token');
    req.user=verifyToken(token); next();
  }catch(e){ res.status(401).json({error:'unauth - login again'}); }
}

// DEVICES API
app.get('/api/devices', authMiddleware, async (req,res)=>{
  const devs=await Device.find({userId:req.user.userId});
  res.json(devs);
});
app.post('/api/devices', authMiddleware, async (req,res)=>{
  const {name,type,id,color,brightness,speed}=req.body;
  if(!name||!type) return res.status(400).json({error:'name type required'});
  const deviceId=id||type.toLowerCase()+'_'+Date.now().toString().slice(-4);
  const upper=type.toUpperCase(); let cat=upper==='LIGHT'?'LIGHT':upper==='FAN'?'FAN':'SWITCH';
  let dev={id:deviceId,deviceId,userId:req.user.userId,name,type:upper,displayCategory:cat,state:'OFF',createdAt:new Date().toISOString()};
  if(upper==='LIGHT'){
    let hsb={hue:45,saturation:1,brightness:100};
    if(color&&typeof color==='object'&&color.hue!==undefined) hsb={hue:parseInt(color.hue),saturation:parseFloat(color.saturation),brightness:parseInt(color.brightness||100)};
    else if(typeof color==='string'&&color) hsb=hexToHsb(color);
    if(brightness) hsb.brightness=parseInt(brightness);
    dev.color=hsb; dev.brightness=hsb.brightness;
  }else if(upper==='FAN'){ dev.speed=speed?parseInt(speed):3; }
  const created = await Device.create(dev);
  await emitDevice(req.user.userId, created);
  res.json(created);
});
app.delete('/api/devices/:id', authMiddleware, async (req,res)=>{
  await Device.deleteOne({id:req.params.id, userId:req.user.userId});
  io.to('user_'+req.user.userId).emit('device_deleted',{id:req.params.id});
  res.json({success:true});
});
app.post('/api/device/control', authMiddleware, async (req,res)=>{
  const {deviceId,action,color,brightness,speed}=req.body;
  let hsb=null;
  if(color&&typeof color==='object'&&color.hue!==undefined) hsb={hue:parseInt(color.hue),saturation:parseFloat(color.saturation),brightness:parseInt(color.brightness||100)};
  let dev=await Device.findOne({id:deviceId, userId:req.user.userId});
  if(dev){
    if(action==='TurnOn') dev.state='ON';
    if(action==='TurnOff') dev.state='OFF';
    if(hsb&&dev.type==='LIGHT'){ dev.color=hsb; dev.brightness=hsb.brightness; }
    if(brightness!==undefined&&dev.type==='LIGHT'){ if(!dev.color) dev.color={hue:45,saturation:1,brightness:100}; dev.color.brightness=parseInt(brightness); dev.brightness=parseInt(brightness); if(!action) dev.state='ON'; }
    if(speed!==undefined&&dev.type==='FAN'){ dev.speed=parseInt(speed); dev.state='ON'; }
    await dev.save();
    await emitDevice(req.user.userId, dev);
    io.to('user_'+req.user.userId).emit('alexa_cmd',{deviceId,action:action||'TurnOn',color:hsb,brightness,speed});
  }
  res.json({success:true,device:dev});
});

// ALEXA SMART HOME
app.post('/alexa/smarthome', async (req,res)=>{
  try{
    const auth=req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let decoded; try{ decoded=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
    const userId=decoded.userId;
    const directive=req.body.directive;
    if(!directive) return res.status(400).json({error:'no directive'});
    const header=directive.header; const ns=header.namespace; const name=header.name;
    try{
      let alexaToken = directive.payload?.scope?.token || directive.endpoint?.scope?.token || token;
      if(alexaToken) alexaTokens[userId]=alexaToken;
    }catch(e){}

    if(ns==='Alexa.Authorization' && name==='AcceptGrant'){
      return res.json({event:{header:{namespace:'Alexa.Authorization',name:'AcceptGrant.Response',payloadVersion:'3',messageId:header.messageId},payload:{}}});
    }
    if(ns==='Alexa.Discovery' && name==='Discover'){
      const userDevices=await Device.find({userId});
      const endpoints=userDevices.map(d=>{
        let caps=[
          {type:'AlexaInterface',interface:'Alexa',version:'3'},
          {type:'AlexaInterface',interface:'Alexa.PowerController',version:'3',properties:{supported:[{name:'powerState'}],proactivelyReported:true,retrievable:true}}
        ];
        if(d.type==='LIGHT'){
          caps.push({type:'AlexaInterface',interface:'Alexa.BrightnessController',version:'3',properties:{supported:[{name:'brightness'}],proactivelyReported:true,retrievable:true}});
          caps.push({type:'AlexaInterface',interface:'Alexa.ColorController',version:'3',properties:{supported:[{name:'color'}],proactivelyReported:true,retrievable:true}});
        }
        if(d.type==='FAN'){
          caps.push({type:'AlexaInterface',interface:'Alexa.PercentageController',version:'3',properties:{supported:[{name:'percentage'}],proactivelyReported:true,retrievable:true}});
        }
        return {
          endpointId:d.id, manufacturerName:'Thavayil Electronics', friendlyName:d.name,
          description:`${d.type} via Thavayil SmartHome`, displayCategories:[d.displayCategory||'SWITCH'], capabilities:caps
        };
      });
      return res.json({event:{header:{namespace:'Alexa.Discovery',name:'Discover.Response',payloadVersion:'3',messageId:header.messageId},payload:{endpoints}}});
    }
    if(ns==='Alexa.PowerController'){
      const endpointId=directive.endpoint.endpointId;
      const action=name==='TurnOn'?'TurnOn':'TurnOff';
      let dev=await Device.findOne({id:endpointId, userId});
      if(dev){ dev.state=action==='TurnOn'?'ON':'OFF'; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action}); }
      return res.json({
        event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},
        context:{properties:[{namespace:'Alexa.PowerController',name:'powerState',value:action==='TurnOn'?'ON':'OFF',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}
      });
    }
    if(ns==='Alexa.BrightnessController'){
      const endpointId=directive.endpoint.endpointId;
      let dev=await Device.findOne({id:endpointId, userId});
      let brightness = directive.payload.brightness;
      if(name==='AdjustBrightness' && dev){
         let delta = directive.payload.brightnessDelta || 0;
         let current = dev.brightness || 50;
         brightness = Math.min(100, Math.max(1, current + delta));
      }
      if(dev){ dev.state='ON'; dev.brightness=brightness; if(!dev.color) dev.color={hue:45,saturation:1,brightness:100}; dev.color.brightness=brightness; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action:'SetBrightness',brightness}); }
      return res.json({
        event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},
        context:{properties:[
          {namespace:'Alexa.PowerController',name:'powerState',value:'ON',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500},
          {namespace:'Alexa.BrightnessController',name:'brightness',value:brightness,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}
        ]}
      });
    }
    if(ns==='Alexa.ColorController' && name==='SetColor'){
      const endpointId=directive.endpoint.endpointId;
      const color=directive.payload.color;
      let h=Math.round(color.hue); let s=parseFloat(color.saturation); let b=Math.round((color.brightness||1)*100);
      let dev=await Device.findOne({id:endpointId, userId});
      if(dev){ dev.state='ON'; dev.color={hue:h,saturation:s,brightness:b}; dev.brightness=b; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action:'SetColor',color:{hue:h,saturation:s,brightness:b}}); }
      return res.json({
        event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},
        context:{properties:[{namespace:'Alexa.ColorController',name:'color',value:{hue:h,saturation:s,brightness:color.brightness},timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}
      });
    }
    if(ns==='Alexa.PercentageController'){
      const endpointId=directive.endpoint.endpointId;
      const perc=directive.payload.percentage;
      let speed=Math.ceil(perc/20); if(speed<1) speed=1; if(speed>5) speed=5;
      let dev=await Device.findOne({id:endpointId, userId});
      if(dev){ dev.state='ON'; dev.speed=speed; await dev.save(); await emitDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId,action:'SetSpeed',speed}); }
      return res.json({
        event:{header:{namespace:'Alexa',name:'Response',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}},
        context:{properties:[{namespace:'Alexa.PercentageController',name:'percentage',value:perc,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500}]}
      });
    }
    if(ns==='Alexa' && name==='ReportState'){
      const endpointId=directive.endpoint.endpointId;
      let dev=await Device.findOne({id:endpointId, userId});
      if(!dev) dev=await Device.findOne({id:endpointId});
      let props=[];
      if(dev){
        props.push({namespace:'Alexa.PowerController',name:'powerState',value:dev.state==='ON'?'ON':'OFF',timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
        if(dev.brightness!==undefined && dev.brightness!==null) props.push({namespace:'Alexa.BrightnessController',name:'brightness',value:parseInt(dev.brightness),timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
        if(dev.color) props.push({namespace:'Alexa.ColorController',name:'color',value:{hue:dev.color.hue||0,saturation:dev.color.saturation||0,brightness:(dev.color.brightness||100)/100},timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
        if(dev.speed!==undefined) props.push({namespace:'Alexa.PercentageController',name:'percentage',value:(dev.speed||3)*20,timeOfSample:new Date().toISOString(),uncertaintyInMilliseconds:500});
      }
      return res.json({context:{properties:props},event:{header:{namespace:'Alexa',name:'StateReport',payloadVersion:'3',messageId:header.messageId,correlationToken:header.correlationToken},endpoint:{endpointId},payload:{}}});
    }
    res.status(400).json({error:'unsupported',ns,name});
  }catch(e){
    console.error('ALEXA ERROR',e);
    res.status(500).json({error:e.message});
  }
});


// SOCKET.IO
io.use((socket,next)=>{
  try{
    const token=socket.handshake.auth?.token || socket.handshake.query?.token;
    if(!token) throw new Error('no token');
    const dec=verifyToken(token);
    socket.userId=dec.userId; next();
  }catch(e){ next(new Error('auth failed: '+e.message)); }
});
io.on('connection', async (socket)=>{
  console.log('ESP/DASHBOARD connected user:',socket.userId);
  socket.join('user_'+socket.userId);
  const userDevs=await Device.find({userId:socket.userId});
  socket.emit('devices_updated', userDevs);
  socket.on('disconnect',()=>console.log('Disconnected',socket.userId));
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Thavayil SmartHome MONGODB - Port ${PORT}`));
