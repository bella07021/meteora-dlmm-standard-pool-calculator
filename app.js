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
  scenarioCurrentPrice: $("scenarioCurrentPrice"),
  scenarioAmount: $("scenarioAmount"),
  scenarioTargetPrice: $("scenarioTargetPrice"),
};

const chart = $("chart");
const ctx = chart.getContext("2d");
const tooltip = $("tooltip");
const PROJECTS_API = "/api/projects";

let selectedMode = "bidAsk";
let simulationMode = "amount";
let tradeSide = "buy";
let priceUnit = "usd";
let amountUnit = "usd";
let points = [];
let hoverPoint = null;
let savedProjectsCache = {};
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
    baseFlow: 0,
    feeAmount: 0,
    quoteValueWithFee: 0,
    cumulativeFlow: 0,
    cumulativeBaseFlow: 0,
    multiple: priceAt(p, offset) / p.initialPrice,
  };
}

function addToPoint(map, p, offset, patch) {
  if (!map.has(offset)) map.set(offset, emptyPoint(p, offset));
  const point = map.get(offset);
  point.binFlow += patch.binFlow ?? 0;
  point.tokenAmount += patch.tokenAmount ?? 0;
  point.quoteValue += patch.quoteValue ?? 0;
  point.baseFlow += patch.baseFlow ?? 0;
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
      baseFlow: priceAt(p, offset) > 0 ? quoteInBin / priceAt(p, offset) : 0,
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
      baseFlow: baseInBin,
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
      point.cumulativeBaseFlow = (map.get(offset + 1)?.cumulativeBaseFlow ?? 0) + point.baseFlow;
    }
  }
  let runningBuy = 0;
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    const point = map.get(offset);
    if (point) {
      runningBuy += point.quoteValue;
      point.cumulativeFlow = runningBuy;
      point.cumulativeBaseFlow = (map.get(offset - 1)?.cumulativeBaseFlow ?? 0) + point.baseFlow;
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
  return `$${(price * p.quoteUsd).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })} / ${p.baseSymbol}`;
}

function priceInputToQuote(value, p) {
  return priceUnit === "usd" ? value / p.quoteUsd : value;
}

function nearestPointByPrice(price) {
  const offset = Math.round(Math.log(price / globalParams().initialPrice) / Math.log(globalParams().ratio));
  return pointAtOffset(offset);
}

function pointAtOffset(offset) {
  if (offset <= points[0].offset) return points[0];
  if (offset >= points.at(-1).offset) return points.at(-1);
  return points.find((point) => point.offset >= offset) ?? points.at(-1);
}

function quoteFlowBetween(fromPoint, toPoint) {
  return Math.max(0, toPoint.cumulativeFlow - fromPoint.cumulativeFlow);
}

function baseFlowBetween(fromPoint, toPoint) {
  if (toPoint.offset >= fromPoint.offset) return 0;
  let total = 0;
  for (let offset = fromPoint.offset - 1; offset >= toPoint.offset; offset -= 1) {
    total += pointAtOffset(offset).baseFlow;
  }
  return total;
}

function targetFromQuoteFlow(fromPoint, quoteAmount) {
  for (const point of points) {
    if (point.offset <= fromPoint.offset) continue;
    if (quoteFlowBetween(fromPoint, point) >= quoteAmount) return point;
  }
  return points.at(-1);
}

function targetFromBaseFlow(fromPoint, baseAmount) {
  let total = 0;
  for (let offset = fromPoint.offset - 1; offset >= points[0].offset; offset -= 1) {
    const point = pointAtOffset(offset);
    total += point.baseFlow;
    if (total >= baseAmount) return point;
  }
  return points[0];
}

function targetFromSellQuoteFlow(fromPoint, quoteAmount) {
  for (let offset = fromPoint.offset - 1; offset >= points[0].offset; offset -= 1) {
    const point = pointAtOffset(offset);
    if (Math.abs(point.cumulativeFlow - fromPoint.cumulativeFlow) >= quoteAmount) return point;
  }
  return points[0];
}

function setUploadHint(message, isError = false) {
  const hint = $("uploadHint");
  hint.textContent = message;
  hint.classList.toggle("upload-error", isError);
}

function setProjectHint(message, isError = false) {
  const hint = $("projectHint");
  hint.textContent = message;
  hint.classList.toggle("project-error", isError);
}

async function requestProjects(options = {}) {
  const response = await fetch(PROJECTS_API, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "远端项目库请求失败。");
  }
  return payload.projects || {};
}

function projectParamsSnapshot() {
  return {
    baseSymbol: inputs.baseSymbol.value,
    quoteSymbol: inputs.quoteSymbol.value,
    quoteUsd: inputs.quoteUsd.value,
    initialPrice: inputs.initialPrice.value,
    binStep: inputs.binStep.value,
    feeBps: inputs.feeBps.value,
  };
}

function applyProjectParams(params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (inputs[key]) inputs[key].value = value;
  }
}

function liquiditySnapshot() {
  return liquidityConfigs.map(({ mode, baseAmount, quoteAmount, minPrice, maxPrice }) => ({
    mode,
    baseAmount,
    quoteAmount,
    minPrice,
    maxPrice,
  }));
}

function restoreLiquidity(configs = []) {
  liquidityConfigs = configs.map((config) => ({
    id: crypto.randomUUID(),
    mode: normalizeMode(config.mode) || "bidAsk",
    baseAmount: Math.max(Number(config.baseAmount) || 0, 0),
    quoteAmount: Math.max(Number(config.quoteAmount) || 0, 0),
    minPrice: Math.max(Number(config.minPrice) || 0, 1e-12),
    maxPrice: Math.max(Number(config.maxPrice) || 0, 1e-12),
  }));
}

function renderSavedProjectOptions(selectedName = $("savedProjects").value) {
  const select = $("savedProjects");
  const names = Object.keys(savedProjectsCache).sort((a, b) => a.localeCompare(b));
  select.innerHTML = "";
  if (names.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无保存项目";
    select.append(option);
  } else {
    names.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    });
  }
  if (names.includes(selectedName)) select.value = selectedName;
}

async function refreshSavedProjects(selectedName = $("savedProjects").value) {
  savedProjectsCache = await requestProjects();
  renderSavedProjectOptions(selectedName);
}

async function saveCurrentProject() {
  const name = $("projectName").value.trim();
  if (!name) {
    setProjectHint("请先填写项目名称。", true);
    return;
  }
  try {
    const project = {
      name,
      savedAt: new Date().toISOString(),
      params: projectParamsSnapshot(),
      liquidity: liquiditySnapshot(),
    };
    savedProjectsCache = await requestProjects({
      method: "POST",
      body: JSON.stringify({ name, project }),
    });
    renderSavedProjectOptions(name);
    $("savedProjects").value = name;
    setProjectHint(`已保存到远端项目库：${name}（${liquidityConfigs.length} 行流动性）。`);
  } catch (error) {
    setProjectHint(error.message || "保存到远端项目库失败。", true);
  }
}

function loadSelectedProject() {
  const name = $("savedProjects").value;
  if (!name) {
    setProjectHint("请选择一个已保存项目。", true);
    return;
  }
  const project = savedProjectsCache[name];
  if (!project) {
    renderSavedProjectOptions();
    setProjectHint("没有找到这个项目，列表已刷新。", true);
    return;
  }
  applyProjectParams(project.params);
  restoreLiquidity(project.liquidity);
  $("projectName").value = name;
  recalc();
  setProjectHint(`已加载项目：${name}（${liquidityConfigs.length} 行流动性）。`);
}

function normalizeMode(value) {
  const textValue = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (textValue === "spot") return "spot";
  if (textValue === "curve") return "curve";
  if (textValue === "bidask" || textValue === "bidasks" || textValue === "bid/ask") return "bidAsk";
  return "";
}

function parseSheetNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const cleaned = String(value ?? "").trim().replace(/,/g, "");
  if (!cleaned) return NaN;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function columnIndex(cellRef) {
  const letters = String(cellRef || "").match(/[A-Z]+/i)?.[0] ?? "";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }
  return Math.max(0, index - 1);
}

async function inflateZipEntry(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 66000); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("没有识别到有效的 .xlsx 文件。");

  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  let cursor = centralDirOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Excel 压缩结构读取失败。");
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const fileName = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + fileNameLength));
    entries.set(fileName, { compression, compressedSize, localOffset });
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  const files = new Map();
  for (const [fileName, entry] of entries) {
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) continue;
    const fileNameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + fileNameLength + extraLength;
    const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);
    if (entry.compression === 0) files.set(fileName, compressed);
    if (entry.compression === 8) files.set(fileName, await inflateZipEntry(compressed));
  }
  return files;
}

function parseXml(bytes) {
  const xml = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Excel XML 内容解析失败。");
  return doc;
}

function resolveWorkbookPath(workbookDoc, relsDoc) {
  const firstSheet = workbookDoc.querySelector("sheet");
  const relId = firstSheet?.getAttribute("r:id");
  if (!relId) throw new Error("Excel 第一张表不存在。");
  const rel = [...relsDoc.querySelectorAll("Relationship")].find((item) => item.getAttribute("Id") === relId);
  const target = rel?.getAttribute("Target");
  if (!target) throw new Error("Excel 工作表关系读取失败。");
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`.replace(/\/[^/]+\/\.\.\//g, "/");
}

function readSharedStrings(files) {
  const bytes = files.get("xl/sharedStrings.xml");
  if (!bytes) return [];
  const doc = parseXml(bytes);
  return [...doc.querySelectorAll("si")].map((item) =>
    [...item.querySelectorAll("t")].map((node) => node.textContent ?? "").join("")
  );
}

function cellValue(cell, sharedStrings) {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") return [...cell.querySelectorAll("t")].map((node) => node.textContent ?? "").join("");
  const value = cell.querySelector("v")?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  return value;
}

function rowsFromWorksheet(sheetDoc, sharedStrings) {
  return [...sheetDoc.querySelectorAll("sheetData row")].map((row) => {
    const values = [];
    row.querySelectorAll("c").forEach((cell) => {
      values[columnIndex(cell.getAttribute("r"))] = cellValue(cell, sharedStrings);
    });
    return values.map((value) => value ?? "");
  });
}

function configsFromRows(rows) {
  const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell)));
  if (headerIndex < 0) throw new Error("Excel 没有找到表头。");
  const headerMap = new Map(rows[headerIndex].map((cell, index) => [normalizeHeader(cell), index]));
  const columns = {
    mode: headerMap.get("模式") ?? headerMap.get("mode"),
    base: headerMap.get("base"),
    quote: headerMap.get("quote"),
    min: headerMap.get("min"),
    max: headerMap.get("max"),
  };
  if (Object.values(columns).some((index) => index === undefined)) {
    throw new Error("表头需要包含：模式、base、quote、min、max。");
  }

  const configs = [];
  rows.slice(headerIndex + 1).forEach((row, index) => {
    if (!row.some((cell) => String(cell ?? "").trim())) return;
    const mode = normalizeMode(row[columns.mode]);
    const baseAmount = parseSheetNumber(row[columns.base]);
    const quoteAmount = parseSheetNumber(row[columns.quote]);
    const minPrice = parseSheetNumber(row[columns.min]);
    const maxPrice = parseSheetNumber(row[columns.max]);
    if (!mode || [baseAmount, quoteAmount, minPrice, maxPrice].some((value) => !Number.isFinite(value))) {
      throw new Error(`第 ${headerIndex + index + 2} 行格式不完整，请检查模式/base/quote/min/max。`);
    }
    configs.push({
      id: crypto.randomUUID(),
      mode,
      baseAmount: Math.max(baseAmount, 0),
      quoteAmount: Math.max(quoteAmount, 0),
      minPrice: Math.max(minPrice, 1e-12),
      maxPrice: Math.max(maxPrice, 1e-12),
    });
  });
  return configs;
}

async function readLiquidityXlsx(file) {
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("请上传 .xlsx 格式的 Excel 文件。");
  if (!("DecompressionStream" in window)) throw new Error("当前浏览器不支持直接解析 .xlsx，请换新版 Chrome。");
  const files = await readZipEntries(await file.arrayBuffer());
  const workbookDoc = parseXml(files.get("xl/workbook.xml"));
  const relsDoc = parseXml(files.get("xl/_rels/workbook.xml.rels"));
  const sheetPath = resolveWorkbookPath(workbookDoc, relsDoc);
  const sheetBytes = files.get(sheetPath);
  if (!sheetBytes) throw new Error("没有读取到第一张工作表。");
  return configsFromRows(rowsFromWorksheet(parseXml(sheetBytes), readSharedStrings(files)));
}

function updateSimulatorControls(p) {
  const isAmountMode = simulationMode === "amount";
  const isBuy = tradeSide === "buy";
  document.querySelectorAll(".amount-mode-field").forEach((item) => {
    item.hidden = !isAmountMode;
  });
  document.querySelectorAll(".target-mode-field").forEach((item) => {
    item.hidden = isAmountMode;
  });
  $("scenarioAmountUnitWrap").hidden = !isAmountMode;
  $("scenarioAmountLabel").textContent = isBuy ? "流入资金" : "流出资金";
  $("scenarioAmountHint").textContent = `U 或 ${p.quoteSymbol}`;
  $("scenarioCurrentHint").textContent = priceUnit === "usd" ? `U / ${p.baseSymbol}` : `${p.quoteSymbol} / ${p.baseSymbol}`;
  $("scenarioTargetHint").textContent = priceUnit === "usd" ? `U / ${p.baseSymbol}` : `${p.quoteSymbol} / ${p.baseSymbol}`;
  $("pricePairHint").textContent = `${p.quoteSymbol} / ${p.baseSymbol}`;
  $("priceQuoteUnitLabel").textContent = p.quoteSymbol;
  $("amountQuoteUnitLabel").textContent = p.quoteSymbol;
}

function setResultTone(element, direction) {
  element.classList.remove("result-up", "result-down");
  if (direction > 0) element.classList.add("result-up");
  if (direction < 0) element.classList.add("result-down");
}

function updateScenario(p) {
  updateSimulatorControls(p);
  const currentInputPrice = Math.max(num(inputs.scenarioCurrentPrice, p.initialPrice * p.quoteUsd), 1e-12);
  const currentQuotePrice = priceInputToQuote(currentInputPrice, p);
  const currentPoint = nearestPointByPrice(currentQuotePrice) ?? points.find((item) => item.offset === 0);
  let targetPoint = currentPoint;
  let quoteFlow = 0;
  let baseFlow = 0;

  if (simulationMode === "amount") {
    const rawAmount = Math.max(num(inputs.scenarioAmount, 0), 0);
    if (tradeSide === "buy") {
      quoteFlow = amountUnit === "usd" ? rawAmount / p.quoteUsd : rawAmount;
      targetPoint = targetFromQuoteFlow(currentPoint, quoteFlow);
      baseFlow = Math.max(0, targetPoint.cumulativeBaseFlow - currentPoint.cumulativeBaseFlow);
    } else {
      quoteFlow = amountUnit === "usd" ? rawAmount / p.quoteUsd : rawAmount;
      targetPoint = targetFromSellQuoteFlow(currentPoint, quoteFlow);
      quoteFlow = Math.abs(targetPoint.cumulativeFlow - currentPoint.cumulativeFlow);
      baseFlow = baseFlowBetween(currentPoint, targetPoint);
    }
  } else {
    const targetInputPrice = Math.max(num(inputs.scenarioTargetPrice, currentInputPrice), 1e-12);
    const targetQuotePrice = priceInputToQuote(targetInputPrice, p);
    targetPoint = nearestPointByPrice(targetQuotePrice) ?? currentPoint;
    tradeSide = targetPoint.offset >= currentPoint.offset ? "buy" : "sell";
    document.querySelectorAll(".trade-side").forEach((button) => {
      button.classList.toggle("active", button.dataset.side === tradeSide);
    });
    if (tradeSide === "buy") {
      quoteFlow = quoteFlowBetween(currentPoint, targetPoint);
      baseFlow = Math.max(0, targetPoint.cumulativeBaseFlow - currentPoint.cumulativeBaseFlow);
    } else {
      baseFlow = baseFlowBetween(currentPoint, targetPoint);
      quoteFlow = Math.abs(targetPoint.cumulativeFlow - currentPoint.cumulativeFlow);
    }
  }

  $("scenarioPrice").textContent = `${fmtPrice(targetPoint.price)} ${p.quoteSymbol}`;
  $("scenarioPriceUsd").textContent = fmtPriceUsd(targetPoint.price, p);
  $("scenarioFlowLabel").textContent = `资金变化（${p.quoteSymbol} + U）`;
  $("scenarioFlow").textContent = `${fmtQuote(quoteFlow, p)} / ${fmtUsd(quoteFlow, p)}`;
  $("scenarioTradeLabel").textContent = tradeSide === "buy"
    ? `买入（${p.baseSymbol}）`
    : `卖出（${p.quoteSymbol} + U）`;
  $("scenarioTrade").textContent = tradeSide === "buy"
    ? fmtToken(baseFlow, p.baseSymbol)
    : `${fmtQuote(quoteFlow, p)} / ${fmtUsd(quoteFlow, p)}`;
  setResultTone($("scenarioPrice"), targetPoint.price - currentPoint.price);
  setResultTone($("scenarioPriceUsd"), targetPoint.price - currentPoint.price);
  setResultTone($("scenarioFlow"), tradeSide === "buy" ? quoteFlow : -quoteFlow);
  setResultTone($("scenarioTrade"), tradeSide === "buy" ? baseFlow : -quoteFlow);
  hoverPoint = targetPoint;
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
  $("hoverPrice").textContent = `${fmtPrice(point.price)} ${p.quoteSymbol}`;
  $("hoverPriceUsd").textContent = fmtPriceUsd(point.price, p);
  $("hoverFlow").textContent = `${fmtQuote(point.cumulativeFlow, p)} / ${fmtUsd(point.cumulativeFlow, p)}`;
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
    <dl class="tooltip-block">
      <dt>价格</dt><dd>${fmtPrice(point.price)} ${p.quoteSymbol}</dd>
      <dt>价格约合 U</dt><dd>${fmtPriceUsd(point.price, p)}</dd>
    </dl>
    <dl class="tooltip-block">
      <dt>单 bin 内代币量</dt><dd>${fmtToken(point.tokenAmount, point.tokenSymbol)}</dd>
    </dl>
    <dl class="tooltip-block">
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

document.querySelectorAll(".sim-mode").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".sim-mode").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    simulationMode = button.dataset.simMode === "target" ? "target" : "amount";
    recalc();
  });
});

document.querySelectorAll(".trade-side").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".trade-side").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    tradeSide = button.dataset.side === "sell" ? "sell" : "buy";
    recalc();
  });
});

document.querySelectorAll(".price-unit").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".price-unit").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    priceUnit = button.dataset.priceUnit === "quote" ? "quote" : "usd";
    recalc();
  });
});

document.querySelectorAll(".amount-unit").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".amount-unit").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    amountUnit = button.dataset.amountUnit === "quote" ? "quote" : "usd";
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

$("liquidityUpload").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    setUploadHint("正在读取 Excel...");
    const configs = await readLiquidityXlsx(file);
    if (configs.length === 0) throw new Error("Excel 没有可导入的数据行。");
    liquidityConfigs.push(...configs);
    recalc();
    setUploadHint(`已从 ${file.name} 导入 ${configs.length} 行。表头：模式、base、quote、min、max；Bins 自动计算。`);
  } catch (error) {
    setUploadHint(error.message || "Excel 导入失败，请检查文件格式。", true);
  } finally {
    event.target.value = "";
  }
});

$("saveProject").addEventListener("click", saveCurrentProject);
$("loadProject").addEventListener("click", loadSelectedProject);
$("savedProjects").addEventListener("change", () => {
  const name = $("savedProjects").value;
  if (name) $("projectName").value = name;
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

refreshSavedProjects()
  .then(() => setProjectHint("已连接远端项目库，可保存和加载共享项目。"))
  .catch((error) => {
    renderSavedProjectOptions();
    setProjectHint(error.message || "远端项目库未连接，项目保存暂不可用。", true);
  });
recalc();
