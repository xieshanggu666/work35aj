"use strict";
const assert = require("assert");
const market = require("../engine/market");
const ind = require("../engine/indicators");
const bt = require("../engine/backtest");
const metrics = require("../engine/metrics");
const mc = require("../engine/montecarlo");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

t("sma 手算正确", () => {
  const v = [1, 2, 3, 4, 5];
  const s = ind.sma(v, 3);
  assert.strictEqual(s[2], 2);
  assert.strictEqual(s[3], 3);
  assert.strictEqual(s[4], 4);
  assert.strictEqual(s[1], null);
});

t("ema 首值等于输入首值", () => {
  const e = ind.ema([10, 20, 30], 3);
  assert.strictEqual(e[0], 10);
  assert(e[2] > 20 && e[2] < 30);
});

t("rsi 单调上涨接近 100", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = ind.rsi(up, 14);
  assert(r[29] > 99);
});

t("rsi 单调下跌接近 0", () => {
  const dn = Array.from({ length: 30 }, (_, i) => 200 - i);
  const r = ind.rsi(dn, 14);
  assert(r[29] < 1);
});

t("macd 信号线为 line 的平滑", () => {
  const v = [10, 11, 12, 11, 13, 14, 13, 15, 16, 17, 16, 18, 19, 20, 21];
  const m = ind.macd(v, 3, 6, 4);
  assert.strictEqual(m.line.length, v.length);
  assert.strictEqual(m.signal.length, v.length);
  assert(m.signal[14] != null);
});

t("bollinger 上下轨对称", () => {
  const v = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
  const b = ind.bollinger(v, 10, 2);
  for (let i = 9; i < 30; i++) {
    assert(b.upper[i] > b.mid[i]);
    assert(b.lower[i] < b.mid[i]);
    assert(Math.abs((b.upper[i] - b.mid[i]) - (b.mid[i] - b.lower[i])) < 1e-9);
  }
});

t("atr 正值且首 n-1 为 null", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i, low: 95 + i, close: 98 + i }));
  const a = ind.atr(rows, 14);
  assert.strictEqual(a[12], null);
  assert(a[13] > 0);
  for (let i = 14; i < 20; i++) assert(a[i] > 0);
});

t("行情生成确定性（同种子同结果）", () => {
  const a = market.generateMarket({ seed: 7, days: 100 });
  const b = market.generateMarket({ seed: 7, days: 100 });
  assert.deepStrictEqual(a.rows, b.rows);
  assert.strictEqual(a.dates.length, 100);
});

t("行情价格恒正且高低有序", () => {
  const m = market.generateMarket({ seed: 3, days: 300, vol: 0.03 });
  for (const r of m.rows) {
    assert(r.high >= Math.max(r.open, r.close));
    assert(r.low <= Math.min(r.open, r.close));
    assert(r.open > 0 && r.close > 0);
  }
});

t("前复权缩放历史价格", () => {
  const m = market.generateMarket({ seed: 1, days: 100 });
  const adj = market.adjustForward(m.rows, 50, 0.5);
  assert(Math.abs(adj[49].close * 1.5 - m.rows[49].close) < 1e-9);
  assert.strictEqual(adj[50].close, m.rows[50].close);
});

t("信号延迟一日于开盘成交", () => {
  const rows = [
    { date: "2023-01-01", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-02", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-03", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "2023-01-04", open: 50, high: 55, low: 48, close: 52, volume: 1 },
    { date: "2023-01-05", open: 52, high: 56, low: 50, close: 54, volume: 1 },
    { date: "2023-01-06", open: 54, high: 58, low: 52, close: 56, volume: 1 },
  ];
  const signal = [0, 0, 1, 1, 0, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].entry_price, 50);
  assert.strictEqual(r.trades[0].entry_idx, 3);
  assert.strictEqual(r.trades[0].exit_price, 54);
  assert.strictEqual(r.trades[0].exit_idx, 5);
});

t("止损触发价处理跳空", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 85, high: 90, low: 80, close: 86, volume: 1 },
  ];
  const signal = [0, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].entry_price, 100);
  assert.strictEqual(r.trades[0].exit_price, 85);
});

t("止损无跳空时按止损价成交", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 95, high: 96, low: 85, close: 90, volume: 1 },
  ];
  const signal = [0, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].exit_price, 90);
  assert.strictEqual(r.trades[0].reason, "止损");
});

t("止损平仓当日不再重新开仓", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d3", open: 100, high: 101, low: 85, close: 90, volume: 1 },
    { date: "d4", open: 95, high: 96, low: 85, close: 90, volume: 1 },
    { date: "d5", open: 90, high: 92, low: 88, close: 91, volume: 1 },
  ];
  const signal = [0, 1, 1, 1, 0];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
});

t("手续费与滑点计入成本", () => {
  const rows = [
    { date: "d1", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d2", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d3", open: 10, high: 11, low: 9, close: 10, volume: 1 },
  ];
  const signal = [0, 1, 0];
  const r0 = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: {} }, signal);
  const r1 = bt.backtest({ rows }, { cash: 10000, feeRate: 0.01, slippageBp: 100, strategy: {} }, signal);
  assert(r1.final_equity < r0.final_equity);
});

t("买入持有权益随收盘价变化", () => {
  const rows = [
    { date: "d1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "d2", open: 100, high: 110, low: 99, close: 110, volume: 1 },
  ];
  const r = bt.backtest({ rows }, { cash: 10000, feeRate: 0, slippageBp: 0, strategy: { type: "buy_hold" } });
  assert.strictEqual(r.final_equity, 11000);
});

t("最大回撤计算正确", () => {
  const eq = [100, 120, 110, 130, 90];
  const dd = metrics.maxDrawdown(eq);
  assert(Math.abs(dd.maxDD - (90 / 130 - 1)) < 1e-9);
  assert.strictEqual(dd.start, 3);
  assert.strictEqual(dd.end, 4);
});

t("指标汇总总收益与年化", () => {
  const eq = [100, 100, 100, 121];
  const s = metrics.summarize(eq, { periodsPerYear: 3 });
  assert(Math.abs(s.total_return - 0.21) < 1e-9);
  assert(Math.abs(s.cagr - Math.pow(1.21, 1) + 1) < 1e-9);
});

t("夏普在有波动时有限", () => {
  const eq = [100, 102, 101, 104, 103, 106];
  const s = metrics.summarize(eq, { periodsPerYear: 252, riskFree: 0 });
  assert(Number.isFinite(s.sharpe));
});

t("蒙特卡洛分位数单调", () => {
  const eq = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const r = mc.simulate(eq, 500, 50, 11);
  assert.strictEqual(r.quantiles.p5.length, 51);
  for (let i = 0; i <= 50; i++) {
    assert(r.quantiles.p5[i] <= r.quantiles.p50[i] + 1e-9);
    assert(r.quantiles.p50[i] <= r.quantiles.p95[i] + 1e-9);
  }
  assert(r.prob_loss >= 0 && r.prob_loss <= 1);
});

t("蒙特卡洛确定性", () => {
  const eq = [100, 101, 102, 103, 104];
  const a = mc.simulate(eq, 50, 20, 5);
  const b = mc.simulate(eq, 50, 20, 5);
  assert.deepStrictEqual(a.quantiles, b.quantiles);
});

t("均线金叉策略生成非零信号", () => {
  const m = market.generateMarket({ seed: 9, days: 400 });
  const sig = bt.buildSignal(m.rows, { type: "ma_cross", fast: 10, slow: 30 });
  assert(sig.some(v => v === 1));
  assert(sig.some(v => v === 0));
});

t("回测总体运行无异常", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 600);
  assert(Number.isFinite(r.final_equity));
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe));
});

t("旧参数（固定止损止盈）结果逐位复现", () => {
  const m = market.generateMarket({ seed: 21, days: 600 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopLoss: 0.05, takeProfit: 0.2,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.trades.length, 9);
  assert.strictEqual(r.final_equity, 117293.21490464684);
  assert.strictEqual(r.equity[300], 118780.39399849842);
  // 固定模式同样输出统一字段，历史解释一致
  const t0 = r.trades[0];
  assert.strictEqual(t0.stop_mode, "fixed");
  assert.strictEqual(t0.atr_ref, null);
  assert.strictEqual(t0.reason, "止损");
  assert(Math.abs(t0.stop_price - t0.entry_price * 0.95) < 1e-9);
});

t("ATR 模式按入场前 ATR 计算触发价", () => {
  // TR 恒为 2，ATR=2；i=19 以 open=119 入场，refIdx=18
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: "d" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  rows.push({ date: "d20", open: 119, high: 120, low: 114, close: 115, volume: 1 });
  const signal = new Array(20).fill(0).concat([1]);
  signal[18] = 1;
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "atr", atrStopMult: 2, atrTargetMult: 4, strategy: {} }, signal);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].stop_mode, "atr");
  assert.strictEqual(r.trades[0].atr_ref, 2);
  assert.strictEqual(r.trades[0].stop_price, 115);
  assert.strictEqual(r.trades[0].exit_price, 115);
});

t("ATR 模式跳空越过止损按开盘价成交", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: "d" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  rows.push({ date: "d20", open: 110, high: 111, low: 109, close: 110, volume: 1 }); // 开盘 110 < 止损 115
  const signal = new Array(20).fill(0).concat([1]);
  signal[18] = 1;
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "atr", atrStopMult: 2, strategy: {} }, signal);
  assert.strictEqual(r.trades[0].reason, "止损");
  assert.strictEqual(r.trades[0].exit_price, 110);
});

t("高波动状态放宽止损止盈距离", () => {
  const atrArr = Array.from({ length: 40 }, () => 1).concat(Array.from({ length: 10 }, () => 1.5));
  const volArr = bt.volStateSeries(atrArr, 50, 0.7, 1.3);
  assert.strictEqual(volArr[49].state, "高波动");
  const s = bt.resolveStops({
    mode: "atr", entryPrice: 100, refIdx: 49, atrArr, volArr,
    stopLoss: 0, takeProfit: 0, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5,
  });
  assert.strictEqual(s.volMult, 1.5);
  assert.strictEqual(s.stopPrice, 95.5);   // 100 - 1.5*2*1.5
  assert.strictEqual(s.targetPrice, 109);    // 100 + 1.5*4*1.5
});

t("ATR 预热期数据不足时回退固定比例", () => {
  const atrArr = new Array(50).fill(null);
  const volArr = bt.volStateSeries(atrArr, 50, 0.7, 1.3);
  const s = bt.resolveStops({
    mode: "atr", entryPrice: 100, refIdx: 5, atrArr, volArr,
    stopLoss: 0.05, takeProfit: 0.2, atrStopMult: 2, atrTargetMult: 4, lowMult: 0.8, highMult: 1.5,
  });
  assert.strictEqual(s.atrRef, null);
  assert.strictEqual(s.stopPrice, 95);
  assert.strictEqual(s.targetPrice, 120);
});

t("ATR 模式不使用未来数据（截断行情结果一致）", () => {
  const m = market.generateMarket({ seed: 5, days: 500 });
  const opts = { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "atr", strategy: { type: "ma_cross", fast: 10, slow: 30 } };
  const full = bt.backtest(m, opts);
  const cut = { rows: m.rows.slice(0, 200) };
  const r2 = bt.backtest(cut, opts);
  for (let i = 0; i < 200; i++) assert.strictEqual(r2.equity[i], full.equity[i]);
  // 所有 ATR 交易引用的 ATR 都来自入场之前
  for (const tr of full.trades) {
    if (tr.stop_mode !== "atr" || tr.atr_ref == null) continue;
    assert(tr.entry_idx >= 1);
  }
});

t("ATR 模式全链路回测与风险指标正常", () => {
  const m = market.generateMarket({ seed: 11, days: 800, vol: 0.018 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "atr",
    atrN: 14, atrStopMult: 2, atrTargetMult: 4, atrVolN: 50,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 800);
  assert(Number.isFinite(r.final_equity));
  for (const tr of r.trades) {
    assert(["止损", "止盈", "信号平仓"].includes(tr.reason));
    assert(["低波动", "正常", "高波动"].includes(tr.vol_state));
    assert(tr.stop_price >= 0 && tr.target_price >= 0);
  }
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe) && Number.isFinite(s.max_drawdown));
});

t("trail 模式初始价与 atr 入场锁定一致", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ date: "d" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  rows.push({ date: "d20", open: 119, high: 123, low: 110, close: 115, volume: 1 });
  const signal = new Array(20).fill(0).concat([1]);
  signal[18] = 1;
  const opts = { cash: 100000, feeRate: 0, slippageBp: 0, atrStopMult: 2, atrTargetMult: 4, strategy: {} };
  const ra = bt.backtest({ rows }, { ...opts, stopMode: "atr" }, signal);
  const rt = bt.backtest({ rows }, { ...opts, stopMode: "trail" }, signal);
  const ta = ra.trades[0], tt = rt.trades[0];
  assert.strictEqual(tt.stop_mode, "trail");
  assert.strictEqual(tt.init_stop_price, ta.stop_price);
  assert.strictEqual(tt.init_target_price, ta.target_price);
  // 轨迹首点 = 入场当日初始触发价
  assert.strictEqual(tt.stop_trail[0][0], tt.entry_idx);
  assert.strictEqual(tt.stop_trail[0][1], ta.stop_price);
  assert.strictEqual(tt.target_trail[0][1], ta.target_price);
});

t("trail 止损吊灯式上移且只上移", () => {
  // 前 20 根 TR 恒为 2（ATR=2），bar20 以 open=120 入场，随后波动放大
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ date: "e" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 });
  rows.push({ date: "e20", open: 120, high: 122, low: 118.5, close: 121, volume: 1 });
  rows.push({ date: "e21", open: 121, high: 123, low: 119.5, close: 122, volume: 1 });
  rows.push({ date: "e22", open: 122, high: 124, low: 120.5, close: 123, volume: 1 });
  rows.push({ date: "e23", open: 123, high: 123.5, low: 118.8, close: 120, volume: 1 });
  const signal = new Array(24).fill(1);
  for (let i = 0; i < 19; i++) signal[i] = 0;
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "trail", atrStopMult: 2, atrTargetMult: 4, strategy: {} }, signal);
  const t0 = r.trades[0];
  assert.strictEqual(t0.reason, "止损");
  assert.strictEqual(t0.init_stop_price, 116);   // 120 - 2*2
  assert(t0.stop_price > t0.init_stop_price);     // 随高点上移
  assert(t0.stop_adj >= 1);
  assert.strictEqual(t0.exit_price, t0.stop_price);
  // 退出当日的数据线等于实际生效触发价
  assert.strictEqual(r.stop_line[t0.exit_idx], t0.stop_price);
  assert.strictEqual(r.target_line[t0.exit_idx], t0.target_price);
  // 轨迹止损价单调不减
  for (let k = 1; k < t0.stop_trail.length; k++) {
    assert(t0.stop_trail[k][1] >= t0.stop_trail[k - 1][1] - 1e-9);
    assert(t0.stop_trail[k][0] > t0.stop_trail[k - 1][0]);
  }
});

t("trail 止盈随波动收缩逐日收紧", () => {
  // TR=4 的行情入场（初始止盈 136），随后十字星令 ATR 衰减，止盈逐日下调直至触发
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ date: "c" + i, open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i, volume: 1 });
  rows.push({ date: "c20", open: 120, high: 122, low: 118, close: 120, volume: 1 });
  for (let i = 21; i <= 26; i++) rows.push({ date: "c" + i, open: 120, high: 120.25, low: 119.75, close: 120, volume: 1 });
  rows.push({ date: "c27", open: 124, high: 133, low: 120, close: 132, volume: 1 });
  const signal = new Array(28).fill(1);
  for (let i = 0; i < 19; i++) signal[i] = 0;
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "trail", atrStopMult: 2, atrTargetMult: 3, strategy: {} }, signal);
  const t0 = r.trades[0];
  assert.strictEqual(t0.reason, "止盈");
  assert.strictEqual(t0.init_target_price, 132);
  assert(t0.target_price < t0.init_target_price);
  assert(t0.target_adj >= 1);
  assert.strictEqual(t0.exit_price, t0.target_price); // 无跳空按触发价
});

t("trail 交易记录含完整追踪字段，fixed 无轨迹", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ date: "x" + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 });
  rows.push({ date: "x20", open: 120, high: 124, low: 116.5, close: 121, volume: 1 });
  rows.push({ date: "x21", open: 121, high: 122, low: 110, close: 115, volume: 1 });
  const sigTrail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];
  const sigFixed = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
  const rt = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "trail", strategy: {} }, sigTrail);
  const tt = rt.trades[0];
  assert(Array.isArray(tt.stop_trail) && tt.stop_trail.length >= 1);
  assert(Array.isArray(tt.target_trail) && tt.target_trail.length >= 1);
  assert(tt.init_stop_price > 0 && tt.init_target_price > 0);
  assert(["低波动", "正常", "高波动"].includes(tt.init_vol_state));
  assert(tt.init_vol_mult > 0);
  const rf = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopLoss: 0.1, takeProfit: 0.2, strategy: {} }, sigFixed);
  const f = rf.trades[0];
  assert.strictEqual(f.stop_trail, null);
  assert.strictEqual(f.target_trail, null);
  assert.strictEqual(f.stop_adj, 0);
  assert.strictEqual(f.target_adj, 0);
  assert.strictEqual(f.init_stop_price, f.stop_price);
  assert.strictEqual(f.init_target_price, f.target_price);
});

t("trail 模式不使用未来数据（截断行情结果一致）", () => {
  const m = market.generateMarket({ seed: 8, days: 500 });
  const opts = { cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "trail", strategy: { type: "ma_cross", fast: 10, slow: 30 } };
  const full = bt.backtest(m, opts);
  const cut = bt.backtest({ rows: m.rows.slice(0, 200) }, opts);
  for (let i = 0; i < 200; i++) {
    assert.strictEqual(cut.equity[i], full.equity[i]);
    assert.strictEqual(cut.stop_line[i], full.stop_line[i]);
    assert.strictEqual(cut.target_line[i], full.target_line[i]);
  }
});

t("trail 预热期 ATR 不足时回退固定比例并保持", () => {
  const rows = [
    { date: "p1", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "p2", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "p3", open: 100, high: 102, low: 98, close: 100, volume: 1 },
    { date: "p4", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: "p5", open: 100, high: 101, low: 99, close: 100, volume: 1 },
  ];
  const signal = [0, 0, 1, 0, 0];
  const r = bt.backtest({ rows }, { cash: 100000, feeRate: 0, slippageBp: 0, stopMode: "trail", atrN: 14, stopLoss: 0.05, takeProfit: 0.2, strategy: {} }, signal);
  const t0 = r.trades[0];
  assert.strictEqual(t0.atr_ref, null);
  assert.strictEqual(t0.init_stop_price, 95);
  assert.strictEqual(t0.init_target_price, 120);
  assert.strictEqual(t0.stop_price, 95);
  assert.strictEqual(t0.target_price, 120);
});

t("trail 全链路：权益/风险指标/蒙特卡洛同步正常", () => {
  const m = market.generateMarket({ seed: 13, days: 800, vol: 0.02 });
  const r = bt.backtest(m, {
    cash: 100000, feeRate: 0.0005, slippageBp: 5, stopMode: "trail",
    atrN: 14, atrStopMult: 2, atrTargetMult: 4, atrVolN: 50, trailHighN: 0,
    strategy: { type: "boll", bbN: 20, bbK: 2 },
  });
  assert.strictEqual(r.equity.length, 800);
  assert.strictEqual(r.stop_line.length, 800);
  assert.strictEqual(r.target_line.length, 800);
  assert(Number.isFinite(r.final_equity));
  for (const tr of r.trades) {
    assert(["止损", "止盈", "信号平仓"].includes(tr.reason));
    assert(tr.stop_trail.length >= 1 && tr.target_trail.length >= 1);
    assert(tr.stop_price >= tr.init_stop_price - 1e-9);
  }
  const s = metrics.summarize(r.equity, {});
  assert(Number.isFinite(s.sharpe) && Number.isFinite(s.max_drawdown));
  const sim = mc.simulate(r.equity, 200, 100, 13);
  assert(sim.quantiles && sim.quantiles.p50.length === 101);
  assert(sim.prob_loss >= 0 && sim.prob_loss <= 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
