const $ = (id) => document.getElementById(id);

const inputs = {
  baseSymbol: $("baseSymbol"),
  quoteSymbol: $("quoteSymbol"),
  quoteUsd: $("quoteUsd"),
  initialPrice: $("initialPrice"),
  binStep: $("binStep"),
  feeBps: $("feeBps"),
  baseAsk: $("baseAsk"),
  quoteBid: $("quoteBid"),
  minPrice: $("minPrice"),
  maxPrice: $("maxPrice"),
  scenarioAmount: $("scenarioAmount"),
};

const chart = $("chart");
const ctx = chart.getContext("2d");
const tooltip = $("tooltip");

let selectedMode = "bidAsk";
let scenarioUnit = "usd";
let points = [];
let hoverPoint = null;
let liquidityConfigs = [
  {
    id: crypto.randomUUID(),
    mode: "bidAsk",
    baseAmount: 84729.243275756,
    quoteAmount: 120,
    minPrice: 0.000443653455,
    maxPrice: 7.5377,
  },
];

function num(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function text(input, fallback) {
  return input.value.trim() || fallback;
}

function globalParams() {
  const baseSymbol = text(inputs.baseSymbol, "BASE").toUpperCase();
  const quoteSymbol = text(inputs.quoteSymbol, "QUOTE").toUpperCase();
  const initialPrice = Math.max(num(inputs.initialPrice, 0.0012), 1e-12);
  const binStep = Math.max(num(inputs.binStep, 100), 0.0001);
  const ratio = 1 + binStep / 10000;
  return {
    baseSymbol,
    quoteSymbol,
    quoteUsd: Math.max(num(inputs.quoteUsd, 84), 0.0001),
    initialPrice,
    binStep,
    ratio,
    feeBps: Math.max(num(inputs.feeBps, 1), 0),
    scenarioAmount: num(inputs.scenarioAmount, 50000),
  };
}

function offsetUp(p, price) {
  return Math.ceil(Math.log(price / p.initialPrice) / Math.log(p.ratio));
}

function offsetDown(p, price) {
  return -Math.ceil(Math.log(p.initialPrice / price) / Math.log(p.ratio));
}

function rangeForPrices(p, minPrice, maxPrice) {
  const min = Math.max(minPrice, 1e-12);
  const max = Math.max(maxPrice, 1e-12);
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const minOffset = low < p.initialPrice ? offsetDown(p, low) : offsetUp(p, low);
  const maxOffset = high < p.initialPrice ? offsetDown(p, high) : offsetUp(p, high);
  const bidStart = Math.min(minOffset, -1);
  const bidEnd = Math.min(maxOffset, -1);
  const askStart = Math.max(minOffset, 1);
  const askEnd = Math.max(maxOffset, 1);
  const bidBins = bidStart <= bidEnd && minOffset < 0 ? bidEnd - bidStart + 1 : 0;
  const askBins = askStart <= askEnd && maxOffset > 0 ? askEnd - askStart + 1 : 0;

  return {
    minOffset,
    maxOffset,
    bidStart,
    bidEnd,
    askStart,
    askEnd,
    bidBins,
    askBins,
    totalBins: Math.max(0, maxOffset - minOffset + 1),
  };
}

function binsForRange(p, minPrice, maxPrice) {
  const range = rangeForPrices(p, minPrice, maxPrice);
  return {
    bidBins: range.bidBins,
    askBins: range.askBins,
    totalBins: range.totalBins,
  };
}

function weight(mode, offset, range) {
  if (mode === "spot") return 1;
  if (mode === "curve") {
    if (offset < 0) {
      return offset - range.bidStart + 1;
    }
    if (offset > 0) {
      return range.askEnd - offset + 1;
    }
    return 1;
  }
  if (offset < 0) return Math.abs(offset);
  if (offset > 0) return offset;
  return 1;
}

function weightSum(mode, offsets, range) {
  let total = 0;
  for (const offset of offsets) {
    total += weight(mode, offset, range);
  }
  return total;
}

function priceAt(p, offset) {
  return p.initialPrice * p.ratio ** offset;
}

function emptyPoint(p, offset) {
  return {
    offset,
    price: priceAt(p, offset),
    side: offset > 0 ? "Buy Up" : offset < 0 ? "Sell Down" : "Open",
    binFlow: 0,
    tokenAmount: 0,
    tokenSymbol: offset >= 0 ? p.baseSymbol : p.quoteSymbol,
    quoteValue: 0,
    feeAmount: 0,
    quoteValueWithFee: 0,
    cumulativeFlow: 0,
    multiple: priceAt(p, offset) / p.initialPrice,
  };
}

function addToPoint(map, p, offset, patch) {
  if (!map.has(offset)) map.set(offset, emptyPoint(p, offset));
  const point = map.get(offset);
  point.binFlow += patch.binFlow ?? 0;
  point.tokenAmount += patch.tokenAmount ?? 0;
  point.quoteValue += patch.quoteValue ?? 0;
  point.feeAmount += patch.feeAmount ?? 0;
  point.quoteValueWithFee += patch.quoteValueWithFee ?? 0;
}

function buildLayerPoints(p, config, map) {
  const range = rangeForPrices(p, config.minPrice, config.maxPrice);
  const bidOffsets = [];
  const askOffsets = [];

  if (range.bidBins > 0) {
    for (let offset = range.bidStart; offset <= range.bidEnd; offset += 1) {
      bidOffsets.push(offset);
    }
  }
  if (range.askBins > 0) {
    for (let offset = range.askStart; offset <= range.askEnd; offset += 1) {
      askOffsets.push(offset);
    }
  }

  const bidDenom = weightSum(config.mode, bidOffsets, range);

  for (const offset of bidOffsets) {
    const quoteInBin = bidDenom > 0 ? config.quoteAmount * weight(config.mode, offset, range) / bidDenom : 0;
    addToPoint(map, p, offset, {
      binFlow: -quoteInBin,
      tokenAmount: quoteInBin,
      quoteValue: quoteInBin,
      quoteValueWithFee: quoteInBin,
    });
  }

  let askDenom = 0;
  for (const offset of askOffsets) {
    askDenom += weight(config.mode, offset, range) / priceAt(p, offset);
  }
  for (const offset of askOffsets) {
    const price = priceAt(p, offset);
    const baseInBin = askDenom > 0 ? config.baseAmount * (weight(config.mode, offset, range) / price) / askDenom : 0;
    const quoteValue = baseInBin * price;
    const fee = quoteValue * p.feeBps / 10000;
    addToPoint(map, p, offset, {
      binFlow: quoteValue,
      tokenAmount: baseInBin,
      quoteValue,
      feeAmount: fee,
      quoteValueWithFee: quoteValue + fee,
    });
  }
}

function buildPoints(p) {
  const ranges = liquidityConfigs.map((config) => rangeForPrices(p, config.minPrice, config.maxPrice));
  const minOffset = Math.min(0, ...ranges.map((r) => r.minOffset));
  const maxOffset = Math.max(0, ...ranges.map((r) => r.maxOffset));
  const map = new Map();

  for (let offset = minOffset; offset <= maxOffset; offset += 1) {
    map.set(offset, emptyPoint(p, offset));
  }
  liquidityConfigs.forEach((config) => buildLayerPoints(p, config, map));

  const out = [...map.values()].sort((a, b) => a.offset - b.offset);
  let runningSell = 0;
  for (let offset = -1; offset >= minOffset; offset -= 1) {
    const point = map.get(offset);
    if (point) {
      runningSell += point.binFlow;
      point.cumulativeFlow = runningSell;
    }
  }
  let runningBuy = 0;
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    const point = map.get(offset);
    if (point) {
      runningBuy += point.quoteValue;
      point.cumulativeFlow = runningBuy;
    }
  }
  return out;
}

function fmtPrice(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (value >= 0.01) return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 10 });
}

function fmtQuote(value, p) {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 4 : 6;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ${p.quoteSymbol}`;
}

function fmtToken(value, symbol) {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 4 : 6;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ${symbol}`;
}

function fmtUsd(value, p) {
  return `$${(value * p.quoteUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtPriceUsd(price, p) {
  return `${fmtUsd(price, p)} / ${p.baseSymbol}`;
}

function findScenarioPoint(p) {
  const targetQuote = scenarioUnit === "usd" ? p.scenarioAmount / p.quoteUsd : p.scenarioAmount;
  if (targetQuote === 0) return points.find((point) => point.offset === 0);
  if (targetQuote > 0) {
    return points.find((point) => point.offset > 0 && point.cumulativeFlow >= targetQuote) ?? points.at(-1);
  }
  return [...points].reverse().find((point) => point.offset < 0 && point.cumulativeFlow <= targetQuote) ?? points[0];
}

function updateScenario(p) {
  const targetQuote = scenarioUnit === "usd" ? p.scenarioAmount / p.quoteUsd : p.scenarioAmount;
  const point = findScenarioPoint(p) ?? points.find((item) => item.offset === 0);
  $("scenarioPrice").textContent = `${fmtPrice(point.price)} ${p.quoteSymbol}`;
  $("scenarioPriceUsd").textContent = fmtPriceUsd(point.price, p);
  $("scenarioBin").textContent = String(point.offset);
  $("scenarioFlow").textContent = `${fmtQuote(point.cumulativeFlow, p)} / ${fmtUsd(point.cumulativeFlow, p)}`;
  $("scenarioMultiple").textContent = `${point.multiple.toLocaleString(undefined, { maximumFractionDigits: 2 })}x`;
  $("derivedBidBins").textContent = String(Math.max(0, -points[0].offset));
  $("derivedAskBins").textContent = String(Math.max(0, points.at(-1).offset));
  $("pricePairHint").textContent = `${p.quoteSymbol} / ${p.baseSymbol}`;
  $("quoteUnitLabel").textContent = p.quoteSymbol;
  if (targetQuote !== 0) hoverPoint = point;
}

function resizeCanvas() {
  const rect = chart.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  chart.width = Math.max(640, Math.round(rect.width * dpr));
  chart.height = Math.max(360, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function scales(padding, width, height) {
  const indexes = points.map((_, index) => index);
  const binFlows = points.map((p) => p.binFlow);
  const flows = points.map((p) => p.cumulativeFlow);
  const xMin = Math.min(...indexes);
  const xMax = Math.max(...indexes);
  const binMaxPos = Math.max(...binFlows, 1);
  const binMaxNeg = Math.max(...binFlows.filter((v) => v < 0).map((v) => Math.abs(v)), 1);
  const flowMaxPos = Math.max(...flows, 1);
  const flowMaxNeg = Math.max(...flows.filter((v) => v < 0).map((v) => Math.abs(v)), 1);
  const zeroY = padding.top + (height - padding.top - padding.bottom) * 0.5;
  const splitY = (v, posMax, negMax) => {
    if (v >= 0) return zeroY - (v / posMax) * (zeroY - padding.top);
    return zeroY + (Math.abs(v) / negMax) * (height - padding.bottom - zeroY);
  };

  return {
    x: (v) => padding.left + ((v - xMin) / Math.max(1, xMax - xMin)) * (width - padding.left - padding.right),
    binY: (v) => splitY(v, binMaxPos, binMaxNeg),
    flowY: (v) => splitY(v, flowMaxPos, flowMaxNeg),
    xMin,
    xMax,
    zeroY,
  };
}

function drawLine(mapY, color, lineWidth = 2, alpha = 1) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = chartState.scale.x(index);
    const y = mapY(point);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBars() {
  const s = chartState.scale;
  const zeroY = s.binY(0);
  const plotWidth = chartState.width - chartState.padding.left - chartState.padding.right;
  const barWidth = Math.max(1, Math.min(8, plotWidth / points.length * 0.82));

  points.forEach((point, index) => {
    if (point.offset === 0 || point.binFlow === 0) return;
    const x = s.x(index) - barWidth / 2;
    const y = s.binY(point.binFlow);
    const top = Math.min(y, zeroY);
    const height = Math.max(1, Math.abs(zeroY - y));
    ctx.fillStyle = point.binFlow > 0 ? "rgba(56, 189, 248, 0.86)" : "rgba(251, 113, 133, 0.82)";
    ctx.fillRect(x, top, barWidth, height);
  });
}

let chartState = null;

function draw() {
  resizeCanvas();
  const p = globalParams();
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const padding = { top: 28, right: 72, bottom: 46, left: 72 };
  const s = scales(padding, width, height);
  chartState = { scale: s, padding, width, height };

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#090b10";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = padding.top + (i / 5) * (height - padding.top - padding.bottom);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  const openIndex = points.findIndex((point) => point.offset === 0);
  const zeroX = s.x(openIndex);
  const zeroBinY = s.binY(0);
  ctx.strokeStyle = "rgba(255,255,255,0.26)";
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(zeroX, padding.top);
  ctx.lineTo(zeroX, height - padding.bottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroBinY);
  ctx.lineTo(width - padding.right, zeroBinY);
  ctx.stroke();
  ctx.setLineDash([]);

  drawBars();
  drawLine((point) => s.flowY(point.cumulativeFlow), "#ffffff", 1.8, 0.92);

  ctx.fillStyle = "#9ca3b6";
  ctx.font = "12px Inter, sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i <= 8; i += 1) {
    const index = Math.round(s.xMin + ((s.xMax - s.xMin) * i) / 8);
    const point = points[Math.max(0, Math.min(points.length - 1, index))];
    ctx.fillText(fmtPrice(point.price), s.x(index), height - 18);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#38bdf8";
  ctx.fillText(`买入单 bin ${p.quoteSymbol} flow`, padding.left, 18);
  ctx.fillStyle = "#fb7185";
  ctx.fillText(`卖出单 bin ${p.quoteSymbol} flow`, padding.left, height - padding.bottom - 8);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "right";
  ctx.fillText(`累计 ${p.quoteSymbol} flow，上下独立缩放`, width - padding.right, 18);

  const selected = hoverPoint ?? points.find((point) => point.offset === 0);
  if (selected) drawMarker(selected);
}

function drawMarker(point) {
  const s = chartState.scale;
  const index = points.indexOf(point);
  const x = s.x(index);
  const barY = s.binY(point.binFlow);
  const zeroY = s.binY(0);
  const flowY = s.flowY(point.cumulativeFlow);

  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, chartState.padding.top);
  ctx.lineTo(x, chartState.height - chartState.padding.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = point.binFlow >= 0 ? "#38bdf8" : "#fb7185";
  ctx.beginPath();
  ctx.arc(x, point.binFlow === 0 ? zeroY : barY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, flowY, 5, 0, Math.PI * 2);
  ctx.fill();
}

function updateHoverDisplay(point, p) {
  $("hoverBin").textContent = String(point.offset);
  $("hoverPrice").textContent = `${fmtPrice(point.price)} ${p.quoteSymbol}`;
  $("hoverPriceUsd").textContent = fmtPriceUsd(point.price, p);
  $("hoverFlow").textContent = `${fmtQuote(point.cumulativeFlow, p)} / ${fmtUsd(point.cumulativeFlow, p)}`;
  $("hoverTokenAmount").textContent = fmtToken(point.tokenAmount, point.tokenSymbol);
  $("hoverQuoteValue").textContent = `${fmtQuote(point.quoteValue, p)} / ${fmtUsd(point.quoteValue, p)}`;
  $("hoverSide").textContent = point.side;
}

function nearestPoint(clientX) {
  const rect = chart.getBoundingClientRect();
  const x = clientX - rect.left;
  const s = chartState.scale;
  const index = Math.round(s.xMin + ((x - chartState.padding.left) / (chartState.width - chartState.padding.left - chartState.padding.right)) * (s.xMax - s.xMin));
  return points[Math.max(0, Math.min(points.length - 1, index))];
}

function showTooltip(point, event, p) {
  const rect = chart.getBoundingClientRect();
  tooltip.hidden = false;
  tooltip.style.left = `${event.clientX - rect.left}px`;
  tooltip.style.top = `${event.clientY - rect.top}px`;
  tooltip.innerHTML = `
    <strong>Bin ${point.offset} · ${point.side}</strong>
    <dl>
      <dt>价格</dt><dd>${fmtPrice(point.price)} ${p.quoteSymbol}</dd>
      <dt>价格约合 U</dt><dd>${fmtPriceUsd(point.price, p)}</dd>
      <dt>价格倍数</dt><dd>${point.multiple.toLocaleString(undefined, { maximumFractionDigits: 2 })}x</dd>
      <dt>单 bin 代币量</dt><dd>${fmtToken(point.tokenAmount, point.tokenSymbol)}</dd>
      <dt>Quote 价值</dt><dd>${fmtQuote(point.quoteValue, p)}</dd>
      <dt>Quote 约合 U</dt><dd>${fmtUsd(point.quoteValue, p)}</dd>
      <dt>Fee 估算</dt><dd>${fmtQuote(point.feeAmount, p)}</dd>
      <dt>含 Fee Quote</dt><dd>${fmtQuote(point.quoteValueWithFee, p)}</dd>
      <dt>累计 ${p.quoteSymbol} 流</dt><dd>${fmtQuote(point.cumulativeFlow, p)}</dd>
      <dt>累计约合 U</dt><dd>${fmtUsd(point.cumulativeFlow, p)}</dd>
    </dl>
  `;
}

function renderLiquidityRows(p) {
  const tbody = $("liquidityRows");
  tbody.innerHTML = liquidityConfigs.map((config, index) => {
    const { totalBins } = binsForRange(p, config.minPrice, config.maxPrice);
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${config.mode === "spot" ? "Spot" : config.mode === "curve" ? "Curve" : "Bid Ask"}</td>
        <td>${fmtToken(config.baseAmount, p.baseSymbol)}</td>
        <td>${fmtToken(config.quoteAmount, p.quoteSymbol)}</td>
        <td>${fmtPrice(config.minPrice)}</td>
        <td>${fmtPrice(config.maxPrice)}</td>
        <td>${totalBins}</td>
        <td><button class="remove-row" data-id="${config.id}" type="button">Remove</button></td>
      </tr>
    `;
  }).join("");
  document.querySelectorAll(".remove-row").forEach((button) => {
    button.addEventListener("click", () => {
      liquidityConfigs = liquidityConfigs.filter((config) => config.id !== button.dataset.id);
      recalc();
    });
  });
}

function recalc() {
  const p = globalParams();
  points = buildPoints(p);
  updateScenario(p);
  renderLiquidityRows(p);
  updateHoverDisplay(hoverPoint ?? points.find((point) => point.offset === 0), p);
  draw();
}

Object.values(inputs).forEach((input) => input.addEventListener("input", recalc));

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    selectedMode = button.dataset.mode;
  });
});

document.querySelectorAll(".unit").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".unit").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    scenarioUnit = button.dataset.unit === "quote" ? "quote" : "usd";
    recalc();
  });
});

$("addLiquidity").addEventListener("click", () => {
  const p = globalParams();
  liquidityConfigs.push({
    id: crypto.randomUUID(),
    mode: selectedMode,
    baseAmount: Math.max(num(inputs.baseAsk, 0), 0),
    quoteAmount: Math.max(num(inputs.quoteBid, 0), 0),
    minPrice: Math.max(num(inputs.minPrice, p.initialPrice), 1e-12),
    maxPrice: Math.max(num(inputs.maxPrice, p.initialPrice), 1e-12),
  });
  recalc();
});

chart.addEventListener("mousemove", (event) => {
  const p = globalParams();
  hoverPoint = nearestPoint(event.clientX);
  updateHoverDisplay(hoverPoint, p);
  showTooltip(hoverPoint, event, p);
  draw();
});

chart.addEventListener("mouseleave", () => {
  tooltip.hidden = true;
});

window.addEventListener("resize", draw);

recalc();
