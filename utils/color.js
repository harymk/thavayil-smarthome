// utils/color.js - V64 SEPARATE brightness and colour brightness
function applyColorChange(dev, colorInput){
  if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
  if(colorInput.hue!==undefined) dev.color.hue = parseInt(colorInput.hue)%360;
  if(colorInput.saturation!==undefined) dev.color.saturation = Math.max(0,Math.min(1, parseFloat(colorInput.saturation)>1? parseFloat(colorInput.saturation)/100 : parseFloat(colorInput.saturation)));
  // V64 SEPARATE: Do NOT touch brightness at all
  dev.state='ON';
}

function applyBrightnessChange(dev, brightness){
  const b = Math.max(5, Math.min(100, parseInt(brightness)));
  dev.brightness = b;
  if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
  // V64 SEPARATE: Do NOT touch dev.color.brightness
  dev.state='ON';
  return b;
}

function applyAlexaColor(dev, alexaColor){
  // V64 SEPARATE: Only hue/sat, ignore brightness from Alexa
  if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
  let h = Math.round(alexaColor.hue)%360;
  let s = parseFloat(alexaColor.saturation);
  if(s>1) s=s/100;
  dev.color.hue=h;
  dev.color.saturation=Math.max(0,Math.min(1,s));
  // Do NOT update dev.brightness or dev.color.brightness
  dev.state='ON';
}

function applyGoogleColor(dev, spectrumHSV){
  // V64 SEPARATE: Only hue/sat, ignore value
  if(!dev.color) dev.color={hue:45,saturation:1,brightness:100};
  let h = Math.round(spectrumHSV.hue)%360;
  let s = parseFloat(spectrumHSV.saturation);
  if(s>1) s=s/100;
  dev.color.hue=h;
  dev.color.saturation=Math.max(0,Math.min(1,s));
  dev.state='ON';
  return {hue:h, saturation:s, brightness:dev.color.brightness||100};
}

function toGoogleHSV(dev){
  // Return color's own brightness, not device brightness
  const colorBri = dev.color?.brightness || 100;
  let h=dev.color?.hue||0;
  let s=dev.color?.saturation||0;
  if(s>1) s=s/100;
  return {hue:Math.round(h)%360, saturation:Math.max(0,Math.min(1,s)), value:Math.max(0.05,Math.min(1,colorBri/100))};
}

function toAlexaColor(dev){
  const colorBri = dev.color?.brightness || 100;
  let h=dev.color?.hue||0;
  let s=dev.color?.saturation||0;
  if(s>1) s=s/100;
  return {hue:h, saturation:s, brightness:colorBri/100};
}

module.exports={applyColorChange, applyBrightnessChange, applyAlexaColor, applyGoogleColor, toGoogleHSV, toAlexaColor};
