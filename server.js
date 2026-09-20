
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

console.log('Starting V73 HARDCODED DISCOVERY...');
mongoose.connect(MONGO).then(()=>console.log('MongoDB Connected V73')).catch(e=>console.log('Mongo error', e.message));

const User = mongoose.model('User', new mongoose.Schema({id:String, email:{type:String, unique:true, lowercase:true, trim:true}, password:String}));
const Code = mongoose.model('Code', new mongoose.Schema({code:String, userId:String, exp:Number}));
const Device = mongoose.model('Device', new mongoose.Schema({id:String, deviceId:String, userId:String, name:String, type:String, state:{type:String, default:'OFF'}, color:Object, brightness:Number, speed:Number, offline:Boolean, createdAt:String}, {strict:false}));
const OfflineState = mongoose.model('OfflineState', new mongoose.Schema({deviceId:{type:String, unique:true}, offline:Boolean, updatedAt:Date}));

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

app.get('/oauth/authorize', (req,res)=>{
  const {redirect_uri, state, client_id} = req.query;
  const safeR = encodeURIComponent(redirect_uri);
  const safeS = encodeURIComponent(state||'');
  res.send(`<html><body><h2>Thavayil</h2><form method="POST" action="/oauth/authorize?redirect_uri=${safeR}&state=${safeS}"><input name="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button>Link</button></form></body></html>`);
});

app.post('/oauth/authorize', async (req,res)=>{
  let redirect_uri = req.query.redirect_uri || req.body.redirect_uri;
  let state = req.query.state || req.body.state;
  try{ redirect_uri = decodeURIComponent(redirect_uri); }catch(e){}
  try{ state = decodeURIComponent(state); }catch(e){}
  const email = (req.body.email||'').toLowerCase().trim();
  let user = await User.findOne({email, password:req.body.password}) || await User.findOne({email:req.body.email, password:req.body.password});
  if(!user) return res.send('Invalid');
  const code = crypto.randomBytes(16).toString('hex');
  await Code.deleteMany({userId:user.id});
  await Code.create({code, userId:user.id, exp:Date.now()+600000});
  const finalUrl = redirect_uri.includes('?') ? `${redirect_uri}&code=${code}&state=${encodeURIComponent(state)}` : `${redirect_uri}?code=${code}&state=${encodeURIComponent(state)}`;
  res.redirect(finalUrl);
});

app.post('/oauth/token', async (req,res)=>{
  try{
    if(req.body.grant_type==='refresh_token' && req.body.refresh_token){
      try{
        let dec; try{ dec=jwt.verify(req.body.refresh_token, JWT_NEW); }catch(e){ dec=jwt.verify(req.body.refresh_token, JWT_OLD); }
        const token = jwt.sign({userId:dec.userId}, JWT_NEW, {noTimestamp:true});
        return res.json({access_token:token, refresh_token:req.body.refresh_token, token_type:'Bearer', expires_in:31536000});
      }catch(e){}
    }
    const entry = await Code.findOne({code:req.body.code});
    if(!entry) return res.status(400).json({error:'invalid code'});
    const token = jwt.sign({userId:entry.userId}, JWT_NEW, {noTimestamp:true});
    await Code.deleteOne({code:entry.code});
    res.json({access_token:token, refresh_token:token, token_type:'Bearer', expires_in:31536000});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/test/version', (req,res)=> res.json({version:'V73_HARDCODED', ok:true}));
app.get('/test/delete-bad', async (req,res)=>{
  const r1 = await Device.deleteMany({id:{$in:['3088544467','6360966937']}});
  const r2 = await Device.deleteMany({name:{$in:['kkjkh','hjk','jk','gk']}});
  const remaining = await Device.find({userId:'1789741458155'});
  res.json({deleted: r1.deletedCount + r2.deletedCount, remaining});
});
app.get('/test/alexa-discover/:userId', async (req,res)=>{
  const devs = await Device.find({userId:req.params.userId});
  res.json({found:devs.length, devices:devs.map(d=>({id:d.id, name:d.name, type:d.type}))});
});

async function googleHandler(req,res){
  try{
    const token = req.headers.authorization?.replace('Bearer ','');
    if(!token) return res.status(401).json({error:'no auth'});
    let dec; try{ dec=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid'}); }
    const userId = dec.userId;
    const requestId = req.body.requestId || 'test';
    const intent = req.body.inputs?.[0]?.intent;
    console.log(`GOOGLE ${intent} for ${userId}`);
    if(intent==='action.devices.SYNC'){
      const userDevices = await Device.find({userId});
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
  }catch(e){ res.status(500).json({error:e.message}); }
}
app.post('/google/smarthome', googleHandler);
app.post('/smarthome', googleHandler);

// ALEXA V73 HARDCODED
app.post('/alexa/smarthome', async (req,res)=>{
  try{
    const header = req.body.directive?.header;
    const ns = header?.namespace;
    const name = header?.name;
    console.log(`ALEXA ${ns} ${name}`);
    if(ns==='Alexa.Authorization' && name==='AcceptGrant'){
      return res.json({event:{header:{namespace:'Alexa.Authorization', name:'AcceptGrant.Response', payloadVersion:'3', messageId:header.messageId}, payload:{}}});
    }
    const auth=req.headers.authorization;
    if(!auth) return res.status(401).json({error:'no auth'});
    const token=auth.replace('Bearer ','');
    let dec; try{ dec=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid'}); }
    const userId=dec.userId;
    if(ns==='Alexa.Discovery' && name==='Discover'){
      console.log(`ALEXA Discover for ${userId} - HARDCODED 2`);
      const endpoints=[
        {
          endpointId:'6328761164',
          manufacturerName:'Thavayil Electronics',
          description:'FAN Bedroom Fan',
          friendlyName:'Bedroom Fan',
          displayCategories:['FAN'],
          cookie:{userId},
          capabilities:[
            {type:'AlexaInterface', interface:'Alexa', version:'3'},
            {type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true}},
            {type:'AlexaInterface', interface:'Alexa.EndpointHealth', version:'3', properties:{supported:[{name:'connectivity'}], proactivelyReported:true, retrievable:true}},
            {type:'AlexaInterface', interface:'Alexa.RangeController', instance:'FanSpeed', version:'3', properties:{supported:[{name:'rangeValue'}], proactivelyReported:true, retrievable:true}, capabilityResources:{friendlyNames:[{type:'asset', value:{assetId:'Alexa.Setting.FanSpeed'}}]}, configuration:{supportedRange:{minimumValue:1, maximumValue:5, precision:1}}}
          ]
        },
        {
          endpointId:'1875336409',
          manufacturerName:'Thavayil Electronics',
          description:'LIGHT Living Light',
          friendlyName:'Living Light',
          displayCategories:['LIGHT'],
          cookie:{userId},
          capabilities:[
            {type:'AlexaInterface', interface:'Alexa', version:'3'},
            {type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true}},
            {type:'AlexaInterface', interface:'Alexa.EndpointHealth', version:'3', properties:{supported:[{name:'connectivity'}], proactivelyReported:true, retrievable:true}},
            {type:'AlexaInterface', interface:'Alexa.BrightnessController', version:'3', properties:{supported:[{name:'brightness'}], proactivelyReported:true, retrievable:true}},
            {type:'AlexaInterface', interface:'Alexa.ColorController', version:'3', properties:{supported:[{name:'color'}], proactivelyReported:true, retrievable:true}}
          ]
        }
      ];
      return res.json({event:{header:{namespace:'Alexa.Discovery', name:'Discover.Response', payloadVersion:'3', messageId:header.messageId}, payload:{endpoints}}});
    }
    if(ns==='Alexa.PowerController'){
      const eid=req.body.directive.endpoint.endpointId;
      let dev=await Device.findOne({id:eid, userId}) || await Device.findOne({deviceId:eid, userId});
      if(dev){ dev.state=(name==='TurnOn'?'ON':'OFF'); dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev); }
      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}});
    }
    if(ns==='Alexa.BrightnessController'){
      const eid=req.body.directive.endpoint.endpointId;
      const b=req.body.directive.payload.brightness;
      let dev=await Device.findOne({id:eid, userId}) || await Device.findOne({deviceId:eid, userId});
      if(dev){ const bb=Math.max(5,Math.min(100, parseInt(b))); dev.brightness=bb; dev.state='ON'; dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev);
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.BrightnessController', name:'brightness', value:bb, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
      }
    }
    if(ns==='Alexa.RangeController'){
      const eid=req.body.directive.endpoint.endpointId;
      const rangeVal=req.body.directive.payload.rangeValue;
      let dev=await Device.findOne({id:eid, userId}) || await Device.findOne({deviceId:eid, userId});
      if(dev){ dev.speed=Math.max(1,Math.min(5, parseInt(rangeVal))); dev.state='ON'; dev.offline=false; await dev.save(); io.to('user_'+userId).emit('device_updated', dev); io.emit('device_updated', dev); }
      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId:eid}, payload:{}}, context:{properties:[{namespace:'Alexa.RangeController', instance:'FanSpeed', name:'rangeValue', value:rangeVal, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
    }
    return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:req.body.directive.endpoint, payload:{}}});
  }catch(e){ console.log('ALEXA ERR', e.message); res.status(500).json({error:e.message}); }
});

app.get('/', (req,res)=> res.send('<h1>V73</h1><a href="/test/version">version</a> | <a href="/test/delete-bad">delete bad</a>'));
const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=> console.log(`V73 HARDCODED Port ${PORT}`));
