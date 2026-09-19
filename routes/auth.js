// routes/auth.js - V64 ALEXA LINK FIX - EDIT ONLY THIS FILE FOR LINKING
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();

module.exports = (User, Code, JWT_SECRET_NEW, JWT_SECRET_OLD) => {
  
  function verifyToken(t){
    try{ return jwt.verify(t, JWT_SECRET_NEW); }
    catch(e){ return jwt.verify(t, JWT_SECRET_OLD); }
  }

  router.get('/oauth/authorize', (req,res)=>{
    const {redirect_uri,state,client_id,response_type}=req.query;
    console.log('OAUTH AUTHORIZE GET:', {client_id, redirect_uri: redirect_uri?.substring(0,80), state: state?.substring(0,80), response_type});
    if(!redirect_uri){
      return res.status(400).send('Missing redirect_uri - try again from Google/Alexa app.');
    }
    const safeRedirect = encodeURIComponent(redirect_uri);
    const safeState = encodeURIComponent(state||'');
    res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#08080c;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#14141e;padding:28px;border-radius:24px;width:360px}input{width:100%;padding:14px;margin:8px 0;border-radius:12px;border:1px solid #333;background:#0d0d13;color:#fff;box-sizing:border-box}button{width:100%;padding:14px;background:#fff;color:#000;border:0;border-radius:12px;font-weight:700;margin-top:12px;cursor:pointer}</style></head><body><div class="card"><h2>Thavayil SmartHome</h2><p style="color:#999;font-size:13px">Link to ${client_id?.includes('google')?'Google Home':'Alexa'}</p><form method="POST" action="/oauth/authorize?redirect_uri=${safeRedirect}&state=${safeState}"><input name="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button type="submit">Link Account</button></form></div></body></html>`);
  });

  router.post('/oauth/authorize', async (req,res)=>{
    try{
      let redirect_uri = req.query.redirect_uri || req.body.redirect_uri;
      let state = req.query.state || req.body.state;
      // V64: Decode - Alexa sends huge encoded state
      try{ redirect_uri = decodeURIComponent(redirect_uri); }catch(e){}
      try{ state = decodeURIComponent(state); }catch(e){}
      console.log('OAUTH AUTHORIZE POST:', {email:req.body.email, redirect_uri: redirect_uri?.substring(0,100), state_len: state?.length});
      if(!redirect_uri){
        console.log('OAUTH MISSING redirect_uri', req.query, req.body);
        return res.status(400).send('Missing redirect_uri - link from app');
      }
      const email = (req.body.email||'').toLowerCase().trim();
      const password = req.body.password;
      let user = await User.findOne({email, password}) || await User.findOne({email:req.body.email, password});
      if(!user){
        console.log('OAUTH FAIL: user not found', email);
        return res.send(`Invalid credentials for ${email}<br><a href="javascript:history.back()">Back</a>`);
      }
      const code=crypto.randomBytes(16).toString('hex');
      await Code.deleteMany({userId:user.id}); // V64: clear old codes
      await Code.create({code,userId:user.id,exp:Date.now()+600000});
      console.log('OAUTH CODE created', code, 'for', user.id, 'state len', state?.length);
      let finalUrl;
      if(redirect_uri.includes('?')){
        finalUrl = `${redirect_uri}&code=${code}&state=${encodeURIComponent(state)}`;
      } else {
        finalUrl = `${redirect_uri}?code=${code}&state=${encodeURIComponent(state)}`;
      }
      console.log('OAUTH REDIRECT OK for', user.id, '->', finalUrl.substring(0,150));
      res.redirect(finalUrl);
    }catch(e){ console.log('OAUTH ERROR', e.message, e.stack); res.send('Error: '+e.message); }
  });

  router.post('/oauth/token', async (req,res)=>{
    try{
      console.log('OAUTH TOKEN REQ:', {grant_type:req.body.grant_type, client_id:req.body.client_id, hasCode:!!req.body.code, hasRefresh:!!req.body.refresh_token, code:req.body.code?.substring(0,10)});
      if(req.body.grant_type==='refresh_token'){
        if(req.body.refresh_token){
          try{
            let decoded;
            try{ decoded = jwt.verify(req.body.refresh_token, JWT_SECRET_NEW); }
            catch(e){ decoded = jwt.verify(req.body.refresh_token, JWT_SECRET_OLD); }
            const token=jwt.sign({userId:decoded.userId}, JWT_SECRET_NEW, {noTimestamp:true});
            console.log('TOKEN REFRESH OK for', decoded.userId);
            return res.json({access_token:token,refresh_token:req.body.refresh_token,token_type:'Bearer',expires_in:31536000});
          }catch(e){ console.log('refresh invalid', e.message); }
        }
      }
      const codeVal = req.body.code;
      if(!codeVal) return res.status(400).json({error:'missing code'});
      const entry=await Code.findOne({code:codeVal});
      if(!entry){
        console.log('TOKEN INVALID CODE', codeVal);
        const count = await Code.countDocuments({});
        console.log('Existing codes in DB:', count);
        return res.status(400).json({error:'invalid or expired code'});
      }
      if(entry.exp < Date.now()){
        console.log('TOKEN EXPIRED', entry.code);
        await Code.deleteOne({code:entry.code});
        return res.status(400).json({error:'expired code - please link again'});
      }
      const token=jwt.sign({userId:entry.userId}, JWT_SECRET_NEW, {noTimestamp:true});
      await Code.deleteOne({code:entry.code});
      console.log('TOKEN OK for', entry.userId);
      res.json({access_token:token,refresh_token:token,token_type:'Bearer',expires_in:31536000});
    }catch(e){ console.log('TOKEN ERROR', e.message, e.stack); res.status(500).json({error:e.message}); }
  });

  function authMiddleware(req,res,next){
    try{
      const token=req.headers.authorization?.replace('Bearer ','');
      if(!token) throw new Error('no token');
      req.user=verifyToken(token); next();
    }catch(e){ res.status(401).json({error:'unauth'}); }
  }

  return {router, authMiddleware, verifyToken};
};
