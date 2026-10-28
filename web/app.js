/* Static dashboard: no build, CDN, account, analytics, or write credentials. */
"use strict";

const config = window.MONITORING_CONFIG;
const demo = new URLSearchParams(location.search).get("demo") === "1";
const byId = (id) => document.getElementById(id);
const palette = ["#008f84", "#dd883b", "#7564c4", "#d05976"];
const cache = new Map();
let controller;
let busy = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

const number = (value, digits = 1) => Number.isFinite(value)
  ? value.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : "—";
const percent = (value) => `${number(value)} %`;
const gib = (value) => Number.isFinite(value) ? `${number(value / 2 ** 30)} ГиБ` : "—";
const memoryPct = (s) => s.mem_total_bytes > 0 && Number.isFinite(s.mem_available_bytes)
  ? (1 - s.mem_available_bytes / s.mem_total_bytes) * 100 : null;
const swapPct = (s) => s.swap_total_bytes > 0 && Number.isFinite(s.swap_used_bytes)
  ? s.swap_used_bytes / s.swap_total_bytes * 100 : 0;

function setStatus(text, warning = false) {
  byId("status").textContent = text;
  byId("status").classList.toggle("warning", warning);
}

function summary(sample) {
  const container = byId("summary");
  container.replaceChildren();
  const cards = [
    ["CPU", percent(sample.cpu_busy_pct), `Ожидание диска ${percent(sample.cpu_iowait_pct)}`],
    ["RAM", percent(memoryPct(sample)), `${gib(sample.mem_available_bytes)} доступно`],
    ["Сеть ↓ / ↑", `${number(sample.net_rx_bytes_s / 2 ** 20)} / ${number(sample.net_tx_bytes_s / 2 ** 20)}`,
      "МиБ/с · входящий / исходящий"],
    ["Свободно на диске", gib(sample.disk_available_bytes), `Всего ${gib(sample.disk_total_bytes)}`],
  ];
  // Null rates must remain unknown instead of becoming zero through JS coercion.
  if (sample.net_rx_bytes_s === null || sample.net_tx_bytes_s === null) cards[2][1] = "—";
  for (const [label, value, detail] of cards) {
    const card = element("article", "metric");
    card.append(element("p", "metric-label", label), element("p", "metric-value", value),
      element("p", "metric-detail", detail));
    container.append(card);
  }
}

function drawChart(title, series, rows, start, end, resolution, fixedMax, format) {
  const card = element("article", "chart");
  card.append(element("h2", "", title));
  const svg = svgNode("svg", { viewBox: "0 0 600 230", role: "img", "aria-label": title });
  svg.append(svgNode("title", {}, `${title}. ${rows.length} измерений; пропуски показаны разрывами.`));
  const left = 52, right = 586, top = 12, bottom = 188;
  const values = series.flatMap((s) => rows.map(s.value)).filter(Number.isFinite);
  const max = fixedMax || Math.max(1, ...values) * 1.1;
  const x = (ts) => left + (ts - start) / (end - start) * (right - left);
  const y = (value) => bottom - value / max * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4;
    svg.append(svgNode("line", { x1: left, x2: right, y1: y(value), y2: y(value) }),
      svgNode("text", { x: left - 8, y: y(value) + 4, "text-anchor": "end" }, format(value)));
  }
  const longRange = end - start > 86400;
  for (let i = 0; i <= 3; i++) {
    const ts = start + (end - start) * i / 3;
    const label = new Date(ts * 1000).toLocaleString("ru-RU", longRange
      ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
    svg.append(svgNode("text", { x: x(ts), y: 216, "text-anchor": i === 0 ? "start" : i === 3 ? "end" : "middle" }, label));
  }
  series.forEach((line, index) => {
    let path = "", previous = null;
    for (const row of rows) {
      const value = line.value(row);
      if (!Number.isFinite(value)) { previous = null; continue; }
      const joined = previous !== null && row.ts - previous <= resolution * 1.8;
      path += `${joined ? "L" : "M"}${x(row.ts).toFixed(2)},${y(value).toFixed(2)} `;
      previous = row.ts;
    }
    svg.append(svgNode("path", { d: path, fill: "none", stroke: palette[index],
      "stroke-width": 2, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke",
      ...(line.dashed ? { "stroke-dasharray": "4 4" } : {}) }));
  });
  const legend = element("div", "legend");
  series.forEach((line, index) => {
    const item = element("span", "", line.label);
    item.style.setProperty("--series-color", palette[index]);
    legend.append(item);
  });
  card.append(svg, legend);
  byId("charts").append(card);
}

function render(rows, start, end, resolution) {
  byId("charts").replaceChildren();
  const field = (label, key, scale = 1) => ({ label,
    value: (s) => Number.isFinite(s[key]) ? s[key] / scale : null });
  const cpu = [field("Вычисления", "cpu_busy_pct"), field("I/O wait", "cpu_iowait_pct"),
    field("Steal", "cpu_steal_pct")];
  if (resolution === 300) cpu.push({ ...field("Пик вычислений", "cpu_peak_pct"), dashed: true });
  const chart = (title, series, max = null, format = (v) => number(v)) =>
    drawChart(title, series, rows, start, end, resolution, max, format);
  chart("CPU · %", cpu, 100, (v) => number(v, 0));
  chart("RAM · %", [{ label: "Занято без доступного кэша", value: memoryPct }], 100, (v) => number(v, 0));
  chart("Сеть · МиБ/с", [field("Входящий", "net_rx_bytes_s", 2 ** 20), field("Исходящий", "net_tx_bytes_s", 2 ** 20)]);
  chart("Load average", [field("1 минута", "load1"), field("5 минут", "load5"), field("15 минут", "load15")]);
  chart("Дисковый I/O · МиБ/с", [field("Чтение", "disk_read_bytes_s", 2 ** 20), field("Запись", "disk_write_bytes_s", 2 ** 20)]);
  chart("Swap · %", [{ label: "Занято", value: swapPct }], 100, (v) => number(v, 0));
}

function demoData(start, end, resolution) {
  const rows = [];
  for (let ts = Math.floor(start / resolution) * resolution; ts <= end; ts += resolution) {
    const phase = ts / 1800;
    const cpu = 18 + 12 * Math.sin(phase) + (Math.sin(phase / 4) > .9 ? 58 : 0);
    // Deliberate synthetic interruption makes missing samples visible in preview.
    if ((ts - start) / (end - start) > .62 && (ts - start) / (end - start) < .65) continue;
    rows.push({ ts, interval_s: resolution, cpu_busy_pct: cpu, cpu_iowait_pct: 1.8 + Math.sin(phase),
      cpu_steal_pct: .5, cpu_peak_pct: Math.min(100, cpu + 6),
      mem_total_bytes: 4 * 2 ** 30, mem_available_bytes: (1.5 + .3 * Math.sin(phase / 2)) * 2 ** 30,
      swap_total_bytes: 2 ** 30, swap_used_bytes: .08 * 2 ** 30,
      net_rx_bytes_s: (1 + .8 * Math.sin(phase)) * 2 ** 20,
      net_tx_bytes_s: (.3 + .2 * Math.cos(phase)) * 2 ** 20,
      disk_read_bytes_s: (2 + Math.cos(phase)) * 2 ** 20,
      disk_write_bytes_s: (1 + .8 * Math.sin(phase)) * 2 ** 20,
      disk_total_bytes: 128 * 2 ** 30, disk_available_bytes: 72 * 2 ** 30,
      load1: cpu / 50, load5: cpu / 65, load15: cpu / 70 });
  }
  return rows;
}

function baseUrl() {
  const url = new URL(config.dataBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Укажите публичный HTTPS-адрес данных в config.js.");
  }
  return url.href.replace(/\/$/, "");
}

async function fetchJson(key, signal, optional = false) {
  const cached = cache.get(key);
  const stamp = new Date().toISOString();
  const current = key === `days/${stamp.slice(0, 10)}.json`
    || key === `hours/${stamp.slice(0, 10)}/${stamp.slice(11, 13)}.json`;
  const ttl = current ? 30000 : 15 * 60000;
  if (key !== "latest.json" && cached && Date.now() - cached.at < ttl) return cached.data;
  const response = await fetch(`${baseUrl()}/${key}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    credentials: "omit", referrerPolicy: "no-referrer", cache: "no-cache",
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`Не удалось прочитать данные (HTTP ${response.status}).`);
  const data = await response.json();
  if (data.schema !== 1) throw new Error("Неподдерживаемый формат данных.");
  if (key !== "latest.json") cache.set(key, { at: Date.now(), data });
  return data;
}

async function history(start, end, resolution, signal) {
  const step = resolution === 300 ? 86400 : 3600;
  const keys = [];
  for (let ts = Math.floor(start / step) * step; ts <= end; ts += step) {
    const iso = new Date(ts * 1000).toISOString();
    keys.push(resolution === 300 ? `days/${iso.slice(0, 10)}.json`
      : `hours/${iso.slice(0, 10)}/${iso.slice(11, 13)}.json`);
  }
  let next = 0;
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (next < keys.length) {
      const data = await fetchJson(keys[next++], signal, true);
      if (data) {
        if (!Array.isArray(data.samples) || data.resolution_s !== resolution) {
          throw new Error("Некорректный файл истории.");
        }
        rows.push(...data.samples);
      }
    }
  }));
  const unique = new Map(rows.filter((s) => Number.isInteger(s.ts) && s.ts >= start && s.ts <= end)
    .map((s) => [s.ts, s]));
  return [...unique.values()].sort((a, b) => a.ts - b.ts);
}

async function refresh() {
  controller?.abort();
  controller = new AbortController();
  const own = controller;
  busy = true;
  const end = Math.floor(Date.now() / 1000);
  const hours = Number(byId("range").value);
  const start = end - hours * 3600;
  const resolution = hours > 24 ? 300 : (demo ? 15 : null);
  try {
    let rows, actualResolution, latest;
    if (demo) {
      actualResolution = resolution;
      rows = demoData(start, end, actualResolution);
      latest = rows.at(-1);
    } else {
      const document = await fetchJson("latest.json", own.signal);
      if (!document.sample || !Number.isInteger(document.sample.ts)
          || !Number.isInteger(document.sample_interval_s) || document.sample_interval_s < 5) {
        throw new Error("Нет корректного последнего измерения.");
      }
      latest = document.sample;
      actualResolution = resolution || document.sample_interval_s;
      rows = await history(start, end, actualResolution, own.signal);
    }
    if (own.signal.aborted) return;
    summary(latest);
    render(rows, start, end, actualResolution);
    byId("updated").textContent = `Последнее измерение: ${new Date(latest.ts * 1000).toLocaleString("ru-RU")}`;
    const stale = end - latest.ts > (config.staleAfterSeconds || 150);
    setStatus(demo ? "Демо · вымышленные данные" : stale ? "Данные не обновляются" : "Данные поступают", stale || demo);
    byId("notice").textContent = demo ? "Предпросмотр на вымышленных данных. Сбор и S3 не используются."
      : stale ? "Новых измерений нет. На графиках сохранённая история; причина недоступности сервера неизвестна."
        : rows.length ? "" : "За выбранный период измерений пока нет.";
  } catch (error) {
    if (own.signal.aborted) return;
    setStatus("Ошибка чтения", true);
    byId("notice").textContent = error instanceof TypeError
      ? "Не удалось загрузить данные. Проверьте HTTPS-адрес, доступность S3 и CORS."
      : error.message;
  } finally {
    if (controller === own) busy = false;
  }
}

byId("title").textContent = config.title || "Сервер";
if (demo || config.enabled === true) {
  byId("dashboard").hidden = false;
  byId("range").addEventListener("change", refresh);
  byId("refresh").addEventListener("click", () => { cache.clear(); refresh(); });
  refresh();
  setInterval(() => { if (!document.hidden && !busy) refresh(); }, Math.max(30, config.refreshSeconds || 60) * 1000);
} else {
  byId("notice").textContent = "Мониторинг выключен. Запросы к S3 не выполняются. Для локального предпросмотра добавьте ?demo=1 к адресу страницы.";
}
