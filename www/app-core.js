(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.JyotishCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_VERSION = 4;
  const FEE_RATE = 0.001;
  const MAX_PRICE_AGE_MS = 90_000;

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

  return { STATE_VERSION, FEE_RATE, MAX_PRICE_AGE_MS, parseTickerList, calculateRsi, scoreMarket, signalFor, openPosition, markPosition, exitTrigger, closePosition, freshness, filterMarkets, validateRisk, serializeState, restoreState };
});
