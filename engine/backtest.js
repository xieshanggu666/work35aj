"use strict";
const ind = require("./indicators");

function buildSignal(rows, strategy) {
  const close = rows.map(r => r.close);
  const n = rows.length;
  const signal = new Array(n).fill(0);
  const st = strategy || {};
  if (st.type === "ma_cross") {
    const fast = ind.sma(close, st.fast || 10);
    const slow = ind.sma(close, st.slow || 30);
    for (let i = 1; i < n; i++) {
      if (fast[i] == null || slow[i] == null) continue;
      const prevF = fast[i - 1], prevS = slow[i - 1];
      if (prevF <= prevS && fast[i] > slow[i]) signal[i] = 1;
      else if (prevF >= prevS && fast[i] < slow[i]) signal[i] = 0;
      else signal[i] = signal[i - 1];
    }
  } else if (st.type === "rsi") {
    const r = ind.rsi(close, st.rsiN || 14);
    const buy = st.rsiBuy == null ? 30 : st.rsiBuy;
    const sell = st.rsiSell == null ? 70 : st.rsiSell;
    for (let i = 1; i < n; i++) {
      if (r[i] == null) continue;
      if (r[i] < buy) signal[i] = 1;
      else if (r[i] > sell) signal[i] = 0;
      else signal[i] = signal[i - 1];
    }
  } else if (st.type === "boll") {
    const b = ind.bollinger(close, st.bbN || 20, st.bbK == null ? 2 : st.bbK);
    for (let i = 1; i < n; i++) {
      if (b.lower[i] == null) continue;
      if (close[i] < b.lower[i]) signal[i] = 1;
      else if (close[i] > b.upper[i]) signal[i] = 0;
      else signal[i] = signal[i - 1];
    }
  } else if (st.type === "buy_hold") {
    for (let i = 0; i < n; i++) signal[i] = 1;
  }
  return signal;
}

// 波动状态：以「ATR / ATR 的均值」衡量当前波动相对近期常态的位置。
// 全部基于截至当根 K 线收盘已知的数据，状态用于下一根 K 线的入场决策。
// ratio 为 null（ATR 或其均值尚不可得）时按"正常"处理。
function volStateSeries(atrArr, win, lowK, highK) {
  const avg = ind.sma(atrArr.map(v => (v == null ? 0 : v)), win);
  return atrArr.map((v, i) => {
    let ratio = null;
    if (v != null && avg[i] != null && avg[i] > 0) ratio = v / avg[i];
    const state = ratio == null ? "正常" : ratio <= lowK ? "低波动" : ratio >= highK ? "高波动" : "正常";
    return { state, ratio };
  });
}

function stateMult(state, lowM, highM) {
  if (state === "高波动") return highM;
  if (state === "低波动") return lowM;
  return 1;
}

// 入场当日锁定初始止损/止盈触发价。
// fixed：入场价 ± 固定比例，与历史行为完全一致。
// atr：距离 = ATR(refIdx) × 倍数 × 波动状态乘数；refIdx 为入场前一根，杜绝前视。
// trail：初始价与 atr 同法，随后由 trailUpdate 按收盘数据逐日追踪、次日生效。
//        若入场前 ATR 尚不可得（数据预热期），回退到固定比例（可为 0 表示不设）。
function resolveStops(o) {
  const mode = o.mode === "atr" || o.mode === "trail" ? o.mode : "fixed";
  const dyn = mode === "atr" || mode === "trail";
  const ref = o.atrArr[o.refIdx];
  const vs = o.volArr[o.refIdx] || { state: "正常", ratio: null };
  const mult = stateMult(vs.state, o.lowMult, o.highMult);
  let stopPrice = 0;
  let targetPrice = 0;
  let atrUsed = null;
  if (dyn && ref != null && ref > 0) {
    atrUsed = ref;
    if (o.atrStopMult > 0) stopPrice = o.entryPrice - ref * o.atrStopMult * mult;
    if (o.atrTargetMult > 0) targetPrice = o.entryPrice + ref * o.atrTargetMult * mult;
  } else {
    if (o.stopLoss > 0) stopPrice = o.entryPrice * (1 - o.stopLoss);
    if (o.takeProfit > 0) targetPrice = o.entryPrice * (1 + o.takeProfit);
  }
  return {
    mode,
    stopPrice,
    targetPrice,
    atrRef: atrUsed,
    volState: vs.state,
    volRatio: vs.ratio,
    volMult: atrUsed == null ? 1 : mult,
  };
}

// trail 模式的逐日追踪：在第 i 根收盘后，用截至当根已知的数据重算触发价，供第 i+1 根使用。
// 止损（吊灯式）：窗口内最高价 − ATR(i)×倍数×波动乘数，且只上移不下移（锁定盈利）。
// 止盈：入场价 + ATR(i)×倍数×波动乘数，随波动收缩/扩张双向调整。
// ATR(i) 尚不可得时回退固定比例；不引用任何第 i 根之后的数据。
function trailUpdate(cur, o) {
  const i = o.barIdx;
  const ref = o.atrArr[i];
  const vs = o.volArr[i] || { state: "正常", ratio: null };
  const mult = stateMult(vs.state, o.lowMult, o.highMult);
  const from = o.trailHighN > 0 ? Math.max(o.entryIdx, i - o.trailHighN + 1) : o.entryIdx;
  let peak = o.rows[from].high;
  for (let j = from + 1; j <= i; j++) if (o.rows[j].high > peak) peak = o.rows[j].high;

  let candStop = 0;
  let candTarget = 0;
  let atrUsed = null;
  if (ref != null && ref > 0) {
    atrUsed = ref;
    if (o.atrStopMult > 0) candStop = peak - ref * o.atrStopMult * mult;
    if (o.atrTargetMult > 0) candTarget = o.entryPrice + ref * o.atrTargetMult * mult;
  } else {
    if (o.stopLoss > 0) candStop = o.entryPrice * (1 - o.stopLoss);
    if (o.takeProfit > 0) candTarget = o.entryPrice * (1 + o.takeProfit);
  }

  // 止损只上移；新候选不高于现价时维持上一档
  if (candStop > 0 && (cur.stopPrice === 0 || candStop > cur.stopPrice + 1e-10)) {
    if (cur.stopPrice > 0) cur.stopAdj++;
    cur.stopPrice = candStop;
  }
  // 止盈随波动双向追踪
  if (candTarget > 0 && Math.abs(candTarget - cur.targetPrice) > 1e-10) {
    if (cur.targetPrice > 0) cur.targetAdj++;
    cur.targetPrice = candTarget;
  }
  cur.atrRef = atrUsed;
  cur.volState = vs.state;
  cur.volRatio = vs.ratio;
  cur.volMult = atrUsed == null ? 1 : mult;
  cur.stopTrail.push([i + 1, cur.stopPrice]);
  cur.targetTrail.push([i + 1, cur.targetPrice]);
}

function backtest(market, opts, signalOverride) {
  const rows = market.rows;
  const n = rows.length;
  const opts2 = opts || {};
  const cash0 = opts2.cash || 100000;
  const feeRate = opts2.feeRate == null ? 0.0005 : opts2.feeRate;
  const slippage = (opts2.slippageBp == null ? 5 : opts2.slippageBp) / 10000;
  const stopLoss = opts2.stopLoss == null ? 0 : opts2.stopLoss;
  const takeProfit = opts2.takeProfit == null ? 0 : opts2.takeProfit;
  const positionRatio = opts2.positionRatio == null ? 1 : Math.max(0, Math.min(1, opts2.positionRatio));
  const signal = signalOverride || buildSignal(rows, opts2.strategy);

  // 止损止盈模式：默认 fixed，保持旧参数可复现；atr 入场锁定；trail 持仓期逐日追踪
  const stopMode = opts2.stopMode === "atr" || opts2.stopMode === "trail" ? opts2.stopMode : "fixed";
  const atrN = Math.max(2, opts2.atrN || 14);
  const atrStopMult = opts2.atrStopMult == null ? 2 : opts2.atrStopMult;
  const atrTargetMult = opts2.atrTargetMult == null ? 4 : opts2.atrTargetMult;
  const atrVolN = Math.max(2, opts2.atrVolN || 50);
  // trail 止损追踪的最高价窗口：0 表示自入场以来全部高点（吊灯式）
  const trailHighN = Math.max(0, opts2.trailHighN || 0);
  const volLowK = opts2.volLowK == null ? 0.7 : opts2.volLowK;
  const volHighK = opts2.volHighK == null ? 1.3 : opts2.volHighK;
  const volLowMult = opts2.volLowMult == null ? 0.8 : opts2.volLowMult;
  const volHighMult = opts2.volHighMult == null ? 1.5 : opts2.volHighMult;

  const atrArr = ind.atr(rows, atrN);
  const volArr = volStateSeries(atrArr, atrVolN, volLowK, volHighK);

  let cash = cash0;
  let shares = 0;
  let inPos = false;
  let entryPrice = 0;
  let entryIdx = 0;
  let stopOutBar = -1;
  let curStops = null;
  const equity = new Array(n).fill(null);
  // 与 K 线对齐的止损/止盈数据线：仅持仓段有值，供前端叠加逐日追踪轨迹
  const stopLine = new Array(n).fill(null);
  const targetLine = new Array(n).fill(null);
  const trades = [];

  function closeTrade(exitIdx, exitPrice, reason) {
    const px = exitPrice * (1 - slippage);
    cash = shares * px - shares * px * feeRate;
    trades.push({
      entry_idx: entryIdx,
      exit_idx: exitIdx,
      entry_date: rows[entryIdx].date,
      exit_date: rows[exitIdx].date,
      entry_price: entryPrice,
      exit_price: exitPrice,
      stop_price: curStops ? curStops.stopPrice : 0,
      target_price: curStops ? curStops.targetPrice : 0,
      init_stop_price: curStops ? curStops.initStop : 0,
      init_target_price: curStops ? curStops.initTarget : 0,
      stop_adj: curStops ? curStops.stopAdj : 0,
      target_adj: curStops ? curStops.targetAdj : 0,
      init_vol_state: curStops ? curStops.initVolState : "正常",
      init_vol_mult: curStops ? curStops.initVolMult : 1,
      stop_trail: curStops ? curStops.stopTrail : null,
      target_trail: curStops ? curStops.targetTrail : null,
      stop_mode: curStops ? curStops.mode : stopMode,
      atr_ref: curStops ? curStops.atrRef : null,
      vol_state: curStops ? curStops.volState : "正常",
      vol_mult: curStops ? curStops.volMult : 1,
      reason,
      shares,
      pnl: shares * exitPrice * (1 - slippage) - shares * entryPrice * (1 + slippage) - shares * exitPrice * feeRate - shares * entryPrice * feeRate,
      hold_bars: exitIdx - entryIdx,
    });
    shares = 0;
    inPos = false;
    curStops = null;
    if (reason === "止损" || reason === "止盈") stopOutBar = exitIdx;
  }

  for (let i = 0; i < n; i++) {
    const bar = rows[i];
    if (inPos) {
      // 记录当日实际生效的触发价（含退出当日），与前端 K 线叠加对齐
      stopLine[i] = curStops.stopPrice;
      targetLine[i] = curStops.targetPrice;
      const sl = curStops.stopPrice;
      const tp = curStops.targetPrice;
      let exitPrice = null;
      let reason = null;
      // 同一根 K 线内先判止损再判止盈；跳空越过触发价按开盘价成交
      if (sl > 0 && bar.low <= sl) {
        exitPrice = bar.open < sl ? bar.open : sl;
        reason = "止损";
      } else if (tp > 0 && bar.high >= tp) {
        exitPrice = bar.open > tp ? bar.open : tp;
        reason = "止盈";
      }
      if (exitPrice != null) closeTrade(i, exitPrice, reason);
    }
    const target = i > 0 ? signal[i - 1] : 0;
    const desired = target >= 0.5 ? positionRatio : 0;
    if (desired > 0 && !inPos && i > stopOutBar) {
      const px = bar.open * (1 + slippage);
      const amount = cash * desired;
      const sh = Math.floor(amount / px);
      if (sh > 0) {
        cash -= sh * px + sh * px * feeRate;
        shares = sh;
        inPos = true;
        entryPrice = bar.open;
        entryIdx = i;
        curStops = resolveStops({
          mode: stopMode,
          entryPrice,
          refIdx: i - 1,
          atrArr,
          volArr,
          stopLoss,
          takeProfit,
          atrStopMult,
          atrTargetMult,
          lowMult: volLowMult,
          highMult: volHighMult,
        });
        // 追踪模式补充初始快照与逐日轨迹；fixed/atr 锁定模式不产生轨迹
        curStops.initStop = curStops.stopPrice;
        curStops.initTarget = curStops.targetPrice;
        curStops.initVolState = curStops.volState;
        curStops.initVolMult = curStops.volMult;
        curStops.stopAdj = 0;
        curStops.targetAdj = 0;
        curStops.stopTrail = curStops.mode === "trail" ? [[i, curStops.stopPrice]] : null;
        curStops.targetTrail = curStops.mode === "trail" ? [[i, curStops.targetPrice]] : null;
      }
    } else if (desired === 0 && inPos) {
      closeTrade(i, bar.open, "信号平仓");
    }
    if (inPos && curStops.mode === "trail") {
      // 收盘后追踪：用当根及之前的数据重算，次日开盘起生效，无前视
      trailUpdate(curStops, {
        barIdx: i,
        entryIdx,
        entryPrice,
        rows,
        atrArr,
        volArr,
        trailHighN,
        stopLoss,
        takeProfit,
        atrStopMult,
        atrTargetMult,
        lowMult: volLowMult,
        highMult: volHighMult,
      });
    }
    equity[i] = cash + shares * bar.close;
  }

  const drawdown = computeDrawdown(equity);
  return {
    equity,
    drawdown,
    trades,
    stop_line: stopLine,
    target_line: targetLine,
    final_equity: equity[n - 1],
    total_return: equity[n - 1] / cash0 - 1,
    bars: n,
  };
}

function computeDrawdown(equity) {
  const out = new Array(equity.length).fill(0);
  let peak = equity[0];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    out[i] = peak > 0 ? equity[i] / peak - 1 : 0;
  }
  return out;
}

module.exports = { backtest, buildSignal, computeDrawdown, volStateSeries, resolveStops };
