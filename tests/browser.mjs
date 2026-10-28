// Optional integration check: PLAYWRIGHT_MODULE can point to a bundled installation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const types = { "index.html": "text/html", "config.js": "text/javascript",
  "app.js": "text/javascript", "style.css": "text/css" };
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!Object.hasOwn(types, name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": types[name] });
  response.end(await readFile(join(root, name)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
  const page = await browser.newPage({ timezoneId: "Europe/Belgrade" });
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (!request.url().startsWith(base)) external.push(request.url()); });

  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("notice").textContent.includes("выключен"));
  assert.equal(await page.locator("#dashboard").isVisible(), false);
  assert.deepEqual(external, [], "Disabled UI made an external request");

  const settled = () => page.waitForFunction(() => document.getElementById("charts").getAttribute("aria-busy") === "false");
  const windowOf = () => page.locator(".chart svg").first().evaluate((svg) => ({
    start: Number(svg.dataset.start), end: Number(svg.dataset.end),
  }));
  const choosePeriod = async (hours) => {
    await page.locator("#range").click();
    await page.locator(`[data-hours="${hours}"]`).click();
    await settled();
    const range = await windowOf();
    assert.equal(range.end - range.start, hours * 3600);
  };
  const localInput = (ts) => page.evaluate((value) => {
    const d = new Date(value * 1000), pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, ts);
  await page.goto(`${base}/?demo=1`);
  await page.waitForFunction(() => document.querySelectorAll(".chart svg").length === 5);
  assert.match(await page.locator("#status").innerText(), /Демо/);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `Horizontal overflow at ${width}px`);
    await page.locator("#range").click();
    assert.equal(await page.locator("#range-dialog [data-hours]").count(), 7);
    assert.match(await page.locator("#range-timezone").innerText(), /Europe\/Belgrade/);
    assert.equal(await page.locator("#range-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true);
    await page.keyboard.press("Escape");
  }
  for (const hours of [1, 2, 3, 6, 24, 168, 720]) await choosePeriod(hours);
  await choosePeriod(6);
  if (process.env.MONITOR_SCREENSHOT) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    // Paint the entire page in one viewport to avoid tiled capture artifacts after resize.
    await page.setViewportSize({ width: 390,
      height: await page.evaluate(() => document.documentElement.scrollHeight) });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await mkdir(dirname(process.env.MONITOR_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.MONITOR_SCREENSHOT, fullPage: true });
    await page.locator(".toolbar").screenshot({
      path: process.env.MONITOR_SCREENSHOT.replace(/\.png$/, "-controls.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#range").click();
    await page.locator("#range-dialog").screenshot({
      path: process.env.MONITOR_SCREENSHOT.replace(/\.png$/, "-period.png"),
    });
    await page.keyboard.press("Escape");
  }
  await choosePeriod(720);
  assert.equal(await page.locator(".legend button").count(), 13);
  assert.equal(await page.locator("path[d*='NaN']").count(), 0);
  assert.deepEqual(external, [], "Demo made an external request");

  const now = Math.floor(Date.now() / 1000);
  const point = { ts: now, interval_s: 15, cpu_busy_pct: 45, cpu_iowait_pct: 2,
    cpu_steal_pct: 1, mem_total_bytes: 4 * 2 ** 30, mem_available_bytes: 2 * 2 ** 30,
    swap_total_bytes: 0, swap_used_bytes: 0, net_rx_bytes_s: null, net_tx_bytes_s: null,
    disk_total_bytes: 128 * 2 ** 30, disk_available_bytes: 64 * 2 ** 30,
    disk_read_bytes_s: null, disk_write_bytes_s: null, load1: 1, load5: .5, load15: .25 };
  const metricsBase = "https://metrics.example.test/public";
  await page.route("**/config.js", (route) => route.fulfill({ contentType: "text/javascript",
    body: `window.MONITORING_CONFIG = ${JSON.stringify({ enabled: true, dataBaseUrl: metricsBase, title: "Test" })};` }));
  const received = [];
  await page.route(`${metricsBase}/**`, async (route) => {
    const url = route.request().url();
    received.push(url);
    let document;
    if (url.endsWith("latest.json")) document = { schema: 1, sample_interval_s: 15, sample: point };
    else if (url.includes("/days/")) document = { schema: 1, resolution_s: 300,
      samples: [{ ...point, ts: Math.floor(now / 300) * 300, cpu_peak_pct: 90 }] };
    else if (url.includes("/hours/")) document = { schema: 1, resolution_s: 15,
      samples: [point, { ...point, ts: now - 15 }] };
    await route.fulfill({ json: document, headers: { "access-control-allow-origin": "*" } });
  });
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("status").textContent === "Данные поступают");
  assert.equal(await page.locator(".metric-value").nth(2).innerText(), "—");
  assert.equal(await page.locator(".chart svg").count(), 5);
  await choosePeriod(168);
  assert.equal(await page.locator(".legend button").count(), 13);
  assert.ok(received.some((url) => url.includes("/days/")));

  const memory = page.locator(".chart").filter({ hasText: "Память · %" });
  await memory.getByRole("button", { name: "Swap", exact: true }).click();
  assert.equal(await memory.getByRole("button", { name: "Swap", exact: true }).getAttribute("aria-pressed"), "false");
  assert.equal(await memory.locator('path[data-series="Swap"]').getAttribute("display"), "none");
  await choosePeriod(3);
  assert.equal(await memory.locator('path[data-series="Swap"]').getAttribute("display"), "none");
  await memory.getByRole("button", { name: "Swap", exact: true }).click();
  await memory.getByRole("button", { name: "RAM", exact: true }).click();
  assert.equal(await memory.locator('path[data-series="RAM"]').getAttribute("display"), "none");
  assert.equal(await memory.locator('path[data-series="Swap"]').getAttribute("display"), null);

  // An exact local-time interval crossing UTC midnight must request both UTC dates.
  const previousDay = new Date((now - 2 * 86400) * 1000);
  previousDay.setUTCHours(0, 30, 0, 0);
  const customEnd = previousDay.getTime() / 1000, customStart = customEnd - 3600;
  await page.locator("#range").click();
  await page.locator("#range-from").fill(await localInput(customStart));
  await page.locator("#range-to").fill(await localInput(customEnd));
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await settled();
  assert.deepEqual(await windowOf(), { start: customStart, end: customEnd });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    "An exact date range overflowed the mobile toolbar");
  for (const ts of [customStart, customEnd]) {
    const iso = new Date(ts * 1000).toISOString();
    assert.ok(received.some((url) => url.includes(`/hours/${iso.slice(0, 10)}/${iso.slice(11, 13)}.json`)));
  }
  await page.locator("#refresh").click();
  await settled();
  assert.deepEqual(await windowOf(), { start: customStart, end: customEnd }, "Refresh moved a fixed interval");

  await page.locator("#range").click();
  await page.locator("#range-from").fill(await localInput(customEnd));
  await page.locator("#range-to").fill(await localInput(customStart));
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  assert.equal(await page.locator("#range-dialog").evaluate((dialog) => dialog.open), true);
  assert.match(await page.locator("#range-error").innerText(), /позже/);
  await page.locator("#range-from").fill(await localInput(customEnd - 32 * 86400));
  await page.locator("#range-to").fill(await localInput(customEnd));
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  assert.match(await page.locator("#range-error").innerText(), /31 день/);
  await page.locator("#range-cancel").click();
  assert.deepEqual(await windowOf(), { start: customStart, end: customEnd });

  // Reverse dragging zooms all charts, and Back restores the exact previous bounds.
  await page.setViewportSize({ width: 1440, height: 900 });
  const plot = await page.locator(".plot-hit").first().boundingBox();
  await page.mouse.move(plot.x + plot.width * .8, plot.y + plot.height / 2);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * .3, plot.y + plot.height / 2, { steps: 8 });
  assert.equal(await page.locator(".plot-selection:not([display])").count(), 1);
  await page.mouse.up();
  await settled();
  const zoomed = await windowOf();
  assert.ok(Math.abs((zoomed.end - zoomed.start) - 1800) < 3);
  assert.ok(zoomed.start > customStart && zoomed.end < customEnd);
  assert.equal(await page.locator(".chart svg").evaluateAll((charts) =>
    new Set(charts.map((svg) => `${svg.dataset.start}:${svg.dataset.end}`)).size), 1);
  await page.locator("#range-back").click();
  await settled();
  assert.deepEqual(await windowOf(), { start: customStart, end: customEnd });
  await choosePeriod(1);

  point.ts = now - 600;
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "Данные не обновляются");
  await page.route(`${metricsBase}/latest.json`, (route) => route.fulfill({ status: 503 }));
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "Ошибка чтения");
  assert.match(await page.locator("#notice").innerText(), /503/);
  assert.deepEqual(errors, []);
  console.log("PASS: disabled/demo; mobile/desktop picker; 7 presets; exact local/UTC dates; validation; fixed refresh; reverse drag/undo; RAM/swap toggles; stale data; HTTP failure.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
