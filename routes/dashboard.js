
// routes/dashboard.js - Web Dashboard API - EDIT ONLY THIS FILE FOR DASHBOARD
const colorUtil = require('../utils/color');

module.exports = (app, Device, authMiddleware, io) => {

  app.get('/api/devices', authMiddleware, async (req,res)=>{
    try{ const devs=await Device.find({userId:req.user.userId}); res.json(devs); }catch(e){ res.status(500).json({error:e.message}); }
  });

  function gen10DigitId(){ return Math.floor(1000000000 + Math.random()*9000000000).toString(); }

  app.post('/api/devices', authMiddleware, async (req,res)=>{
    try{
      const {name,type,id}=req.body;
      if(!name||!type) return res.status(400).json({error:'name type required'});
      let deviceId = id && /^\d{10}$/.test(id)? id : gen10DigitId();
      let exists = await Device.findOne({id: deviceId, userId: req.user.userId});
      while(exists){ deviceId = gen10DigitId(); exists = await Device.findOne({id: deviceId, userId: req.user.userId}); }
      const dev = await Device.create({id:deviceId, deviceId:deviceId, userId:req.user.userId, name, type:type.toUpperCase(), state:'OFF', brightness:100, color:{hue:45,saturation:1,brightness:100}});
      io.to('user_'+req.user.userId).emit('device_created', dev);
      res.json(dev);
    }catch(e){ res.status(500).json({error:e.message}); }
  });

  app.post('/api/device/control', authMiddleware, async (req,res)=>{
    try{
      const {deviceId,action,color,brightness,speed}=req.body;
      console.log('DASHBOARD CONTROL:', {deviceId, action, color, brightness});
      let dev=await Device.findOne({id:deviceId, userId:req.user.userId}) || await Device.findOne({deviceId, userId:req.user.userId});
      if(!dev) return res.status(404).json({error:'device not found'});

      if(action==='TurnOn') dev.state='ON';
      if(action==='TurnOff') dev.state='OFF';

      // V53 FIX: Separate color and brightness
      if(color && dev.type==='LIGHT'){
        colorUtil.applyColorChange(dev, color);
      }
      if(brightness!==undefined && dev.type==='LIGHT'){
        colorUtil.applyBrightnessChange(dev, brightness);
      }
      if(speed!==undefined && dev.type==='FAN'){
        dev.speed=parseInt(speed);
        dev.state='ON';
      }

      await dev.save();
      io.to('user_'+req.user.userId).emit('device_updated', dev);
      io.to('user_'+req.user.userId).emit('alexa_cmd',{deviceId,action:action||'TurnOn',color,brightness,speed});
      res.json({success:true, device:dev});
    }catch(e){ console.log('DASHBOARD ERROR', e.message); res.status(500).json({error:e.message}); }
  });

  app.delete('/api/devices/:id', authMiddleware, async (req,res)=>{
    try{ await Device.deleteOne({id:req.params.id, userId:req.user.userId}); res.json({success:true}); }catch(e){ res.status(500).json({error:e.message}); }
  });
};
