(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.JyotishCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_VERSION = 4;
  const FEE_RATE = 0.001;
  const MAX_PRICE_AGE_MS = 90_000;
  const TITHI_NAMES=['Pratipada','Dwitiya','Tritiya','Chaturthi','Panchami','Shashthi','Saptami','Ashtami','Navami','Dashami','Ekadashi','Dwadashi','Trayodashi','Chaturdashi','Purnima','Pratipada','Dwitiya','Tritiya','Chaturthi','Panchami','Shashthi','Saptami','Ashtami','Navami','Dashami','Ekadashi','Dwadashi','Trayodashi','Chaturdashi','Amavasya'];
  const NAKSHATRAS=['Ashwini','Bharani','Krittika','Rohini','Mrigashira','Ardra','Punarvasu','Pushya','Ashlesha','Magha','Purva Phalguni','Uttara Phalguni','Hasta','Chitra','Swati','Vishakha','Anuradha','Jyeshtha','Mula','Purva Ashadha','Uttara Ashadha','Shravana','Dhanishtha','Shatabhisha','Purva Bhadra','Uttara Bhadra','Revati'];
  const YOGAS=['Vishkambha','Priti','Ayushman','Saubhagya','Shobhana','Atiganda','Sukarma','Dhriti','Shula','Ganda','Vriddhi','Dhruva','Vyaghata','Harshana','Vajra','Siddhi','Vyatipata','Variyan','Parigha','Shiva','Siddha','Sadhya','Shubha','Shukla','Brahma','Mahendra','Vaidhriti'];
  const WEEKDAY_LORD=[0,3,6,2,5,1,4], CHALDEAN=['Sun','Venus','Mercury','Moon','Saturn','Jupiter','Mars'];
  const RAHU_SEGMENT=[8,2,7,5,6,4,3];
  const CHOGHADIYA={
    0:[['Udveg','Char','Labh','Amrit','Kaal','Shubh','Rog','Udveg'],['Shubh','Amrit','Char','Rog','Kaal','Labh','Udveg','Shubh']],
    1:[['Amrit','Kaal','Shubh','Rog','Udveg','Char','Labh','Amrit'],['Char','Labh','Amrit','Rog','Kaal','Udveg','Shubh','Char']],
    2:[['Rog','Udveg','Shubh','Amrit','Kaal','Char','Labh','Rog'],['Rog','Kaal','Udveg','Shubh','Amrit','Char','Labh','Rog']],
    3:[['Labh','Amrit','Kaal','Shubh','Rog','Udveg','Char','Labh'],['Labh','Shubh','Amrit','Char','Rog','Kaal','Udveg','Labh']],
    4:[['Shubh','Rog','Udveg','Char','Labh','Amrit','Kaal','Shubh'],['Kaal','Rog','Shubh','Amrit','Labh','Udveg','Char','Kaal']],
    5:[['Char','Labh','Amrit','Kaal','Shubh','Rog','Udveg','Char'],['Udveg','Char','Rog','Labh','Shubh','Amrit','Kaal','Udveg']],
    6:[['Kaal','Shubh','Rog','Udveg','Char','Labh','Amrit','Kaal'],['Amrit','Udveg','Labh','Shubh','Char','Rog','Kaal','Amrit']]
  };

  function finitePositive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function parseTickerList(rows, allowedSymbols) {
    if (!Array.isArray(rows)) throw new TypeError('Ticker response must be an array');
    const allowed = allowedSymbols ? new Set(allowedSymbols) : null;
    const result = {};
    for (const row of rows) {
      if (!row || typeof row.symbol !== 'string' || (allowed && !allowed.has(row.symbol))) continue;
      const price = finitePositive(row.lastPrice ?? row.price);
      const change = Number(row.priceChangePercent ?? row.P);
      const volume = Number(row.quoteVolume ?? row.q);
      if (price === null || !Number.isFinite(change) || !Number.isFinite(volume) || volume < 0) continue;
      result[row.symbol] = { symbol: row.symbol, price, changePct: change, quoteVolume: volume };
    }
    return result;
  }

  function calculateRsi(closes, period = 14) {
    if (!Array.isArray(closes) || !Number.isInteger(period) || period < 2 || closes.length <= period) return null;
    const values = closes.map(Number);
    if (values.some(v => !Number.isFinite(v) || v <= 0)) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const delta = values[i] - values[i - 1];
      gain += Math.max(0, delta); loss += Math.max(0, -delta);
    }
    let avgGain = gain / period, avgLoss = loss / period;
    for (let i = period + 1; i < values.length; i++) {
      const delta = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(0, delta)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -delta)) / period;
    }
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  function scoreMarket(stats) {
    if (!stats || finitePositive(stats.price) === null || !Number.isFinite(Number(stats.changePct)) || !Number.isFinite(Number(stats.quoteVolume))) return null;
    const rsi = stats.rsi != null && Number.isFinite(Number(stats.rsi)) ? Number(stats.rsi) : null;
    const change = Number(stats.changePct);
    const volume = Math.max(0, Number(stats.quoteVolume));
    let score = 50;
    if (rsi !== null) score += rsi < 30 ? 14 : rsi > 70 ? -10 : rsi >= 45 && rsi <= 60 ? 8 : 0;
    score += Math.max(-12, Math.min(12, change * 1.5));
    score += volume >= 100_000_000 ? 8 : volume >= 10_000_000 ? 4 : volume >= 1_000_000 ? 1 : -5;
    return { score: Math.round(Math.max(0, Math.min(100, score))), rsi, changePct: change, quoteVolume: volume };
  }

  function signalFor(stats, options = {}) {
    const market = scoreMarket(stats);
    if (!market) return null;
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 60;
    if (market.score < threshold) return null;
    const entry = Number(stats.price);
    const stopPct = Number.isFinite(options.stopPct) ? options.stopPct : 0.02;
    const targetPct = Number.isFinite(options.targetPct) ? options.targetPct : 0.03;
    return {
      symbol: stats.symbol,
      score: market.score,
      entry,
      stop: entry * (1 - stopPct),
      target: entry * (1 + targetPct),
      rsi: market.rsi,
      changePct: market.changePct,
      quoteVolume: market.quoteVolume,
      evaluatedAt: Number.isFinite(options.now) ? options.now : Date.now()
    };
  }

  function openPosition({ id, symbol, qty, entry, stop, target, openedAt = Date.now(), feeRate = FEE_RATE }) {
    const q = finitePositive(qty), p = finitePositive(entry);
    if (!q || !p || typeof symbol !== 'string' || !symbol) throw new TypeError('Position requires symbol, positive quantity and entry price');
    if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 0.1) throw new RangeError('Invalid fee rate');
    const normalizedStop = finitePositive(stop) ?? p * 0.98;
    const normalizedTarget = finitePositive(target) ?? p * 1.03;
    if (normalizedStop >= p || normalizedTarget <= p) throw new RangeError('Stop must be below entry and target above entry');
    return { id: id ?? `${symbol}-${openedAt}`, symbol, qty: q, entry: p, stop: normalizedStop, target: normalizedTarget, openedAt, feeRate, entryFee: q * p * feeRate, status: 'open' };
  }

  function markPosition(position, price) {
    const current = finitePositive(price);
    if (!current || !position || position.status !== 'open') return null;
    const gross = (current - position.entry) * position.qty;
    const exitFee = current * position.qty * position.feeRate;
    return { current, grossPnl: gross, fees: position.entryFee + exitFee, netPnl: gross - position.entryFee - exitFee };
  }

  function exitTrigger(position, price) {
    const current = finitePositive(price);
    if (!current || !position || position.status !== 'open') return null;
    if (current <= position.stop) return 'stop-loss';
    if (current >= position.target) return 'take-profit';
    return null;
  }

  function closePosition(position, price, reason = 'manual') {
    const mark = markPosition(position, price);
    if (!mark) throw new TypeError('Cannot close position without a valid market price');
    return { ...position, status: 'closed', exit: mark.current, exitAt: Date.now(), exitReason: reason, grossPnl: mark.grossPnl, fees: mark.fees, netPnl: mark.netPnl };
  }

  function freshness(now, lastUpdate, maxAge = MAX_PRICE_AGE_MS) {
    if (!Number.isFinite(lastUpdate) || lastUpdate <= 0) return { fresh: false, ageMs: null, label: 'Market data unavailable' };
    const ageMs = Math.max(0, now - lastUpdate);
    if (ageMs > maxAge) return { fresh: false, ageMs, label: `Stale market data · ${Math.ceil(ageMs / 1000)}s old` };
    return { fresh: true, ageMs, label: `Live prices · updated ${Math.max(0, Math.floor(ageMs / 1000))}s ago` };
  }

  function filterMarkets(coins, selected) {
    if (!Array.isArray(coins) || !Array.isArray(selected)) return [];
    const set = new Set(selected);
    if (set.has('global')) return coins.slice();
    return coins.filter(coin => Array.isArray(coin.markets) && coin.markets.some(m => set.has(m)));
  }

  function validateRisk({ notional, equity, dayLoss = 0, maxTradeFraction = 0.02, maxDailyLossFraction = 0.05, signalId, seenSignalIds = [], expiresAt, now = Date.now() }) {
    if (![notional, equity, dayLoss, maxTradeFraction, maxDailyLossFraction].every(Number.isFinite) || notional <= 0 || equity <= 0) return { ok: false, code: 'INVALID_RISK_INPUT' };
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || now > expiresAt)) return { ok: false, code: 'SIGNAL_EXPIRED' };
    if (signalId && seenSignalIds.includes(signalId)) return { ok: false, code: 'DUPLICATE_SIGNAL' };
    if (notional > equity * maxTradeFraction) return { ok: false, code: 'TRADE_LIMIT_EXCEEDED' };
    if (dayLoss >= equity * maxDailyLossFraction) return { ok: false, code: 'DAILY_LOSS_LIMIT' };
    return { ok: true, code: 'OK' };
  }

  function serializeState(state) {
    return JSON.stringify({ ...state, version: STATE_VERSION, savedAt: Date.now() });
  }

  function restoreState(raw) {
    try {
      const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!state || typeof state !== 'object' || !Array.isArray(state.positions) || !Array.isArray(state.history)) return null;
      return {
        version: STATE_VERSION,
        settings: state.settings && typeof state.settings === 'object' ? state.settings : {},
        portfolio: Number.isFinite(state.portfolio) ? state.portfolio : 100,
        positions: state.positions.filter(p => p && p.status === 'open' && finitePositive(p.entry) && finitePositive(p.qty)),
        history: state.history.filter(h => h && typeof h === 'object').slice(-500),
        legalAccepted: state.legalAccepted === true,
        onboardingDone: state.onboardingDone === true,
        savedAt: Number.isFinite(state.savedAt) ? state.savedAt : 0
      };
    } catch (_) { return null; }
  }

  function calculatePanchang(date, location, astronomy) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('A valid date is required');
    if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || !Number.isFinite(location.timezone)) throw new TypeError('A location with coordinates and timezone is required');
    if (!astronomy || !astronomy.Observer || !astronomy.AstroTime || !astronomy.SearchRiseSet || !astronomy.EclipticLongitude || !astronomy.SunPosition) throw new TypeError('Astronomy Engine is required');
    const tz=location.timezone, local=new Date(date.getTime()+tz*3600000), year=local.getUTCFullYear(), month=local.getUTCMonth(), day=local.getUTCDate();
    const weekday=new Date(Date.UTC(year,month,day)).getUTCDay(), midnightUtc=Date.UTC(year,month,day)-tz*3600000;
    const observer=new astronomy.Observer(location.latitude,location.longitude,location.elevation||0);
    const event=(direction,start,limit=1.5)=>astronomy.SearchRiseSet(astronomy.Body.Sun,observer,direction,new astronomy.AstroTime(new Date(start)),limit);
    const sunriseEvent=event(+1,midnightUtc), sunsetEvent=sunriseEvent&&event(-1,sunriseEvent.date.getTime()+60_000,1.2);
    if(!sunriseEvent||!sunsetEvent) return {available:false,reason:'Sunrise or sunset could not be calculated for this location/date'};
    const sunrise=sunriseEvent.date, sunset=sunsetEvent.date, nowMs=date.getTime(), daylight=sunset-sunrise;
    const prevSunsetEvent=event(-1,midnightUtc,1.2), prevSunset=prevSunsetEvent&&prevSunsetEvent.date;
    let segment, segmentKind, periodStart, periodEnd, periodIndex;
    if(nowMs>=sunrise.getTime()&&nowMs<sunset.getTime()){
      periodIndex=weekday;segmentKind='day';segment=Math.min(11,Math.floor((nowMs-sunrise.getTime())/(daylight/12)));periodStart=sunrise;periodEnd=sunset;
    } else if(nowMs>=sunset.getTime()) {
      const nextRise=event(+1,sunset.getTime()+60_000,1.2);
      if(!nextRise)return {available:false,reason:'Next sunrise could not be calculated'};
      periodIndex=weekday;segmentKind='night';segment=Math.min(11,Math.floor((nowMs-sunset.getTime())/((nextRise.date-sunset)/12)));periodStart=sunset;periodEnd=nextRise.date;
    } else {
      if(!prevSunset)return {available:false,reason:'Previous sunset could not be calculated'};
      periodIndex=(weekday+6)%7;segmentKind='night';segment=Math.min(11,Math.floor((nowMs-prevSunset.getTime())/((sunrise-prevSunset)/12)));periodStart=prevSunset;periodEnd=sunrise;
    }
    const hora=CHALDEAN[(WEEKDAY_LORD[periodIndex]+(segmentKind==='day'?segment:12+segment))%7];
    const horaDuration=(periodEnd-periodStart)/12, horaStart=new Date(periodStart.getTime()+segment*horaDuration), horaEnd=new Date(horaStart.getTime()+horaDuration);
    const chogDuration=(periodEnd-periodStart)/8, chogSegment=Math.min(7,Math.max(0,Math.floor((nowMs-periodStart.getTime())/chogDuration)));
    const choghadiya=CHOGHADIYA[periodIndex][segmentKind==='day'?0:1][chogSegment];
    const choghadiyaStart=new Date(periodStart.getTime()+chogSegment*chogDuration),choghadiyaEnd=new Date(choghadiyaStart.getTime()+chogDuration);
    const rahuStart=new Date(sunrise.getTime()+(RAHU_SEGMENT[weekday]-1)*daylight/8),rahuEnd=new Date(rahuStart.getTime()+daylight/8);
    const activeRahu=nowMs>=rahuStart.getTime()&&nowMs<rahuEnd.getTime();
    const astroTime=new astronomy.AstroTime(date), sun=astronomy.SunPosition(astroTime).elon;
    // EclipticLongitude() is heliocentric. Panchang needs the Moon's geocentric longitude.
    const moon=astronomy.Ecliptic(astronomy.GeoVector(astronomy.Body.Moon,astroTime,true)).elon;
    const jd=2440587.5+date.getTime()/86400000, centuries=(jd-2451545)/36525;
    const ayanamsa=23.85675+1.396042*centuries+0.000308*centuries*centuries;
    const siderealSun=((sun-ayanamsa)%360+360)%360, siderealMoon=((moon-ayanamsa)%360+360)%360;
    const phase=((moon-sun)%360+360)%360, yogaLongitude=(siderealSun+siderealMoon)%360;
    const tithiIndex=Math.min(29,Math.floor(phase/12)), nakshatraIndex=Math.min(26,Math.floor(siderealMoon/(360/27))), yogaIndex=Math.min(26,Math.floor(yogaLongitude/(360/27)));
    return {available:true,location:location.name||'Local',weekday,sunrise,sunset,rahuStart,rahuEnd,rahuActive:activeRahu,hora,horaStart,horaEnd,choghadiya,choghadiyaStart,choghadiyaEnd,segmentKind,segment,ayanamsa,tithi:TITHI_NAMES[tithiIndex],tithiIndex,nakshatra:NAKSHATRAS[nakshatraIndex],nakshatraIndex,yoga:YOGAS[yogaIndex],yogaIndex,phaseAngle:phase,moonLongitude:siderealMoon,sunLongitude:siderealSun};
  }

  return { STATE_VERSION, FEE_RATE, MAX_PRICE_AGE_MS, parseTickerList, calculateRsi, scoreMarket, signalFor, openPosition, markPosition, exitTrigger, closePosition, freshness, filterMarkets, validateRisk, serializeState, restoreState, calculatePanchang };
});
