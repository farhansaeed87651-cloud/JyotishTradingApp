'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JyotishCore = require('../app-core.js');
const Astronomy = require('../vendor/astronomy.browser.min.js');

const COOKIE = 'orbit_sid';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const PBKDF2_ROUNDS = 210_000;
const LIVE_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';

function derive(password, salt) { return crypto.pbkdf2Sync(password, salt, PBKDF2_ROUNDS, 32, 'sha256').toString('base64'); }
function equal(a, b) { const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); }
function encrypt(text, key) { const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,iv), data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]); return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}; }
function decrypt(box, key) { const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64')); d.setAuthTag(Buffer.from(box.tag,'base64')); return Buffer.concat([d.update(Buffer.from(box.data,'base64')),d.final()]).toString('utf8'); }
function validateRisk({notional,equity,dayLoss=0,maxTradeFraction=.02,maxDailyLossFraction=.05,signalId,seen=[],expiresAt,now=Date.now()}) {
  if (![notional,equity,dayLoss].every(Number.isFinite) || notional<=0 || equity<=0) return {ok:false,code:'INVALID_RISK_INPUT'};
  if (expiresAt!==undefined && (!Number.isFinite(expiresAt)||now>expiresAt)) return {ok:false,code:'SIGNAL_EXPIRED'};
  if (signalId && seen.includes(signalId)) return {ok:false,code:'DUPLICATE_SIGNAL'};
  if (notional>equity*maxTradeFraction) return {ok:false,code:'TRADE_LIMIT_EXCEEDED'};
  if (dayLoss>=equity*maxDailyLossFraction) return {ok:false,code:'DAILY_LOSS_LIMIT'};
  return {ok:true,code:'OK'};
}
function createBinanceAdapter(fetchImpl=globalThis.fetch) {
  const live='https://api.binance.com',testnet='https://testnet.binance.vision';
  async function signed(base,method,route,query,key,secret) {
    const params=new URLSearchParams(query);params.set('timestamp',String(Date.now()));params.set('recvWindow','5000');
    const signature=crypto.createHmac('sha256',secret).update(params.toString()).digest('hex');params.set('signature',signature);
    const options={method,headers:{'X-MBX-APIKEY':key,'Accept':'application/json'},signal:AbortSignal.timeout(10000)};
    if(method==='GET'||method==='DELETE')options.method=method;
    else {options.headers['Content-Type']='application/x-www-form-urlencoded';options.body=params.toString()}
    const url=base+route+((method==='GET'||method==='DELETE')?'?'+params.toString():'');
    const response=await fetchImpl(url,options);let body={};try{body=await response.json()}catch(_){}
    if(!response.ok){const error=Error('Binance request failed');error.code=body.code===-2015?'KEY_AUTHENTICATION_FAILED':body.code===-1013?'ORDER_FILTER_REJECTED':body.code===-2010?'INSUFFICIENT_BALANCE':body.code===-1121?'UNSUPPORTED_SYMBOL':`BINANCE_${Math.abs(Number(body.code)||0)}`;throw error}
    return body;
  }
  return {
    async verifyKey(key,secret,environment='live') {
      if(environment==='testnet'){await signed(testnet,'GET','/api/v3/account',{},key,secret);return {read:true,spot:true,withdrawals:false,last4:key.slice(-4)}}
      const body=await signed(live,'GET','/sapi/v1/account/apiRestrictions',{},key,secret);
      return {read:body.enableReading===true,spot:body.enableSpotAndMarginTrading===true,withdrawals:body.enableWithdrawals===true,last4:key.slice(-4)};
    },
    async placeTestnetOrder(order,credentials) {
      if(!credentials)throw Object.assign(Error('Testnet API key is not configured'),{code:'TESTNET_KEY_REQUIRED'});
      const query={symbol:String(order.symbol),side:String(order.side||'BUY').toUpperCase(),type:String(order.type||'MARKET').toUpperCase(),quantity:String(order.quantity)};
      if(query.type==='LIMIT'){query.timeInForce='GTC';query.price=String(order.price)}
      const result=await signed(testnet,'POST','/api/v3/order',query,credentials.apiKey,credentials.secret);
      return {status:result.status,orderId:result.orderId,filledQty:result.executedQty||'0'};
    },
    async cancelTestnetOrder(orderId,credentials,order={}) {
      if(!credentials)throw Object.assign(Error('Testnet API key is not configured'),{code:'TESTNET_KEY_REQUIRED'});
      const result=await signed(testnet,'DELETE','/api/v3/order',{symbol:String(order.symbol||''),orderId:String(orderId)},credentials.apiKey,credentials.secret);
      return {status:result.status,orderId:result.orderId};
    }
  };
}
function createPublicProviders(fetchImpl=globalThis.fetch) {
  const symbols=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT','TRXUSDT'];
  const binance=async()=>{const r=await fetchImpl('https://api.binance.com/api/v3/ticker/24hr?symbols='+encodeURIComponent(JSON.stringify(symbols)),{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Binance HTTP '+r.status);return r.json()};Object.defineProperty(binance,'name',{value:'Binance'});
  const coinbase=async()=>{const products=['BTC-USD','ETH-USD','SOL-USD','XRP-USD','DOGE-USD','ADA-USD','LINK-USD','AVAX-USD','DOT-USD','LTC-USD'];const rows=await Promise.allSettled(products.map(async product=>{const r=await fetchImpl(`https://api.exchange.coinbase.com/products/${product}/stats`,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Coinbase HTTP '+r.status);const x=await r.json(),symbol=product.split('-')[0];return {symbol:symbol+'USDT',lastPrice:x.last,priceChangePercent:Number(x.open)?((Number(x.last)-Number(x.open))/Number(x.open))*100:0,quoteVolume:Number(x.volume||0)*Number(x.last||0)}}));const good=rows.filter(x=>x.status==='fulfilled').map(x=>x.value);if(!good.length)throw Error('Coinbase market data unavailable');return good};Object.defineProperty(coinbase,'name',{value:'Coinbase'});
  return [binance,coinbase];
}
function createServer({storePath, masterKey, exchange=createBinanceAdapter(), marketProviders=[]}={}) {
  if (!storePath) throw new TypeError('storePath is required');
  const vaultKey=Buffer.isBuffer(masterKey)?masterKey:Buffer.from(masterKey||'');
  if (vaultKey.length!==32) throw new TypeError('masterKey must contain exactly 32 bytes');
  fs.mkdirSync(path.dirname(storePath),{recursive:true});
  const empty=()=>({users:{}});
  let db=fs.existsSync(storePath)?JSON.parse(fs.readFileSync(storePath,'utf8')):empty();
  if (!db.users || typeof db.users!=='object') db=empty();
  const sessions=new Map(), attempts=new Map();
  const save=()=>{const fd=fs.openSync(storePath,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(db));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}};
  const respond=(res,status,payload,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(payload))};
  const readBody=req=>new Promise((resolve,reject)=>{let b='';req.on('data',chunk=>{b+=chunk;if(b.length>MAX_BODY){reject(Object.assign(Error('Request too large'),{status:413}));req.destroy()}});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(_){reject(Object.assign(Error('Invalid JSON'),{status:400}))}});req.on('error',reject)});
  const cookie=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  const auth=req=>{const token=cookie(req),s=token&&sessions.get(token);if(!s||s.expires<Date.now()){if(token)sessions.delete(token);return null}return {token,...s,user:db.users[s.userId]}};
  const requireAuth=(req,res)=>{const a=auth(req);if(!a||!a.user){respond(res,401,{error:'AUTH_REQUIRED'});return null}return a};
  const requireCsrf=(req,res,a)=>{if(!a||!equal(req.headers['x-csrf-token']||'',a.csrf)){respond(res,403,{error:'CSRF_REQUIRED'});return false}return true};
  const urlAllowed=req=>{if(!req.headers.origin)return true;const allowed=(process.env.APP_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);return allowed.includes(req.headers.origin)};
  const handler=async(req,res)=>{
    if(!urlAllowed(req)){respond(res,403,{error:'ORIGIN_NOT_ALLOWED'});return}
    if(req.headers.origin)res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
    res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-CSRF-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
    const u=new URL(req.url,'http://localhost'), route=u.pathname;
    try {
      if(req.method==='GET'&&route==='/healthz'){respond(res,200,{ok:true,liveTradingEnabled:LIVE_ENABLED});return}
      if(req.method==='GET'&&route==='/api/panchang'){
        const latitude=Number(u.searchParams.get('lat')??24.8607),longitude=Number(u.searchParams.get('lon')??67.0011),timezone=Number(u.searchParams.get('tz')??5);
        const dateValue=u.searchParams.get('date'),date=dateValue?new Date(dateValue):new Date();
        if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180||!Number.isFinite(timezone)||timezone < -14||timezone > 14||!Number.isFinite(date.getTime())){respond(res,400,{error:'INVALID_PANCHANG_INPUT'});return}
        const result=JyotishCore.calculatePanchang(date,{name:u.searchParams.get('name')||'Karachi',latitude,longitude,timezone},Astronomy);
        respond(res,200,{...result,engine:'Astronomy Engine',conventions:'Approximate traditional labels; informational only'});return
      }
      if(req.method==='POST'&&route==='/api/auth/register'){
        const b=await readBody(req), email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12){respond(res,400,{error:'INVALID_REGISTRATION'});return}
        if(Object.values(db.users).some(x=>x.email===email)){respond(res,409,{error:'ACCOUNT_EXISTS'});return}
        const id=crypto.randomUUID(),salt=crypto.randomBytes(16).toString('base64');db.users[id]={id,email,salt,passwordHash:derive(password,salt),exchangeKeys:{},positions:[],history:[],seenSignals:[],risk:{equity:100,dayLoss:0}};save();respond(res,201,{id});return;
      }
      if(req.method==='POST'&&route==='/api/auth/login'){
        const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),a=attempts.get(email)||{count:0,until:0};
        if(a.until>Date.now()){respond(res,429,{error:'LOGIN_THROTTLED'});return}
        const user=Object.values(db.users).find(x=>x.email===email), ok=!!user&&equal(derive(password,user.salt),user.passwordHash);
        if(!ok){a.count++;if(a.count>=8){a.count=0;a.until=Date.now()+15*60*1000;attempts.set(email,a);respond(res,429,{error:'LOGIN_THROTTLED'});return}attempts.set(email,a);respond(res,401,{error:'INVALID_CREDENTIALS'});return}
        attempts.delete(email);const token=crypto.randomBytes(32).toString('base64url'),csrf=crypto.randomBytes(24).toString('base64url');sessions.set(token,{userId:user.id,csrf,expires:Date.now()+SESSION_MS});respond(res,200,{csrfToken:csrf,email:user.email},{'Set-Cookie':`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${process.env.NODE_ENV==='production'?'; Secure':''}`});return;
      }
      if(req.method==='POST'&&route==='/api/auth/logout'){
        const a=requireAuth(req,res);if(!a||!requireCsrf(req,res,a))return;sessions.delete(a.token);respond(res,200,{ok:true},{'Set-Cookie':`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});return;
      }
      if(req.method==='GET'&&route==='/api/keys'){
        const a=requireAuth(req,res);if(!a)return;respond(res,200,{binance:a.user.exchangeKeys.binance?{last4:a.user.exchangeKeys.binance.last4}:null,binanceTestnet:a.user.exchangeKeys.binanceTestnet?{last4:a.user.exchangeKeys.binanceTestnet.last4}:null});return;
      }
      if(req.method==='PUT'&&(route==='/api/keys/binance'||route==='/api/keys/binance/testnet')){
        const a=requireAuth(req,res);if(!a||!requireCsrf(req,res,a))return;const b=await readBody(req),apiKey=String(b.apiKey||''),secret=String(b.secret||'');
        if(apiKey.length<12||secret.length<12||apiKey.length>256||secret.length>256){respond(res,400,{error:'INVALID_KEY_FORMAT'});return}
        const testKey=route.endsWith('/testnet');let p;try{p=await exchange.verifyKey(apiKey,secret,testKey?'testnet':'live')}catch(_){respond(res,401,{error:'KEY_AUTHENTICATION_FAILED'});return}
        if(!p||!p.read||!p.spot){respond(res,401,{error:'READ_AND_SPOT_PERMISSIONS_REQUIRED'});return}
        if(p.withdrawals){respond(res,400,{error:'WITHDRAWAL_PERMISSION_FORBIDDEN'});return}
        const name=testKey?'binanceTestnet':'binance';a.user.exchangeKeys[name]={last4:String(p.last4||apiKey.slice(-4)),box:encrypt(JSON.stringify({apiKey,secret}),vaultKey),verifiedAt:Date.now(),provider:testKey?'binance-spot-testnet':'binance-spot'};save();respond(res,200,{connected:true,last4:a.user.exchangeKeys[name].last4,environment:testKey?'testnet':'live-read-only'});return;
      }
      if(req.method==='GET'&&route==='/api/state'){
        const a=requireAuth(req,res);if(!a)return;respond(res,200,{positions:a.user.positions,history:a.user.history});return;
      }
      if(req.method==='PUT'&&route==='/api/state'){
        const a=requireAuth(req,res);if(!a||!requireCsrf(req,res,a))return;const b=await readBody(req);
        if(!Array.isArray(b.positions)||!Array.isArray(b.history)){respond(res,400,{error:'INVALID_STATE'});return}
        a.user.positions=b.positions.slice(-100);a.user.history=b.history.slice(-1000);save();respond(res,200,{ok:true});return;
      }
      if(req.method==='POST'&&route==='/api/orders/live'){
        respond(res,403,{error:LIVE_ENABLED?'LIVE_EXECUTION_DISABLED_IN_MVP':'LIVE_TRADING_DISABLED'});return;
      }
      if(req.method==='POST'&&route==='/api/testnet/orders'){
        const a=requireAuth(req,res);if(!a||!requireCsrf(req,res,a))return;const b=await readBody(req),notional=Number(b.quantity)*Number(b.price),user=a.user;
        const risk=validateRisk({notional,equity:user.risk.equity,dayLoss:user.risk.dayLoss,signalId:String(b.signalId||''),seen:user.seenSignals,expiresAt:Number(b.expiresAt),now:Date.now()});
        if(!risk.ok){respond(res,409,{error:risk.code});return}
        if(!user.exchangeKeys.binanceTestnet){respond(res,400,{error:'TESTNET_KEY_REQUIRED'});return}
        try{const creds=JSON.parse(decrypt(user.exchangeKeys.binanceTestnet.box,vaultKey));const result=await exchange.placeTestnetOrder(b,creds);if(!result||!['NEW','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED'].includes(result.status)){respond(res,502,{error:'INVALID_EXCHANGE_RESPONSE'});return}user.seenSignals.push(String(b.signalId));user.history.push({symbol:b.symbol,status:result.status,orderId:result.orderId||null,time:Date.now()});save();respond(res,200,{status:result.status,orderId:result.orderId||null,filledQty:result.filledQty||'0',message:`Testnet order status: ${result.status}`});return}catch(e){respond(res,502,{error:e.code||'TESTNET_ORDER_FAILED',message:'No order success was reported.'});return}
      }
      if(req.method==='DELETE'&&route.startsWith('/api/testnet/orders/')){
        const a=requireAuth(req,res);if(!a||!requireCsrf(req,res,a))return;try{const box=a.user.exchangeKeys.binanceTestnet;if(!box){respond(res,400,{error:'TESTNET_KEY_REQUIRED'});return}const creds=JSON.parse(decrypt(box.box,vaultKey)),orderId=route.split('/').pop(),entry=a.user.history.find(h=>String(h.orderId)===String(orderId));const result=await exchange.cancelTestnetOrder(orderId,creds,{symbol:entry?.symbol});if(!result||!['CANCELED','FILLED','REJECTED'].includes(result.status)){respond(res,502,{error:'INVALID_EXCHANGE_RESPONSE'});return}if(entry)entry.status=result.status;save();respond(res,200,{status:result.status,orderId:result.orderId||null});return}catch(e){respond(res,502,{error:e.code||'TESTNET_CANCEL_FAILED'});return}
      }
      if(req.method==='GET'&&route==='/api/market/ticker'){
        let lastError;for(const provider of marketProviders){try{const value=await provider();if(Array.isArray(value)&&value.length){respond(res,200,{source:provider.name||'exchange',data:value,updatedAt:Date.now()});return}}catch(e){lastError=e}}
        respond(res,503,{error:'MARKET_DATA_UNAVAILABLE',message:lastError?.message||'All market sources are unavailable'});return;
      }
      respond(res,404,{error:'NOT_FOUND'});
    } catch(e) { console.error('Orbit backend request failed:',e.code||e.name||'Error'); respond(res,e.status||500,{error:e.status?e.message:'INTERNAL_ERROR'}); }
  };
  const server=http.createServer(handler);
  return {server,db,save,close:()=>new Promise(resolve=>server.close(resolve)),listen:(port=0,host='127.0.0.1')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address()))})};
}

function loadVaultKey(dataDir){
  if(process.env.VAULT_MASTER_KEY){const k=Buffer.from(process.env.VAULT_MASTER_KEY,'base64');if(k.length!==32)throw Error('VAULT_MASTER_KEY must be a base64-encoded 32-byte key');return k}
  if(process.env.NODE_ENV==='production')throw Error('Set VAULT_MASTER_KEY before starting in production');
  fs.mkdirSync(dataDir,{recursive:true});const file=path.join(dataDir,'dev-vault.key');if(!fs.existsSync(file))fs.writeFileSync(file,crypto.randomBytes(32),{mode:0o600});return fs.readFileSync(file);
}
if(require.main===module){const dataDir=process.env.DATA_DIR||path.join(__dirname,'data'),storePath=path.join(dataDir,'store.json');const s=createServer({storePath,masterKey:loadVaultKey(dataDir),marketProviders:createPublicProviders()});const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8787);s.listen(port,host).then(()=>console.log(`Orbit Trader paper backend listening on ${host}:${port}; live orders disabled`)).catch(e=>{console.error(e.message);process.exitCode=1})}

module.exports={createServer,derive,encrypt,decrypt,validateRisk,loadVaultKey,createPublicProviders,createBinanceAdapter};
