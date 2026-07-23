/* ── GammaEdge shared signal core ──────────────────────────────────────────
 * Single source of truth for the three "what's happening in SPY/QQQ right
 * now" reads that used to be computed independently in different files/tabs:
 *
 *   geVolSignal()      — IV vs RV → sell-vol / buy-vol / neutral
 *                         (previously duplicated inline in index.html's
 *                          StratEdge/VolSignal card)
 *   geMomentumSignal()  — RSI-14 + 20d MA + 3d momentum → directional read
 *                         (previously: quickSignal() had the real version,
 *                          processSignalForPlan() had a cruder 1-day-change
 *                          version that could silently disagree with it)
 *   geBreachSignal()    — % move vs an alert threshold → spike/crash scenario
 *                         (previously only in BigChances.html)
 *
 * Pure functions, no DOM/fetch — each file keeps its own UI/rendering and
 * its own data fetching, but the math itself now lives in exactly one place.
 * Canonical source of truth — copy this file's contents in place of
 * a <script> tag rather than referencing it by src, so files that use it
 * stay single, self-contained HTML files (matches how this project ships).
 * ──────────────────────────────────────────────────────────────────────── */
(function(root){

  /* ---- Vol signal: IV vs RV ------------------------------------------- */
  // iv, rv are annualized % (e.g. 24.3). Returns null-safe object.
  function geVolSignal(iv, rv){
    iv = +iv || 0; rv = +rv || 0;
    var spread = +(iv - rv).toFixed(1);
    var spreadPct = rv > 0 ? +(spread / rv * 100).toFixed(0) : 0;
    var signal, confidence, color, bg, action;
    if (spread >= 5) {
      signal = 'SELL VOL';
      confidence = Math.min(95, 60 + spreadPct);
      color = '#f43f5e'; bg = 'rgba(244,63,94,.08)';
      action = 'IV is <strong>rich vs RV</strong> — premium selling favored. Consider Iron Condor or short Strangle.';
    } else if (spread <= -3) {
      signal = 'BUY VOL';
      confidence = Math.min(95, 60 + Math.abs(spreadPct));
      color = '#34d399'; bg = 'rgba(52,211,153,.08)';
      action = 'IV is <strong>cheap vs RV</strong> — long vol favored. Consider Straddle or Strangle.';
    } else {
      signal = 'NEUTRAL';
      confidence = 30;
      color = '#64748b'; bg = 'rgba(100,116,139,.08)';
      action = 'IV and RV <strong>near parity</strong> — no strong vol edge.';
    }
    return { signal:signal, confidence:+confidence.toFixed(0), spread:spread,
      spreadPct:spreadPct, color:color, bg:bg, action:action, iv:iv, rv:rv };
  }

  /* ---- Momentum signal: RSI-14 + 20d MA + 3d momentum ------------------ *
   * closes: array of daily closes, oldest→newest, needs >= 20 bars.
   * spot: current live price (falls back to last close if not provided).
   * Returns {noData:true} if there isn't enough real history — callers
   * should show "awaiting data" rather than fabricate a signal, since a
   * short/random series is biased toward false PUT leans. */
  function geMomentumSignal(closes, spot){
    if (!closes || closes.length < 20) return { noData:true };
    var n = closes.length;
    if (!(spot > 0)) spot = closes[n-1];

    // Gap injection: if live price has moved meaningfully from the last
    // close, fold it into the series so RSI/MA reflect the current gap.
    var lastClose = closes[n-1];
    var gapPct = lastClose > 0 ? (spot - lastClose) / lastClose * 100 : 0;
    if (Math.abs(gapPct) >= 0.75) { closes = closes.concat([spot]); n = closes.length; }

    var ma20 = closes.slice(-20).reduce(function(a,b){ return a+b; }, 0) / 20;
    var aboveMA = spot > ma20;

    var gains = 0, losses = 0;
    for (var j = n-14; j < n; j++){
      var diff = closes[j] - closes[j-1];
      if (diff > 0) gains += diff; else losses += Math.abs(diff);
    }
    var rs = (gains/14) / ((losses/14) || 0.001);
    var rsi = 100 - 100/(1+rs);
    var mom3 = (closes[n-1] - closes[n-4]) / closes[n-4] * 100;

    var bull = 0, bear = 0;
    if (aboveMA) bull += 2; else bear += 2;
    if (rsi > 65) bear += 2; else if (rsi > 55) bull += 1; else if (rsi < 35) bull += 2; else if (rsi < 45) bear += 1;
    if (mom3 > 1.5) bull += 2; else if (mom3 > 0.5) bull += 1; else if (mom3 < -1.5) bear += 2; else if (mom3 < -0.5) bear += 1;

    var action, colorKey;
    if (bull >= 5 && bull > bear*1.5) { action='BUY CALL'; colorKey='strongBull'; }
    else if (bear >= 5 && bear > bull*1.5) { action='BUY PUT'; colorKey='strongBear'; }
    else if (bull > bear) { action='LEAN CALL'; colorKey='leanBull'; }
    else if (bear > bull) {
      if (rsi >= 65 && aboveMA) { action='BUY PUT'; colorKey='strongBear'; }
      else { action='LEAN PUT'; colorKey='leanBear'; }
    } else {
      if (rsi > 65) { action='LEAN PUT (small)'; colorKey='leanBear'; }
      else if (rsi < 35) { action='LEAN CALL (small)'; colorKey='leanBull'; }
      else { action='NO TRADE'; colorKey='neutral'; }
    }

    var conf = (bull >= 7 || bear >= 7) ? 'High' : (bull >= 5 || bear >= 5) ? 'Medium' : 'Low';
    var sub = action.indexOf('CALL') > -1 ? 'Bullish' : action.indexOf('PUT') > -1 ? 'Bearish' : 'Wait';
    var detail = 'RSI ' + rsi.toFixed(0) + ' · ' + (aboveMA ? 'Above' : 'Below') + ' MA · '
      + (mom3 >= 0 ? '+' : '') + mom3.toFixed(1) + '% 3d';

    return { action:action, colorKey:colorKey, conf:conf, sub:sub, detail:detail,
      bull:bull, bear:bear, rsi:rsi, ma20:ma20, aboveMA:aboveMA, mom3:mom3, noData:false };
  }

  /* ---- Breach signal: % move vs threshold ------------------------------ *
   * pctChange: today's % move. threshold: alert level for this symbol
   * (e.g. 1.5 for SPY, 2.0 for QQQ). Flash scenarios trigger at 1.3x. */
  function geBreachSignal(pctChange, threshold){
    pctChange = +pctChange || 0; threshold = +threshold || 1.5;
    var scenario = 'NORMAL', breached = false;
    if (pctChange <= -threshold*1.3) { scenario='FLASH_CRASH'; breached=true; }
    else if (pctChange <= -threshold) { scenario='STANDARD_DOWN'; breached=true; }
    else if (pctChange >= threshold*1.3) { scenario='FLASH_SPIKE'; breached=true; }
    else if (pctChange >= threshold) { scenario='STANDARD_UP'; breached=true; }
    return { scenario:scenario, breached:breached, pctChange:pctChange, threshold:threshold };
  }

  /* ---- Combined read: everything one caller needs in one call --------- */
  function geUnifiedRead(o){
    o = o || {};
    return {
      vol: (o.iv != null && o.rv != null) ? geVolSignal(o.iv, o.rv) : null,
      momentum: o.closes ? geMomentumSignal(o.closes, o.spot) : null,
      breach: (o.pctChange != null) ? geBreachSignal(o.pctChange, o.threshold) : null
    };
  }

  var api = { geVolSignal:geVolSignal, geMomentumSignal:geMomentumSignal,
    geBreachSignal:geBreachSignal, geUnifiedRead:geUnifiedRead };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else for (var k in api) root[k] = api[k];

})(typeof window !== 'undefined' ? window : globalThis);
