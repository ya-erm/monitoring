/* Static dashboard: no build, CDN, account, analytics, or write credentials. */
"use strict";

const config = window.MONITORING_CONFIG;
const demo = new URLSearchParams(location.search).get("demo") === "1";
const byId = (id) => document.getElementById(id);
const palette = ["#008f84", "#dd883b", "#7564c4", "#d05976"];
const cache = new Map();
let controller;
let busy = false;
let selecting = false;
let selectedRange = { type: "relative", hours: 6 };
const rangeHistory = [];
const hiddenSeries = new Set();
const chartUnits = { memory: "%", disk: "%" };
let lastRender;
const presets = new Map([[1, "1 час"], [2, "2 часа"], [3, "3 часа"], [6, "6 часов"],
  [24, "Сутки"], [168, "Неделя"], [720, "Месяц"]]);

function rangeWindow(now = Math.floor(Date.now() / 1000)) {
  return selectedRange.type === "relative"
    ? { start: now - selectedRange.hours * 3600, end: now }
    : { start: selectedRange.start, end: selectedRange.end };
}

function localDateTime(ts) {
  const date = new Date(ts * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(value) {
  const ts = new Date(value).getTime() / 1000;
  // Round-trip validation also rejects impossible dates / skipped DST clock times.
  return Number.isFinite(ts) && localDateTime(ts) === value ? Math.floor(ts) : null;
}

function updateRangeLabel() {
  if (selectedRange.type === "relative") byId("range-value").textContent = presets.get(selectedRange.hours);
  else {
    const { start, end } = selectedRange;
    const from = new Date(start * 1000), to = new Date(end * 1000);
    const options = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
    if (from.getFullYear() !== new Date().getFullYear() || from.getFullYear() !== to.getFullYear()) options.year = "numeric";
    const endLabel = from.toDateString() === to.toDateString()
      ? to.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      : to.toLocaleString("ru-RU", options);
    byId("range-value").textContent = `${from.toLocaleString("ru-RU", options)} — ${endLabel}`;
  }
  byId("range-back").hidden = rangeHistory.length === 0;
}

function applyRange(next) {
  if (JSON.stringify(next) !== JSON.stringify(selectedRange)) {
    rangeHistory.push({ ...selectedRange });
    if (rangeHistory.length > 20) rangeHistory.shift();
  }
  selectedRange = next;
  byId("range-feedback").textContent = "";
  updateRangeLabel();
  refresh();
}

function closeRangePicker(restoreFocus = true) {
  byId("range-popover").hidden = true;
  byId("range").setAttribute("aria-expanded", "false");
  if (restoreFocus) byId("range").focus({ preventScroll: true });
}

function positionRangePicker() {
  const panel = byId("range-popover");
  if (panel.hidden) return;
  const trigger = byId("range").getBoundingClientRect();
  if (trigger.bottom <= 0 || trigger.top >= innerHeight) { closeRangePicker(false); return; }
  const margin = 14, gap = 8;
  const width = Math.min(560, innerWidth - margin * 2);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(margin, Math.min(trigger.left, innerWidth - width - margin))}px`;
  const below = innerHeight - trigger.bottom - gap - margin;
  const above = trigger.top - gap - margin;
  const flip = below < Math.min(panel.scrollHeight, 240) && above > below;
  const available = Math.max(0, flip ? above : below);
  panel.style.maxHeight = `${available}px`;
  const height = Math.min(panel.scrollHeight + 2, available);
  panel.style.top = `${flip ? trigger.top - gap - height : trigger.bottom + gap}px`;
}

function openRangePicker() {
  if (!byId("range-popover").hidden) { closeRangePicker(); return; }
  const { start, end } = rangeWindow();
  byId("range-from").value = localDateTime(start);
  byId("range-to").value = localDateTime(end);
  for (const id of ["range-from", "range-to"]) byId(id).max = localDateTime(Math.floor(Date.now() / 1000));
  byId("range-error").textContent = "";
  byId("range-timezone").textContent = `Ваш часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
  for (const button of document.querySelectorAll("[data-hours]")) {
    button.setAttribute("aria-pressed", String(selectedRange.type === "relative"
      && selectedRange.hours === Number(button.dataset.hours)));
  }
  byId("range-popover").hidden = false;
  byId("range").setAttribute("aria-expanded", "true");
  positionRangePicker();
  byId("range-popover").querySelector('[data-hours][aria-pressed="true"]')?.focus({ preventScroll: true });
}

function applyDateFields(event) {
  event.preventDefault();
  const start = parseLocalDateTime(byId("range-from").value);
  const end = parseLocalDateTime(byId("range-to").value);
  let error = "";
  if (start === null || end === null) error = "Укажите корректные дату и время в обоих полях.";
  else if (end <= start) error = "Время «До» должно быть позже времени «От».";
  else if (end - start < 60) error = "Выберите интервал не короче минуты.";
  else if (end - start > 31 * 86400) error = "Максимальная длина интервала — 31 день.";
  else if (end > Math.floor(Date.now() / 1000)) error = "Конец интервала не может быть в будущем.";
  byId("range-error").textContent = error;
  if (error) return;
  closeRangePicker();
  applyRange({ type: "absolute", start, end });
}

function enableChartSelection(svg, left, right, top, bottom, start, end) {
  const hit = svgNode("rect", { x: left, y: top, width: right - left,
    height: bottom - top, class: "plot-hit", "aria-hidden": "true" });
  const selection = svgNode("rect", { y: top, height: bottom - top,
    width: 0, class: "plot-selection", display: "none", "aria-hidden": "true" });
  svg.append(hit, selection);
  let gesture = null;
  const xAt = (event) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return Math.max(left, Math.min(right, point.matrixTransform(svg.getScreenCTM().inverse()).x));
  };
  hit.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    gesture = { id: event.pointerId, x: xAt(event), clientX: event.clientX };
    selecting = true;
    hit.setPointerCapture(event.pointerId);
    if (event.pointerType === "mouse") event.preventDefault();
  });
  hit.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const x = xAt(event);
    selection.setAttribute("x", Math.min(gesture.x, x));
    selection.setAttribute("width", Math.abs(x - gesture.x));
    selection.removeAttribute("display");
  });
  const finish = (event, cancelled = false) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const previous = gesture;
    gesture = null;
    selecting = false;
    selection.setAttribute("display", "none");
    if (hit.hasPointerCapture(event.pointerId)) hit.releasePointerCapture(event.pointerId);
    if (cancelled || Math.abs(event.clientX - previous.clientX) < 8) return;
    const x = xAt(event);
    const from = Math.round(start + (Math.min(previous.x, x) - left) / (right - left) * (end - start));
    const to = Math.round(start + (Math.max(previous.x, x) - left) / (right - left) * (end - start));
    if (to - from < 60) {
      byId("range-feedback").textContent = "Выберите на графике интервал не короче минуты.";
      return;
    }
    applyRange({ type: "absolute", start: from, end: to });
  };
  hit.addEventListener("pointerup", (event) => finish(event));
  hit.addEventListener("pointercancel", (event) => finish(event, true));
  hit.addEventListener("lostpointercapture", () => {
    gesture = null;
    selecting = false;
    selection.setAttribute("display", "none");
  });
}

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
const memoryUsed = (s) => Number.isFinite(s.mem_total_bytes) && Number.isFinite(s.mem_available_bytes)
  ? s.mem_total_bytes - s.mem_available_bytes : null;
const diskUsed = (s) => Number.isFinite(s.disk_total_bytes) && Number.isFinite(s.disk_available_bytes)
  ? s.disk_total_bytes - s.disk_available_bytes : null;
const diskPct = (s) => s.disk_total_bytes > 0 && diskUsed(s) !== null
  ? diskUsed(s) / s.disk_total_bytes * 100 : null;

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

function drawChart(title, series, rows, start, end, resolution, fixedMax, format, options = {}) {
  const card = element("article", "chart");
  const keyPrefix = options.id || title;
  card.dataset.chart = keyPrefix;
  const heading = element("div", "chart-heading");
  heading.append(element("h2", "", title));
  if (options.id) {
    const units = element("select", "chart-unit");
    units.setAttribute("aria-label", `Единицы: ${title}`);
    for (const unit of ["%", "ГиБ"]) {
      const option = element("option", "", unit);
      option.value = unit;
      units.append(option);
    }
    units.value = chartUnits[options.id];
    units.addEventListener("change", () => {
      chartUnits[options.id] = units.value;
      render(...lastRender);
      document.querySelector(`[data-chart="${options.id}"] select`).focus({ preventScroll: true });
    });
    const control = element("span", "unit-control");
    control.append(units);
    heading.append(control);
  }
  card.append(heading);
  const svg = svgNode("svg", { viewBox: "0 0 600 230", role: "img", "aria-label": title,
    "aria-describedby": "chart-range-help", "data-start": start, "data-end": end,
    "data-resolution": resolution });
  svg.setAttribute("aria-label", `${title}. ${rows.length} измерений; пропуски показаны разрывами.`);
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
  const paths = [];
  series.forEach((line, index) => {
    let path = "", previous = null;
    for (const row of rows) {
      const value = line.value(row);
      if (!Number.isFinite(value)) { previous = null; continue; }
      const joined = previous !== null && row.ts - previous.ts <= resolution * 1.8
        && row.segment === previous.segment;
      path += `${joined ? "L" : "M"}${x(row.ts).toFixed(2)},${y(value).toFixed(2)} `;
      previous = row;
    }
    const stroke = svgNode("path", { d: path, fill: "none", stroke: palette[index],
      "stroke-width": line.dashed ? 1.2 : 1.5, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke",
      "data-series": line.label,
      ...(line.dashed ? { "stroke-dasharray": "4 4" } : {}) });
    if (hiddenSeries.has(`${keyPrefix}:${line.label}`)) stroke.setAttribute("display", "none");
    paths.push(stroke);
    svg.append(stroke);
  });
  enableChartSelection(svg, left, right, top, bottom, start, end);
  const cursor = svgNode("line", { y1: top, y2: bottom, class: "plot-cursor", display: "none" });
  svg.append(cursor);
  const tooltip = element("div", "chart-tooltip");
  const tooltipTime = element("div", "tooltip-time");
  const tooltipDetail = element("div", "tooltip-detail", resolution >= 60
    ? `Среднее за ${number(resolution / 60)} мин` : `Шаг измерений ${resolution} с`);
  const tooltipValues = element("div", "tooltip-values");
  tooltip.append(tooltipTime, tooltipDetail, tooltipValues);
  const hideTooltip = () => {
    tooltip.hidden = true;
    cursor.setAttribute("display", "none");
  };
  hideTooltip();
  svg.addEventListener("pointerdown", hideTooltip);
  svg.addEventListener("pointerleave", hideTooltip);
  svg.addEventListener("pointermove", (event) => {
    if (selecting || event.buttons || !rows.length) { hideTooltip(); return; }
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const position = point.matrixTransform(svg.getScreenCTM().inverse());
    if (position.x < left || position.x > right || position.y < top || position.y > bottom) {
      hideTooltip(); return;
    }
    const ts = start + (position.x - left) / (right - left) * (end - start);
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    const nearby = [rows[lo - 1], rows[lo]].filter(Boolean)
      .sort((a, b) => Math.abs(a.ts - ts) - Math.abs(b.ts - ts));
    const covers = (row) => ts >= (row.coverageStart ?? row.ts - resolution * .9)
      && ts <= (row.coverageEnd ?? row.ts + resolution * .9);
    const row = nearby.find(covers) || nearby[0];
    const known = covers(row);
    const at = known ? row.ts : ts;
    cursor.setAttribute("x1", x(at)); cursor.setAttribute("x2", x(at));
    cursor.removeAttribute("display");
    tooltipTime.textContent = new Date(at * 1000).toLocaleString("ru-RU");
    tooltipValues.replaceChildren();
    const visible = series.filter((line) => !hiddenSeries.has(`${keyPrefix}:${line.label}`));
    if (!known) tooltipValues.append(element("div", "", "Нет измерения"));
    else if (!visible.length) tooltipValues.append(element("div", "", "Все линии скрыты"));
    else for (const line of visible) {
      const value = line.value(row);
      const text = Number.isFinite(value) ? `${number(value, 2)} ${options.unit || ""}`.trim() : "—";
      tooltipValues.append(element("div", "", `${line.label}: ${text}`));
    }
    tooltip.hidden = false;
    const margin = 14, gap = 18;
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    // Keep the selected time column clear; use vertical placement on narrow screens.
    const anchor = svg.createSVGPoint();
    anchor.x = x(at); anchor.y = position.y;
    const selected = anchor.matrixTransform(svg.getScreenCTM());
    const anchorLeft = Math.min(selected.x, event.clientX);
    const anchorRight = Math.max(selected.x, event.clientX);
    const roomLeft = anchorLeft - margin - gap;
    const roomRight = innerWidth - margin - anchorRight - gap;
    let tooltipX, tooltipY;
    if (width <= Math.max(roomLeft, roomRight)) {
      const preferLeft = position.x > (left + right) / 2;
      const useLeft = preferLeft ? width <= roomLeft : width > roomRight;
      tooltipX = useLeft ? anchorLeft - gap - width : anchorRight + gap;
      tooltipY = event.clientY - height / 2;
    } else {
      tooltipX = event.clientX - width / 2;
      const roomAbove = event.clientY - margin - gap;
      const roomBelow = innerHeight - margin - event.clientY - gap;
      tooltipY = roomAbove > roomBelow ? event.clientY - gap - height : event.clientY + gap;
    }
    tooltip.style.left = `${Math.max(margin, Math.min(tooltipX, innerWidth - width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(tooltipY, innerHeight - height - margin))}px`;
  });
  const legend = element("div", "legend");
  series.forEach((line, index) => {
    const key = `${keyPrefix}:${line.label}`;
    const item = element("button", "legend-item", line.label);
    item.type = "button";
    item.setAttribute("aria-pressed", String(!hiddenSeries.has(key)));
    item.style.setProperty("--series-color", palette[index]);
    item.addEventListener("click", () => {
      hideTooltip();
      if (hiddenSeries.has(key)) hiddenSeries.delete(key);
      else hiddenSeries.add(key);
      const visible = !hiddenSeries.has(key);
      item.setAttribute("aria-pressed", String(visible));
      if (visible) paths[index].removeAttribute("display");
      else paths[index].setAttribute("display", "none");
    });
    legend.append(item);
  });
  card.append(svg, legend, tooltip);
  byId("charts").append(card);
}

function aggregateForChart(rows, sourceResolution, resolution) {
  const groups = [];
  let previous = null, segment = 0;
  for (const row of rows) {
    if (previous && row.ts - previous.ts > sourceResolution * 1.8) segment++;
    const bucket = Math.floor(row.ts / resolution);
    let group = groups.at(-1);
    if (!group || group.bucket !== bucket || group.segment !== segment) {
      group = { bucket, segment, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
    previous = row;
  }
  return groups.map(({ segment, rows: samples }) => {
    const average = (key) => {
      const known = samples.filter((s) => Number.isFinite(s[key]));
      const weight = (s) => Math.min(sourceResolution, s.interval_s || sourceResolution);
      const total = known.reduce((sum, s) => sum + weight(s), 0);
      return total ? known.reduce((sum, s) => sum + s[key] * weight(s), 0) / total : null;
    };
    const result = Object.fromEntries(Object.keys(samples[0]).map((key) => [key, average(key)]));
    const cpus = samples.map((s) => s.cpu_busy_pct).filter(Number.isFinite);
    return { ...result, segment, cpu_peak_pct: cpus.length ? Math.max(...cpus) : null,
      coverageStart: samples[0].ts - sourceResolution * .9,
      coverageEnd: samples.at(-1).ts + sourceResolution * .9 };
  });
}

function render(rows, start, end, resolution) {
  lastRender = [rows, start, end, resolution];
  const displayResolution = resolution < 300 && end - start > 3 * 3600
    ? Math.max(resolution, Math.ceil((end - start) / 360 / 60) * 60) : resolution;
  if (displayResolution > resolution) rows = aggregateForChart(rows, resolution, displayResolution);
  resolution = displayResolution;
  byId("chart-detail").textContent = resolution >= 60
    ? `Средние за ${number(resolution / 60)} мин; пики CPU показаны отдельно. При приближении детализация увеличивается.`
    : `Исходные измерения с шагом ${resolution} с.`;
  byId("charts").replaceChildren();
  const field = (label, key, scale = 1) => ({ label,
    value: (s) => Number.isFinite(s[key]) ? s[key] / scale : null });
  const cpu = [field("Вычисления", "cpu_busy_pct"), field("I/O wait", "cpu_iowait_pct"),
    field("Steal", "cpu_steal_pct")];
  if (resolution >= 60) cpu.push({ ...field("Пик вычислений", "cpu_peak_pct"), dashed: true });
  const chart = (title, series, max = null, options = {}) =>
    drawChart(title, series, rows, start, end, resolution, max, (v) => number(v), options);
  chart("CPU · %", cpu, 100, { unit: "%" });
  const inGiB = (value) => Number.isFinite(value) ? value / 2 ** 30 : null;
  const capacity = (keys) => Math.max(1, ...rows.flatMap((s) => keys.map((key) => inGiB(s[key]))).filter(Number.isFinite));
  const memoryPercent = chartUnits.memory === "%", diskPercent = chartUnits.disk === "%";
  chart("Память", memoryPercent
    ? [{ label: "RAM", value: memoryPct }, { label: "Swap", value: swapPct }]
    : [{ label: "RAM", value: (s) => inGiB(memoryUsed(s)) }, field("Swap", "swap_used_bytes", 2 ** 30)],
    memoryPercent ? 100 : capacity(["mem_total_bytes", "swap_total_bytes"]),
    { id: "memory", unit: chartUnits.memory });
  chart("Место на диске", [{ label: "Занято", value: diskPercent ? diskPct : (s) => inGiB(diskUsed(s)) }],
    diskPercent ? 100 : capacity(["disk_total_bytes"]), { id: "disk", unit: chartUnits.disk });
  chart("Сеть · МиБ/с", [field("Входящий", "net_rx_bytes_s", 2 ** 20), field("Исходящий", "net_tx_bytes_s", 2 ** 20)], null, { unit: "МиБ/с" });
  chart("Дисковый I/O · МиБ/с", [field("Чтение", "disk_read_bytes_s", 2 ** 20), field("Запись", "disk_write_bytes_s", 2 ** 20)], null, { unit: "МиБ/с" });
}

function demoData(start, end, resolution) {
  const rows = [];
  for (let ts = Math.ceil(start / resolution) * resolution; ts <= end; ts += resolution) {
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
  byId("charts").setAttribute("aria-busy", "true");
  const now = Math.floor(Date.now() / 1000);
  const { start, end } = rangeWindow(now);
  const resolution = end - start > 86400 ? 300 : (demo ? 15 : null);
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
    const stale = now - latest.ts > (config.staleAfterSeconds || 150);
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
    if (controller === own) {
      busy = false;
      byId("charts").setAttribute("aria-busy", "false");
    }
  }
}

byId("title").textContent = config.title || "Сервер";
const hideChartTooltips = () => {
  for (const tooltip of document.querySelectorAll(".chart-tooltip")) tooltip.hidden = true;
  for (const cursor of document.querySelectorAll(".plot-cursor")) cursor.setAttribute("display", "none");
};
window.addEventListener("scroll", hideChartTooltips, true);
window.addEventListener("resize", hideChartTooltips);
if (demo || config.enabled === true) {
  byId("dashboard").hidden = false;
  updateRangeLabel();
  byId("range").addEventListener("click", openRangePicker);
  byId("range-form").addEventListener("submit", applyDateFields);
  for (const id of ["range-close", "range-cancel"]) {
    byId(id).addEventListener("click", () => closeRangePicker());
  }
  document.addEventListener("pointerdown", (event) => {
    if (!byId("range-popover").hidden && !byId("range-popover").contains(event.target)
        && !byId("range").contains(event.target)) closeRangePicker(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && !byId("range-popover").hidden) {
      event.preventDefault();
      closeRangePicker();
    }
  });
  window.addEventListener("resize", positionRangePicker);
  window.addEventListener("scroll", positionRangePicker, true);
  for (const button of document.querySelectorAll("[data-hours]")) {
    button.addEventListener("click", () => {
      closeRangePicker();
      applyRange({ type: "relative", hours: Number(button.dataset.hours) });
    });
  }
  for (const id of ["range-from", "range-to"]) byId(id).addEventListener("input", () => {
    byId("range-error").textContent = "";
    for (const button of document.querySelectorAll("[data-hours]")) button.setAttribute("aria-pressed", "false");
  });
  byId("range-back").addEventListener("click", () => {
    const previous = rangeHistory.pop();
    if (!previous) return;
    selectedRange = previous;
    byId("range-feedback").textContent = "";
    updateRangeLabel();
    refresh();
  });
  byId("refresh").addEventListener("click", () => { cache.clear(); refresh(); });
  refresh();
  setInterval(() => {
    if (!document.hidden && !busy && !selecting && byId("range-popover").hidden) refresh();
  }, Math.max(30, config.refreshSeconds || 60) * 1000);
} else {
  byId("notice").textContent = "Мониторинг выключен. Запросы к S3 не выполняются. Для локального предпросмотра добавьте ?demo=1 к адресу страницы.";
}
