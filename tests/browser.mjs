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
  const page = await browser.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (!request.url().startsWith(base)) external.push(request.url()); });

  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("notice").textContent.includes("выключен"));
  assert.equal(await page.locator("#dashboard").isVisible(), false);
  assert.deepEqual(external, [], "Disabled UI made an external request");

  await page.goto(`${base}/?demo=1`);
  await page.waitForFunction(() => document.querySelectorAll(".chart svg").length === 6);
  assert.match(await page.locator("#status").innerText(), /Демо/);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `Horizontal overflow at ${width}px`);
  }
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
  }
  await page.locator("#range").selectOption("720");
  await page.waitForFunction(() => document.querySelectorAll(".legend span").length === 13);
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
  assert.equal(await page.locator(".chart svg").count(), 6);
  await page.locator("#range").selectOption("168");
  await page.waitForFunction(() => document.querySelectorAll(".legend span").length === 13);
  assert.ok(received.some((url) => url.includes("/days/")));

  point.ts = now - 600;
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "Данные не обновляются");
  await page.route(`${metricsBase}/latest.json`, (route) => route.fulfill({ status: 503 }));
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "Ошибка чтения");
  assert.match(await page.locator("#notice").innerText(), /503/);
  assert.deepEqual(errors, []);
  console.log("PASS: disabled/no network; demo; 390/1440px; hourly/daily data; nulls; stale data; HTTP failure.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
