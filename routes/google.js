
const express = require('express');
const Device = require('../models/Device');
const OfflineState = require('../models/OfflineState');
const { verifyToken } = require('../utils/auth');
const router = express.Router();

let offlineDevices = global.offlineDevices || new Set();

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
      console.log(`SYNC found ${userDevices.length} devices`);
      const devices = userDevices.map(d=>{
        let traits = d.type==='FAN' ? ['action.devices.traits.OnOff','action.devices.traits.FanSpeed'] : d.type==='LIGHT' ? ['action.devices.traits.OnOff','action.devices.traits.Brightness','action.devices.traits.ColorSetting'] : ['action.devices.traits.OnOff'];
        let attrs = {};
        if(d.type==='LIGHT') attrs.colorModel='hsv';
        if(d.type==='FAN') attrs.availableFanSpeeds={speeds:[{speed_name:'low',speed_values:[{speed_synonym:['low','1'],lang:'en'}]},{speed_name:'medium',speed_values:[{speed_synonym:['medium','2'],lang:'en'}]},{speed_name:'high',speed_values:[{speed_synonym:['high','3'],lang:'en'}]}],ordered:true};
        return {id:(d.id||d.deviceId).toString(), type:d.type==='LIGHT'?'action.devices.types.LIGHT':d.type==='FAN'?'action.devices.types.FAN':'action.devices.types.SWITCH', traits, name:{defaultNames:[d.id], name:d.name, nicknames:[d.name]}, willReportState:false, attributes:attrs, deviceInfo:{manufacturer:'Thavayil Electronics', model:'v1'}};
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
            if(ex.command==='action.devices.commands.BrightnessAbsolute'){ const b=Math.max(5,Math.min(100, parseInt(p.brightness))); d.brightness=b; if(!d.color) d.color={hue:45,saturation:1,brightness:100}; /* V63 SEPARATE - don't touch color.brightness */ d.state='ON'; ns.brightness=b; ns.on=true; }
            // V62: Color separate - don't touch brightness
            if(ex.command==='action.devices.commands.ColorAbsolute' && p.color?.spectrumHSV){
              const hsv=p.color.spectrumHSV;
              if(!d.color) d.color={hue:45, saturation:1, brightness:d.brightness||100};
              d.color.hue=Math.round(hsv.hue)%360;
              let s=parseFloat(hsv.saturation); if(s>1) s=s/100; d.color.saturation=Math.max(0,Math.min(1,s));
              d.state='ON'; const colorBri = d.color.brightness||100; ns.color={spectrumHsv:{hue:d.color.hue, saturation:d.color.saturation, value:colorBri/100}}; ns.on=true; // V63 SEPARATE - color doesn't return brightness
            }
            if(ex.command==='action.devices.commands.SetFanSpeed'){
              if(p.fanSpeed){ const mapStr={low:2, 'low 1':1, 'low 2':2, medium:3, 'medium low':2, 'medium high':4, high:5}; d.speed=mapStr[p.fanSpeed.toLowerCase()]||3; d.state='ON'; ns.currentFanSpeedSetting=p.fanSpeed; ns.on=true; }
              else if(p.fanSpeedPercent!==undefined){ const pct=parseInt(p.fanSpeedPercent); let s=1; if(pct<=20) s=1; else if(pct<=40) s=2; else if(pct<=60) s=3; else if(pct<=80) s=4; else s=5; d.speed=s; d.state='ON'; const revMap={1:'low',2:'low',3:'medium',4:'high',5:'high'}; ns.currentFanSpeedSetting=revMap[s]; ns.on=true; }
            }
          }
          d.offline=false; await d.save();
          if(global.io) global.io.to('user_'+userId).emit('device_updated', d);
          outStates[d.id]=ns;
        }
      }
      return res.json({requestId, payload:{commands:[{ids:Object.keys(outStates), status:'SUCCESS', states:outStates}]}});
    }
    return res.json({requestId, payload:{}});
  }catch(e){ console.log('GOOGLE ERR', e.message, e.stack); res.status(500).json({error:e.message}); }
}

router.post('/smarthome', googleHandler);
router.post('/google/smarthome', googleHandler);
router.post('/', googleHandler);

module.exports = router;
