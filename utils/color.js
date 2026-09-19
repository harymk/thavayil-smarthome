
// utils/color.js - ONE PLACE to fix ghost brightness
// V53: Separate hue/sat and brightness properly

function normalizeColor(colorObj, currentBrightness=100){
  // colorObj may have hue, saturation, brightness/value
  let h = 0, s = 0, v = currentBrightness/100;
  if(colorObj){
    if(colorObj.hue!==undefined) h = parseInt(colorObj.hue)%360;
    if(colorObj.saturation!==undefined){ s = parseFloat(colorObj.saturation); if(s>1) s=s/100; }
    if(colorObj.brightness!==undefined) v = parseFloat(colorObj.brightness)/100;
    else if(colorObj.value!==undefined) v = parseFloat(colorObj.value)>1 ? parseFloat(colorObj.value)/100 : parseFloat(colorObj.value);
  }
  return {hue: Math.round(h)%360, saturation: Math.max(0,Math.min(1,s)), value: Math.max(0.05,Math.min(1,v)), brightness: Math.round(Math.max(5,Math.min(100, v*100)))};
}

function applyColorChange(dev, colorInput){
  // Dashboard color picker: ONLY hue/sat, keep brightness
  if(!dev.color) dev.color={hue:45,saturation:1,brightness:dev.brightness||100};
  if(colorInput.hue!==undefined) dev.color.hue = parseInt(colorInput.hue)%360;
  if(colorInput.saturation!==undefined) dev.color.saturation = Math.max(0,Math.min(1, parseFloat(colorInput.saturation)>1? parseFloat(colorInput.saturation)/100 : parseFloat(colorInput.saturation)));
  // Do NOT touch dev.brightness here - prevents ghost
  dev.state='ON';
}

function applyBrightnessChange(dev, brightness){
  const b = Math.max(5, Math.min(100, parseInt(brightness)));
  dev.brightness = b;
  if(!dev.color) dev.color={hue:45,saturation:1,brightness:b};
  dev.color.brightness = b; // keep in sync for display
  dev.state='ON';
  return b;
}

function applyAlexaColor(dev, alexaColor){
  // Alexa SetColor includes hue, saturation, brightness (0-1)
  // V53: Update ALL - hue, sat, AND brightness from Alexa color
  let h = Math.round(alexaColor.hue)%360;
  let s = parseFloat(alexaColor.saturation);
  if(s>1) s=s/100;
  let b = dev.brightness||100;
  if(alexaColor.brightness!==undefined){
    b = Math.round(Math.max(0.05,Math.min(1, alexaColor.brightness))*100);
    b = Math.max(5,b);
  }
  dev.color={hue:h, saturation:s, brightness:b};
  dev.brightness=b;
  dev.state='ON';
}

function applyGoogleColor(dev, spectrumHSV){
  // Google ColorAbsolute: hue, saturation, value (0-1) where value = brightness
  // V53: Update hue/sat AND brightness from value
  let h = Math.round(spectrumHSV.hue)%360;
  let s = parseFloat(spectrumHSV.saturation);
  if(s>1) s=s/100;
  let v = parseFloat(spectrumHSV.value);
  if(v>1) v=v/100;
  let b = Math.round(Math.max(0.05,Math.min(1,v))*100);
  b = Math.max(5,b);
  dev.color={hue:h, saturation:Math.max(0,Math.min(1,s)), brightness:b};
  dev.brightness=b;
  dev.state='ON';
  return {hue:h, saturation:s, brightness:b};
}

function toGoogleHSV(dev){
  const bri = dev.brightness!==undefined? dev.brightness : 100;
  let h=0,s=0,v=bri/100;
  if(dev.color){
    if(dev.color.hue!==undefined) h=dev.color.hue;
    if(dev.color.saturation!==undefined){ s=dev.color.saturation; if(s>1) s=s/100; }
    // value = brightness trait, not color.brightness, to prevent ghost jump
    v = bri/100;
  }
  return {hue:Math.round(h)%360, saturation:Math.max(0,Math.min(1,s)), value:Math.max(0.05,Math.min(1,v))};
}

function toAlexaColor(dev){
  const bri = dev.brightness!==undefined? dev.brightness : 100;
  let h=0,s=0;
  if(dev.color){
    if(dev.color.hue!==undefined) h=dev.color.hue;
    if(dev.color.saturation!==undefined){ s=dev.color.saturation; if(s>1) s=s/100; }
  }
  return {hue:h, saturation:s, brightness:bri/100};
}

module.exports={normalizeColor, applyColorChange, applyBrightnessChange, applyAlexaColor, applyGoogleColor, toGoogleHSV, toAlexaColor};
