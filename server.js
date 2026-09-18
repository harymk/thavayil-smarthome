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

function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[], codes:[], devices:[]}, null, 2));
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!d.users) d.users = []; if (!d.codes) d.codes = []; if (!d.devices) d.devices = [];
    return d;
  } catch(e){ return {users:[], codes:[], devices:[]}; }
}
function writeDB(data){ fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

function verifyToken(token){
  try{ return jwt.verify(token, JWT_SECRET_NEW); }
  catch(e){ try{ return jwt.verify(token, JWT_SECRET_OLD); }catch(e2){ throw e2; } }
}

function emitSingleDevice(userId, device){
  io.to('user_'+userId).emit('device_updated', device);
  io.to('user_'+userId).emit('devices_updated_single', device);
}

function hexToHsb(hex){
  if(!hex) return {hue:0,saturation:1,brightness:100};
  hex=hex.replace('#',''); const r=parseInt(hex.slice(0,2),16)/255,g=parseInt(hex.slice(2,4),16)/255,b=parseInt(hex.slice(4,6),16)/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min; let h=0;
  if(d!==0){ if(max===r) h=((g-b)/d)%6; else if(max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0) h+=360; }
  const s=max===0?0:d/max; const v=max*100; return {hue:Math.round(h),saturation:parseFloat(s.toFixed(2)),brightness:Math.round(v)};
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// AUTH
app.post('/auth/register', (req,res)=>{
  const db=readDB(); const {email,password}=req.body;
  if(db.users.find(u=>u.email===email)) return res.status(400).json({error:'user exists'});
  const user={id:Date.now().toString(),email,password};
  db.users.push(user); writeDB(db);
  const token=jwt.sign({userId:user.id,email}, JWT_SECRET_NEW, {noTimestamp:true});
  res.json({token,userId:user.id});
});
app.post('/auth/login', (req,res)=>{
  const db=readDB(); const user=db.users.find(u=>u.email===req.body.email && u.password===req.body.password);
  if(!user) return res.status(401).json({error:'invalid'});
  const token=jwt.sign({userId:user.id,email:user.email}, JWT_SECRET_NEW, {noTimestamp:true});
  res.json({token,userId:user.id});
});
app.get('/oauth/authorize', (req,res)=>{
  const {redirect_uri,state}=req.query;
  res.send(`<div style="font-family:sans-serif;padding:40px;max-width:400px;margin:50px auto;background:#14141e;color:#fff;border-radius:16px"><h2>Thavayil SmartHome</h2><p>Link to Alexa</p><form method="POST" action="/oauth/authorize?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}"><input name="email" placeholder="Email" style="width:100%;padding:12px;margin:8px 0;border-radius:8px"/><br/><input name="password" type="password" placeholder="Password" style="width:100%;padding:12px;margin:8px 0;border-radius:8px"/><br/><button style="width:100%;padding:12px;background:#fff;color:#000;border-radius:8px;border:0;font-weight:600">Link Account</button></form></div>`);
});
app.post('/oauth/authorize', (req,res)=>{
  const db=readDB(); const user=db.users.find(u=>u.email===req.body.email && u.password===req.body.password);
  if(!user) return res.send('Invalid credentials <a href="javascript:history.back()">Back</a>');
  const code=Math.random().toString(36).substring(7);
  db.codes.push({code,userId:user.id,exp:Date.now()+600000}); writeDB(db);
  res.redirect(`${req.query.redirect_uri}?code=${code}&state=${req.query.state}`);
});
app.post('/oauth/token', (req,res)=>{
  const db=readDB(); const entry=db.codes.find(c=>c.code===req.body.code);
  if(!entry) return res.status(400).json({error:'invalid code'});
  const token=jwt.sign({userId:entry.userId}, JWT_SECRET_NEW, {noTimestamp:true});
  res.json({access_token:token,refresh_token:token,token_type:'Bearer',expires_in:31536000});
});

function authMiddleware(req,res,next){
  try{ const token=req.headers.authorization?.replace('Bearer ',''); req.user=verifyToken(token); next(); }
  catch(e){ res.status(401).json({error:'unauth'}); }
}

app.get('/api/devices', authMiddleware, (req,res)=>{
  const db=readDB(); res.json(db.devices.filter(d=>d.userId===req.user.userId));
});
app.post('/api/devices', authMiddleware, (req,res)=>{
  const db=readDB(); const {name,type,id,color,brightness,speed}=req.body;
  if(!name||!type) return res.status(400).json({error:'name type required'});
  const deviceId=id||type.toLowerCase()+'_'+Date.now().toString().slice(-4);
  const upper=type.toUpperCase(); let cat=upper==='LIGHT'?'LIGHT':upper==='FAN'?'FAN':'SWITCH';
  let dev={id:deviceId,deviceId,userId:req.user.userId,name,type:upper,displayCategory:cat,state:'OFF',createdAt:new Date().toISOString()};
  if(upper==='LIGHT'){ let hsb={hue:45,saturation:1,brightness:100}; if(color&&typeof color==='object'&&color.hue!==undefined) hsb={hue:parseInt(color.hue),saturation:parseFloat(color.saturation),brightness:parseInt(color.brightness||100)}; else if(typeof color==='string'&&color) hsb=hexToHsb(color); dev.color=hsb; dev.brightness=brightness?parseInt(brightness):hsb.brightness; } else if(upper==='FAN') dev.speed=speed?parseInt(speed):3;
  db.devices.push(dev); writeDB(db); emitSingleDevice(req.user.userId,dev); res.json(dev);
});
app.delete('/api/devices/:id', authMiddleware, (req,res)=>{
  const db=readDB(); db.devices=db.devices.filter(d=>!(d.id===req.params.id && d.userId===req.user.userId)); writeDB(db); io.to('user_'+req.user.userId).emit('device_deleted',{id:req.params.id}); res.json({success:true});
});
app.post('/api/device/control', authMiddleware, (req,res)=>{
  const db=readDB(); const {deviceId,action,color,brightness,speed}=req.body;
  let hsb=null; if(color&&typeof color==='object'&&color.hue!==undefined) hsb={hue:parseInt(color.hue),saturation:parseFloat(color.saturation),brightness:parseInt(color.brightness||100)};
  io.to('user_'+req.user.userId).emit('alexa_cmd',{deviceId,action,color:hsb,brightness,speed});
  let dev=db.devices.find(d=>d.id===deviceId && d.userId===req.user.userId);
  if(dev){ if(action==='TurnOn') dev.state='ON'; if(action==='TurnOff') dev.state='OFF'; if(hsb&&dev.type==='LIGHT') dev.color=hsb; if(brightness!==undefined&&dev.type==='LIGHT') dev.brightness=parseInt(brightness); if(speed!==undefined&&dev.type==='FAN') dev.speed=parseInt(speed); writeDB(db); emitSingleDevice(req.user.userId,dev); }
  res.json({success:true,device:dev});
});

// ================= ALEXA SMART HOME SKILL =================
app.post('/alexa/smarthome', async (req,res)=>{
  try{
    const auth = req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token = auth.replace('Bearer ','');
    const decoded = verifyToken(token);
    const userId = decoded.userId;
    const db = readDB();
    const directive = req.body.directive;
    if(!directive) return res.status(400).json({error:'no directive'});
    const header = directive.header;
    const ns = header.namespace;
    const name = header.name;

    // AcceptGrant
    if(ns === 'Alexa.Authorization' && name === 'AcceptGrant'){
      return res.json({ event: { header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant.Response', payloadVersion:'3', messageId: header.messageId }, payload: {} } });
    }

    // Discovery
    if(ns === 'Alexa.Discovery' && name === 'Discover'){
      const userDevices = db.devices.filter(d=>d.userId===userId);
      const endpoints = userDevices.map(d=>{
        let caps = [
          { type:'AlexaInterface', interface:'Alexa', version:'3' },
          { type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{ supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true } }
        ];
        if(d.type==='LIGHT'){
          caps.push({ type:'AlexaInterface', interface:'Alexa.BrightnessController', version:'3', properties:{ supported:[{name:'brightness'}], proactivelyReported:true, retrievable:true } });
          caps.push({ type:'AlexaInterface', interface:'Alexa.ColorController', version:'3', properties:{ supported:[{name:'color'}], proactivelyReported:true, retrievable:true } });
        }
        if(d.type==='FAN'){
          caps.push({ type:'AlexaInterface', interface:'Alexa.PercentageController', version:'3', properties:{ supported:[{name:'percentage'}], proactivelyReported:true, retrievable:true } });
        }
        return {
          endpointId: d.id,
          manufacturerName: 'Thavayil Electronics',
          friendlyName: d.name,
          description: `${d.type} via Thavayil SmartHome`,
          displayCategories: [d.displayCategory||'SWITCH'],
          capabilities: caps
        };
      });
      return res.json({
        event: { header:{ namespace:'Alexa.Discovery', name:'Discover.Response', payloadVersion:'3', messageId: header.messageId }, payload:{ endpoints } }
      });
    }

    // Power Control
    if(ns === 'Alexa.PowerController'){
      const endpointId = directive.endpoint.endpointId;
      const action = name==='TurnOn'?'TurnOn':'TurnOff';
      let dev = db.devices.find(d=>d.id===endpointId && d.userId===userId);
      if(dev){ dev.state = action==='TurnOn'?'ON':'OFF'; writeDB(db); emitSingleDevice(userId, dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId, action}); }
      return res.json({
        event:{ header:{ namespace:'Alexa', name:'Response', payloadVersion:'3', messageId: header.messageId, correlationToken: header.correlationToken }, endpoint:{ endpointId }, payload:{} },
        context:{ properties:[{ namespace:'Alexa.PowerController', name:'powerState', value: action==='TurnOn'?'ON':'OFF', timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 }] }
      });
    }

    // Brightness
    if(ns === 'Alexa.BrightnessController'){
      const endpointId = directive.endpoint.endpointId;
      const brightness = directive.payload.brightness;
      let dev = db.devices.find(d=>d.id===endpointId && d.userId===userId);
      if(dev){ dev.state='ON'; dev.brightness=brightness; if(!dev.color) dev.color={hue:0,saturation:0,brightness}; dev.color.brightness=brightness; writeDB(db); emitSingleDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId, action:'SetBrightness', brightness}); }
      return res.json({
        event:{ header:{ namespace:'Alexa', name:'Response', payloadVersion:'3', messageId: header.messageId, correlationToken: header.correlationToken }, endpoint:{ endpointId }, payload:{} },
        context:{ properties:[{ namespace:'Alexa.BrightnessController', name:'brightness', value: brightness, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 }] }
      });
    }

    // Color
    if(ns === 'Alexa.ColorController' && name==='SetColor'){
      const endpointId = directive.endpoint.endpointId;
      const color = directive.payload.color;
      // Alexa sends HSB: hue 0-360, saturation 0-1, brightness 0-1
      let h = Math.round(color.hue);
      let s = parseFloat(color.saturation);
      let b = Math.round((color.brightness||1)*100);
      let dev = db.devices.find(d=>d.id===endpointId && d.userId===userId);
      if(dev){ dev.state='ON'; dev.color={hue:h,saturation:s,brightness:b}; dev.brightness=b; writeDB(db); emitSingleDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId, action:'SetColor', color:{hue:h,saturation:s,brightness:b}}); }
      return res.json({
        event:{ header:{ namespace:'Alexa', name:'Response', payloadVersion:'3', messageId: header.messageId, correlationToken: header.correlationToken }, endpoint:{ endpointId }, payload:{} },
        context:{ properties:[{ namespace:'Alexa.ColorController', name:'color', value:{ hue:h, saturation:s, brightness: color.brightness }, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 }] }
      });
    }

    // Percentage for FAN
    if(ns === 'Alexa.PercentageController'){
      const endpointId = directive.endpoint.endpointId;
      const perc = directive.payload.percentage;
      let speed = Math.ceil(perc/20); // 0-100 -> 1-5
      let dev = db.devices.find(d=>d.id===endpointId && d.userId===userId);
      if(dev){ dev.state='ON'; dev.speed=speed; writeDB(db); emitSingleDevice(userId,dev); io.to('user_'+userId).emit('alexa_cmd',{deviceId:endpointId, action:'SetSpeed', speed}); }
      return res.json({
        event:{ header:{ namespace:'Alexa', name:'Response', payloadVersion:'3', messageId: header.messageId, correlationToken: header.correlationToken }, endpoint:{ endpointId }, payload:{} },
        context:{ properties:[{ namespace:'Alexa.PercentageController', name:'percentage', value: perc, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 }] }
      });
    }

    // ReportState
    if(ns==='Alexa' && name==='ReportState'){
      const endpointId = directive.endpoint.endpointId;
      let dev = db.devices.find(d=>d.id===endpointId && d.userId===userId);
      let props = [];
      if(dev){
        props.push({ namespace:'Alexa.PowerController', name:'powerState', value: dev.state==='ON'?'ON':'OFF', timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 });
        if(dev.brightness) props.push({ namespace:'Alexa.BrightnessController', name:'brightness', value: dev.brightness, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 });
        if(dev.color) props.push({ namespace:'Alexa.ColorController', name:'color', value:{ hue:dev.color.hue, saturation:dev.color.saturation, brightness: dev.color.brightness/100 }, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 });
        if(dev.speed) props.push({ namespace:'Alexa.PercentageController', name:'percentage', value: dev.speed*20, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500 });
      }
      return res.json({ context:{ properties: props }, event:{ header:{ namespace:'Alexa', name:'StateReport', payloadVersion:'3', messageId: header.messageId, correlationToken: header.correlationToken }, endpoint:{ endpointId }, payload:{} } });
    }

    res.status(400).json({error:'unsupported directive', ns, name});
  }catch(e){
    console.error('Alexa error', e);
    res.status(500).json({ error: e.message });
  }
});

io.use((socket,next)=>{ try{ const token=socket.handshake.auth.token||socket.handshake.query.token; const dec=verifyToken(token); socket.userId=dec.userId; next(); }catch(e){ next(new Error('auth failed')); } });
io.on('connection',(socket)=>{ socket.join('user_'+socket.userId); const db=readDB(); socket.emit('devices_updated', db.devices.filter(d=>d.userId===socket.userId)); console.log('Connected',socket.userId); });

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Thavayil Alexa Ready - https://'+PORT));
