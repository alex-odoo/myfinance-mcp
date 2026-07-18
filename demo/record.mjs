/**
 * Records demo/demo.html into a webm video with Playwright.
 * The page embeds the REAL src/ui/dashboard.html (MCP App) and drives it
 * over the same postMessage protocol claude.ai uses.
 *
 * Usage:
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node demo/record.mjs [outDir]
 * Chromium comes from the Playwright browser cache (no download).
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { readdirSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";

const pwMod = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const { chromium } = pwMod.default ?? pwMod;

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const OUT_DIR = resolve(process.argv[2] ?? join(os.homedir(), "Desktop", "MyFinanceMCP"));
mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".woff2": "font/woff2", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
};
const server = http.createServer(async (req, res) => {
  try {
    const path = join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(ROOT)) throw new Error("traversal");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const cacheRoot = join(os.homedir(), "Library/Caches/ms-playwright");
const chromiumDir = readdirSync(cacheRoot).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const executablePath = join(cacheRoot, chromiumDir, "chrome-mac-arm64",
  "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");

const W = 1920, H = 1080;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
});
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/demo/demo.html?zoom=1.5`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);
await page.evaluate(() => window.__start());
await page.waitForFunction(() => window.__DEMO_DONE === true, null, { timeout: 180_000 });
await page.waitForTimeout(400);

const video = page.video();
await context.close();
const tmpPath = await video.path();
await browser.close();
server.close();

const out = join(OUT_DIR, "myfinance-mcp-demo.webm");
renameSync(tmpPath, out);
console.log("video:", out);
