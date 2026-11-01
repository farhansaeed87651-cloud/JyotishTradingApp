const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../app-core.js');
const Astronomy = require('../vendor/astronomy.browser.min.js');

const closesUp = Array.from({ length: 20 }, (_, i) => 100 + i);
const closesDown = Array.from({ length: 20 }, (_, i) => 120 - i);
const base = { symbol: 'BTC', price: 100, changePct: 4, quoteVolume: 200_000_000, rsi: 52 };

test('01 parses an allowed Binance ticker', () => assert.equal(C.parseTickerList([{symbol:'BTCUSDT',lastPrice:'100',priceChangePercent:'1.2',quoteVolume:'50'}], ['BTCUSDT']).BTCUSDT.price, 100));
test('02 ignores symbols outside the watchlist', () => assert.deepEqual(C.parseTickerList([{symbol:'ETHUSDT',lastPrice:'2',priceChangePercent:'1',quoteVolume:'3'}], ['BTCUSDT']), {}));
test('03 rejects a non-array ticker payload', () => assert.throws(() => C.parseTickerList({} , []), TypeError));
test('04 ignores zero and invalid prices', () => assert.deepEqual(C.parseTickerList([{symbol:'X',lastPrice:'0',priceChangePercent:'0',quoteVolume:'2'}]), {}));
test('05 RSI needs at least period plus one close', () => assert.equal(C.calculateRsi([1,2,3],14), null));
test('06 RSI is 100 for a continuously rising series', () => assert.equal(C.calculateRsi(closesUp,14), 100));
test('07 RSI is 0 for a continuously falling series', () => assert.equal(C.calculateRsi(closesDown,14), 0));
test('08 RSI is neutral for a flat series', () => assert.equal(C.calculateRsi(Array(20).fill(5),14), 50));
test('09 RSI uses Wilder smoothing for later candles', () => assert.ok(C.calculateRsi([...closesUp, 110],14) < 100));
test('10 RSI rejects nonpositive close values', () => assert.equal(C.calculateRsi([1,2,3,4,5,6,7,8,9,10,11,12,13,14,0],14), null));
test('11 market score requires a current price', () => assert.equal(C.scoreMarket({...base,price:0}), null));
test('12 market score is deterministic for unchanged data', () => assert.deepEqual(C.scoreMarket(base), C.scoreMarket(base)));
test('13 market score stays within 0 to 100', () => assert.ok(C.scoreMarket({...base,changePct:1e9,quoteVolume:1e20}).score <= 100));
test('14 a strong market snapshot produces a signal', () => assert.ok(C.signalFor(base,{now:1234})));
test('15 unchanged market data produces the same signal values', () => assert.deepEqual(C.signalFor(base,{now:1234}), C.signalFor(base,{now:1234})));
test('16 a low score stays below the configured threshold', () => assert.equal(C.signalFor({...base,changePct:-100,quoteVolume:1},{threshold:60}), null));
test('17 signal stop and target derive from current price', () => {const s=C.signalFor(base);assert.equal(s.stop,98);assert.equal(s.target,103)});
test('18 opening a position rejects zero quantity', () => assert.throws(() => C.openPosition({symbol:'BTC',qty:0,entry:1}), TypeError));
test('19 opening a position requires stop below entry', () => assert.throws(() => C.openPosition({symbol:'BTC',qty:1,entry:100,stop:101,target:103}), RangeError));
test('20 position valuation uses the current market price', () => assert.equal(C.markPosition(C.openPosition({symbol:'BTC',qty:1,entry:100}),110).grossPnl,10));
test('21 both entry and exit fees are included', () => assert.ok(Math.abs(C.markPosition(C.openPosition({symbol:'BTC',qty:1,entry:100,feeRate:.001}),110).fees-.21)<1e-10));
test('22 stop-loss triggers at or below the stop', () => {const p=C.openPosition({symbol:'BTC',qty:1,entry:100,stop:98,target:103});assert.equal(C.exitTrigger(p,98),'stop-loss')});
test('23 take-profit triggers at or above target', () => {const p=C.openPosition({symbol:'BTC',qty:1,entry:100,stop:98,target:103});assert.equal(C.exitTrigger(p,104),'take-profit')});
test('24 a price inside the limits does not trigger an exit', () => {const p=C.openPosition({symbol:'BTC',qty:1,entry:100,stop:98,target:103});assert.equal(C.exitTrigger(p,101),null)});
test('25 close records net P&L after fees and the reason', () => {const p=C.openPosition({symbol:'BTC',qty:1,entry:100});const c=C.closePosition(p,110,'manual');assert.equal(c.exitReason,'manual');assert.ok(c.netPnl<c.grossPnl)});
test('26 missing timestamp is unavailable', () => assert.equal(C.freshness(1000,null).fresh,false));
test('27 a recent timestamp is fresh', () => assert.equal(C.freshness(1000,950).fresh,true));
test('28 an old timestamp is stale', () => assert.equal(C.freshness(100000,1).fresh,false));
test('29 global market filter retains every symbol', () => assert.equal(C.filterMarkets([{symbol:'A'},{symbol:'B'}],['global']).length,2));
test('30 regional filter selects tagged symbols', () => assert.deepEqual(C.filterMarkets([{symbol:'A',markets:['uk']},{symbol:'B',markets:['usa']}],['uk']).map(x=>x.symbol),['A']));
test('31 invalid filter inputs return an empty list', () => assert.deepEqual(C.filterMarkets(null,['uk']),[]));
test('32 a trade within configured limits is allowed', () => assert.equal(C.validateRisk({notional:1,equity:100}).ok,true));
test('33 oversized trades are blocked', () => assert.equal(C.validateRisk({notional:3,equity:100}).code,'TRADE_LIMIT_EXCEEDED'));
test('34 daily drawdown cap blocks new trades', () => assert.equal(C.validateRisk({notional:1,equity:100,dayLoss:5}).code,'DAILY_LOSS_LIMIT'));
test('35 duplicate signals are blocked', () => assert.equal(C.validateRisk({notional:1,equity:100,signalId:'x',seenSignalIds:['x']}).code,'DUPLICATE_SIGNAL'));
test('36 expired signals are blocked', () => assert.equal(C.validateRisk({notional:1,equity:100,expiresAt:1,now:2}).code,'SIGNAL_EXPIRED'));
test('37 state round-trips including positions, history and onboarding', () => {const s={portfolio:100,settings:{session:'pak'},positions:[C.openPosition({symbol:'BTC',qty:1,entry:100})],history:[{symbol:'ETH',decision:'rejected'}],legalAccepted:true,onboardingDone:true};const r=C.restoreState(C.serializeState(s));assert.equal(r.positions.length,1);assert.equal(r.history.length,1);assert.equal(r.onboardingDone,true)});
test('38 corrupt state is rejected without throwing', () => assert.equal(C.restoreState('{broken'), null));
test('39 Karachi Panchang matches the verified 2026-11-01 morning snapshot', () => {
  const p=C.calculatePanchang(new Date('2026-11-01T04:00:00Z'),{name:'Karachi',latitude:24.8607,longitude:67.0011,timezone:5},Astronomy);
  assert.equal(p.tithi,'Saptami'); assert.equal(p.nakshatra,'Pushya'); assert.equal(p.yoga,'Sadhya');
  assert.equal(p.hora,'Mercury'); assert.equal(p.choghadiya,'Char');
  const later=C.calculatePanchang(new Date('2026-11-01T10:00:00Z'),{name:'Karachi',latitude:24.8607,longitude:67.0011,timezone:5},Astronomy);
  assert.equal(later.tithi,'Ashtami'); assert.equal(later.nakshatra,'Pushya'); assert.equal(later.yoga,'Shubha');
  const local=d=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(Math.round(d.getTime()/60000)*60000));
  assert.equal(local(p.sunrise),'06:39'); assert.equal(local(p.sunset),'17:52');
  assert.equal(local(p.rahuStart),'16:28'); assert.equal(local(p.rahuEnd),'17:52');
});
test('40 weekly planetary hora and day Choghadiya start sequences use weekday order', () => {
  const location={name:'Karachi',latitude:24.8607,longitude:67.0011,timezone:5};
  const firstHoras=['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn'];
  const firstChoghadiya=['Udveg','Amrit','Rog','Labh','Shubh','Char','Kaal'];
  for(let day=1;day<=7;day++){
    const noon=new Date(Date.UTC(2026,10,day,7));
    const start=C.calculatePanchang(noon,location,Astronomy);
    const atSunrise=C.calculatePanchang(new Date(start.sunrise.getTime()+60_000),location,Astronomy);
    assert.equal(atSunrise.hora,firstHoras[day-1],`weekday ${day-1} hora`);
    assert.equal(atSunrise.choghadiya,firstChoghadiya[day-1],`weekday ${day-1} Choghadiya`);
  }
});

