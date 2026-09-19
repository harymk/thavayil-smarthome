// routes/alexa.js - V65 FIX - Handles AcceptGrant + Separate Brightness
const colorUtil = require('../utils/color');

module.exports = (app, Device, verifyToken, alexaTokens, emitDevice) => {

  function alexaDeviceType(d){
    if(d.type==='LIGHT') return 'LIGHT';
    if(d.type==='FAN') return 'FAN';
    return 'SWITCH';
  }

  app.post('/alexa/smarthome', async (req,res)=>{
    try{
      const header = req.body.directive?.header;
      const ns = header?.namespace;
      const name = header?.name;
      console.log(`ALEXA RAW:`, JSON.stringify(req.body).substring(0,800));
      console.log(`ALEXA ${ns} ${name}`);

      // V65: AcceptGrant comes right after OAuth - MUST return success even without device lookup
      if(ns==='Alexa.Authorization' && name==='AcceptGrant'){
        const userId = 'unknown';
        try{
          const auth=req.headers.authorization;
          if(auth){
            const token=auth.replace('Bearer ','');
            const decoded=verifyToken(token);
            console.log('ALEXA AcceptGrant for', decoded.userId, 'grant code', req.body.directive?.payload?.grant?.code?.substring(0,20));
            if(alexaTokens) alexaTokens[decoded.userId]=token;
          }
        }catch(e){ console.log('AcceptGrant token parse failed, but still returning success', e.message); }
        // Alexa expects empty 202 response with no event, or Response with AcceptGrant
        return res.json({
          event: {
            header: {
              namespace: 'Alexa.Authorization',
              name: 'AcceptGrant.Response',
              payloadVersion: '3',
              messageId: header.messageId
            },
            payload: {}
          }
        });
      }

      // All other directives need auth
      const auth=req.headers.authorization;
      if(!auth) return res.status(401).json({error:'no auth'});
      const token=auth.replace('Bearer ','');
      let decoded; 
      try{ decoded=verifyToken(token); }catch(e){ console.log('ALEXA invalid token', e.message); return res.status(401).json({error:'invalid token'}); }
      const userId=decoded.userId;
      if(alexaTokens) alexaTokens[userId]=token;

      if(ns==='Alexa.Discovery' && name==='Discover'){
        const userDevices=await Device.find({userId});
        console.log(`ALEXA Discover found ${userDevices.length} devices for ${userId}`);
        const endpoints=userDevices.map(d=>{
          let caps=[{type:'AlexaInterface', interface:'Alexa', version:'3'}, {type:'AlexaInterface', interface:'Alexa.PowerController', version:'3', properties:{supported:[{name:'powerState'}], proactivelyReported:true, retrievable:true}}];
          if(d.type==='LIGHT'){
            caps.push({type:'AlexaInterface', interface:'Alexa.BrightnessController', version:'3', properties:{supported:[{name:'brightness'}], proactivelyReported:true, retrievable:true}});
            caps.push({type:'AlexaInterface', interface:'Alexa.ColorController', version:'3', properties:{supported:[{name:'color'}], proactivelyReported:true, retrievable:true}});
          }
          if(d.type==='FAN'){
            caps.push({type:'AlexaInterface', interface:'Alexa.RangeController', instance:'FanSpeed', version:'3', properties:{supported:[{name:'rangeValue'}], proactivelyReported:true, retrievable:true}, capabilityResources:{friendlyNames:[{type:'asset', value:{assetId:'Alexa.Setting.FanSpeed'}}]}, configuration:{supportedRange:{minimumValue:1, maximumValue:5, precision:1}}});
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
          dev.offline=false;
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
          dev.offline=false;
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
          dev.offline=false;
          await dev.save(); await emitDevice(userId, dev);
          const alexaCol=colorUtil.toAlexaColor(dev);
          return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId}, payload:{}}, context:{properties:[{namespace:'Alexa.ColorController', name:'color', value:alexaCol, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
        }
      }

      if(ns==='Alexa.RangeController'){
        const endpointId=req.body.directive.endpoint.endpointId;
        const rangeValue=req.body.directive.payload.rangeValue;
        console.log('ALEXA Fan Range', rangeValue);
        const dev=await Device.findOne({id:endpointId, userId});
        if(dev){ dev.speed=Math.max(1,Math.min(5,parseInt(rangeValue))); dev.state='ON'; dev.offline=false; await dev.save(); await emitDevice(userId, dev); }
        return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:{endpointId}, payload:{}}, context:{properties:[{namespace:'Alexa.RangeController', instance:'FanSpeed', name:'rangeValue', value:rangeValue, timeOfSample:new Date().toISOString(), uncertaintyInMilliseconds:500}]}});
      }

      console.log('ALEXA Unhandled', ns, name, 'returning generic success');
      return res.json({event:{header:{namespace:'Alexa', name:'Response', payloadVersion:'3', messageId:header.messageId, correlationToken:header.correlationToken}, endpoint:req.body.directive.endpoint, payload:{}}});
    }catch(e){ console.log('ALEXA ERROR', e.message, e.stack); res.status(500).json({error:e.message}); }
  });
};
