
// routes/google.js - Google Home SYNC/QUERY/EXECUTE - EDIT ONLY THIS FILE FOR GOOGLE
const colorUtil = require('../utils/color');

module.exports = (app, Device, OfflineState, verifyToken, googleTokens, global, emitDevice) => {

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

  async function handleGoogle(req,res){
    try{
      console.log('GOOGLE REQ:', req.path, JSON.stringify(req.body).substring(0,400));
      const auth=req.headers.authorization;
      if(!auth) return res.status(401).json({error:'no auth'});
      const token=auth.replace('Bearer ','');
      let decoded; try{ decoded=verifyToken(token); }catch(e){ console.log('GOOGLE invalid token'); return res.status(401).json({error:'invalid token'}); }
      const userId=decoded.userId;
      googleTokens[userId]=token;
      const requestId=req.body.requestId||'test-123';
      const intent=req.body.inputs?.[0]?.intent;
      console.log(`GOOGLE ${intent} for ${userId}`);

      if(intent==='action.devices.SYNC'){
        try{
          const userDevices=await Device.find({userId});
          console.log(`SYNC found ${userDevices.length} devices`);
          const devices=userDevices.map(d=>{
            let traits=googleDeviceTraits(d);
            let attributes={};
            if(d.type==='LIGHT') attributes.colorModel='hsv';
            if(d.type==='FAN'){
              attributes.availableFanSpeeds={speeds:[{speed_name:'low',speed_values:[{speed_synonym:['low','1'],lang:'en'}]},{speed_name:'medium',speed_values:[{speed_synonym:['medium','2'],lang:'en'}]},{speed_name:'high',speed_values:[{speed_synonym:['high','3'],lang:'en'}]}],ordered:true};
              attributes.reversible=false;
            }
            return {id:(d.id||d.deviceId).toString(), type:googleDeviceType(d), traits, name:{defaultNames:[d.id], name:d.name, nicknames:[d.name]}, willReportState:false, attributes, deviceInfo:{manufacturer:'Thavayil Electronics', model:'v1', hwVersion:'1.0', swVersion:'1.0'}};
          });
          return res.json({requestId, payload:{agentUserId:userId, devices}});
        }catch(e){ console.log('SYNC ERROR', e.message); return res.json({requestId, payload:{agentUserId:userId, devices:[]}}); }
      }

      if(intent==='action.devices.QUERY'){
        const payloadDevices=req.body.inputs[0].payload.devices;
        const userDevices=await Device.find({userId});
        let devicesState={};
        for(const q of payloadDevices){
          const d=userDevices.find(x=>x.id===q.id || x.deviceId===q.id);
          let online=true;
          if(global.offlineDevices.has(q.id)) global.offlineDevices.delete(q.id);
          if(!d){ devicesState[q.id]={online, on:false, status:'SUCCESS'}; continue; }
          let state={online, on:d.state==='ON', status:'SUCCESS'};
          if(d.type==='FAN'){
            const map={1:'low',2:'low',3:'medium',4:'high',5:'high'};
            state.currentFanSpeedSetting=map[d.speed]||'medium';
          }
          if(d.type==='LIGHT'){
            const hsv=colorUtil.toGoogleHSV(d);
            state.brightness=d.brightness||100;
            state.color={spectrumHsv:hsv};
          }
          devicesState[q.id]=state;
        }
        return res.json({requestId, payload:{devices:devicesState}});
      }

      if(intent==='action.devices.EXECUTE'){
        const commands=req.body.inputs[0].payload.commands;
        let states={};
        for(const cmd of commands){
          for(const dev of cmd.devices){
            const d=await Device.findOne({id:dev.id, userId}) || await Device.findOne({deviceId:dev.id, userId});
            if(!d) continue;
            let newState={online:true};
            for(const ex of cmd.execution){
              const params=ex.params;
              if(ex.command==='action.devices.commands.OnOff'){ d.state=params.on?'ON':'OFF'; newState.on=params.on; }
              if(ex.command==='action.devices.commands.BrightnessAbsolute'){
                const b=colorUtil.applyBrightnessChange(d, params.brightness);
                newState.brightness=b; newState.on=true;
              }
              if(ex.command==='action.devices.commands.ColorAbsolute'){
                let hsv=params.color?.spectrumHSV || params.color?.spectrumHsv || params.color?.spectrumRgb;
                if(params.color?.spectrumHSV){
                  const c=colorUtil.applyGoogleColor(d, params.color.spectrumHSV);
                  newState.color={spectrumHsv:{hue:c.hue, saturation:c.saturation, value:c.brightness/100}};
                  newState.brightness=c.brightness; newState.on=true;
                }
              }
            }
            await d.save(); await emitDevice(userId, d); states[d.id]=newState;
          }
        }
        return res.json({requestId, payload:{commands:[{ids:Object.keys(states), status:'SUCCESS', states}]}});
      }

      return res.json({requestId, payload:{}});
    }catch(e){ console.log('GOOGLE ERROR', e.message, e.stack); res.status(500).json({error:e.message}); }
  }

  app.post('/google/smarthome', handleGoogle);
  app.post('/smarthome', handleGoogle); // alias for both URLs
};
