
// routes/alexa.js - Alexa Smart Home - EDIT ONLY THIS FILE FOR ALEXA
const colorUtil = require('../utils/color');

module.exports = (app, Device, verifyToken, alexaTokens, emitDevice) => {

  function alexaDeviceType(d){
    if(d.type==='LIGHT') return 'LIGHT';
    if(d.type==='FAN') return 'FAN';
    return 'SWITCH';
  }

  app.post('/alexa/smarthome', async (req,res)=>{
    try{
      const auth=req.headers.authorization;
      if(!auth) return res.status(401).json({error:'no auth'});
      const token=auth.replace('Bearer ','');
      let decoded; try{ decoded=verifyToken(token); }catch(e){ return res.status(401).json({error:'invalid token'}); }
      const userId=decoded.userId;
      alexaTokens[userId]=token;
      const header=req.body.directive.header;
      const ns=header.namespace;
      const name=header.name;
      console.log(`ALEXA ${ns} ${name} for ${userId}`);

      if(ns==='Alexa.Discovery' && name==='Discover'){
        const userDevices=await Device.find({userId});
        const endpoints=userDevices.map(d=>{
          let caps=[{type:'AlexaInterface', interface:'Alexa', version:'3'}, {type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true}}];
          if(d.type==='LIGHT'){
            caps.push({type:'AlexaInterface', interface:'Alexa.BrightnessController', version:'3', properties:{supported:[{name:'brightness'}], proactivelyReported:true, retrievable:true}});
            caps.push({type:'AlexaInterface', interface:'Alexa.ColorController', version:'3', properties:{supported:[{name:'color'}], proactivelyReported:true, retrievable:true}});
          }
          if(d.type==='FAN'){
            caps.push({type:'AlexaInterface', interface:'Alexa.RangeController', instance:'FanSpeed', version:'3', properties:{supported:[{name:'rangeValue'}], proactivelyReported:true, retrievable:true}, capabilityResources:{friendlyNames:[{type:'asset', value:{assetId:'Alexa.Setting.FanSpeed'}}]}, configuration:{supportedRange:{minimumValue:1, maximumValue:5, precision:1}, presets:[{rangeValue:1, presetResources:{friendlyNames:[{type:'text', value:{text:'low', locale:'en-US'}}]}},{rangeValue:3, presetResources:{friendlyNames:[{type:'text', value:{text:'medium', locale:'en-US'}}]}},{rangeValue:5, presetResources:{friendlyNames:[{type:'text', value:{text:'high', locale:'en-US'}}]}}]}});
          }
          return {endpointId:d.id, manufacturerName:'Thavayil', description:d.type+' '+d.name, friendlyName:d.name, displayCategories:[alexaDeviceType(d)], capabilities:caps};
        });
        return res.json({event:{header:{namespace:'Alexa.Discovery', name:'Discover.Response', payloadVersion:'3', messageId:header.messageId}, payload:{endpoints}}});
      }

      if(ns==='Alexa.PowerController'){
        const endpointId=req.body.directive.endpoint.endpointId;
        const dev=await Device.findOne({id:endpointId, userId});
        if(dev){
          dev.state= (name==='TurnOn')?'ON':'OFF';
          await dev.save(); await emitDevice(userId, dev);
        }
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId}, payload:{}}});
      }

      if(ns==='Alexa.BrightnessController'){
        const endpointId=req.body.directive.endpoint.endpointId;
        const brightness=req.body.directive.payload.brightness;
        const dev=await Device.findOne({id:endpointId, userId});
        if(dev){
          const b=colorUtil.applyBrightnessChange(dev, brightness);
          await dev.save(); await emitDevice(userId, dev);
          return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId}, payload:{}}, context:{properties:[{namespace:'Alexa.BrightnessController', name:'brightness', value:b, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
        }
      }

      if(ns==='Alexa.ColorController' && name==='SetColor'){
        const endpointId=req.body.directive.endpoint.endpointId;
        const color=req.body.directive.payload.color;
        console.log('ALEXA SetColor', color);
        const dev=await Device.findOne({id:endpointId, userId});
        if(dev){
          colorUtil.applyAlexaColor(dev, color);
          await dev.save(); await emitDevice(userId, dev);
          const alexaCol=colorUtil.toAlexaColor(dev);
          return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId}, payload:{}}, context:{properties:[{namespace:'Alexa.ColorController', name:'color', value:alexaCol, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
        }
      }

      if(ns==='Alexa.RangeController'){
        const endpointId=req.body.directive.endpoint.endpointId;
        const rangeValue=req.body.directive.payload.rangeValue;
        const dev=await Device.findOne({id:endpointId, userId});
        if(dev){ dev.speed=rangeValue; dev.state='ON'; await dev.save(); await emitDevice(userId, dev); }
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId}, payload:{}}, context:{properties:[{namespace:'Alexa.RangeController', instance:'FanSpeed', name:'rangeValue', value:rangeValue, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
      }

      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:req.body.directive.endpoint, payload:{}}});
    }catch(e){ console.log('ALEXA ERROR', e.message, e.stack); res.status(500).json({error:e.message}); }
  });
};
