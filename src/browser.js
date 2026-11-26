/**
 * browser.js — one shared Chromium session for the MCP server.
 *
 * A single browser + page is kept alive across tool calls, so an AI agent
 * can navigate, look at the page, click things and take screenshots as one
 * continuous session — exactly how a human tester works.
 *
 * Snapshots are Playwright aria snapshots with stable refs ([ref=e1],
 * [ref=e2], ...). Refs are the handles tools use: `browser_click` takes a
 * ref, never a raw selector, so the agent clicks what it actually saw.
 *
 * Browser binary: playwright-core is used (no browser download on install).
 * It finds Chromium in the standard Playwright cache, or use
 * PLAYWRIGHT_CHROMIUM_PATH to point at an explicit binary.
 */
import { chromium } from 'playwright-core';

let browser = null;
let context = null;
let page = null;
/** ref -> { snapshotRef } for the latest snapshot */
let refMap = new Map();

const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];

export function getPage() {
  return page;
}

export function getRefMap() {
  return refMap;
}

async function ensureBrowser() {
  if (browser) return;
  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  browser = await chromium.launch(launchOptions);
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText ?? 'failed'}`);
  });
}

/** Navigate to a URL and return the title + final URL. */
export async function navigate(url) {
  await ensureBrowser();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return {
    url: page.url(),
    title: await page.title(),
    status: response?.status() ?? null,
  };
}

/**
 * Take an aria snapshot of the page. Playwright assigns each element a
 * stable ref for this snapshot ([ref=e123]); the agent clicks/types by
 * that ref, and we resolve it back with the `aria-ref=` selector.
 * Returns the snapshot text and the ref count.
 */
export async function snapshot() {
  await ensureBrowser();
  // "ai" mode is what adds the [ref=eN] handles; the default mode omits them.
  const raw = await page.locator('body').ariaSnapshot({ mode: 'ai' });
  refMap = new Map();
  const refs = [...raw.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1]);
  for (const ref of refs) refMap.set(ref, { snapshotRef: ref });
  return { snapshot: raw, refs: refs.length };
}
export function ariaLocatorForRef(ref) {
  const entry = refMap.get(ref);
  if (!entry) throw new Error(`Unknown ref "${ref}". Take a fresh snapshot first.`);
  return page.locator(`aria-ref=${entry.snapshotRef}`);
}

export async function clickRef(ref) {
  await ensureBrowser();
  const locator = ariaLocatorForRef(ref);
  await locator.click({ timeout: 10000 });
  return { clicked: ref, url: page.url() };
}

export async function typeRef(ref, text) {
  await ensureBrowser();
  const locator = ariaLocatorForRef(ref);
  await locator.fill(text, { timeout: 10000 });
  return { typed: ref, value: text, url: page.url() };
}

export async function screenshot() {
  await ensureBrowser();
  return page.screenshot({ type: 'png' });
}

export async function evaluate(expression) {
  await ensureBrowser();
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${expression})`);
  const value = await page.evaluate(fn);
  return value === undefined ? null : value;
}

/** Console errors, page errors and failed requests seen so far. */
export function diagnostics() {
  return {
    console: consoleMessages.slice(-50),
    pageErrors: pageErrors.slice(-20),
    failedRequests: failedRequests.slice(-20),
  };
}

export function clearDiagnostics() {
  consoleMessages.length = 0;
  pageErrors.length = 0;
  failedRequests.length = 0;
}

/** Collect every element's locator-friendly facts for the selector healer. */
export async function collectElements() {
  await ensureBrowser();
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return els.slice(0, 500).map((el) => {
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const ariaLabel = el.getAttribute('aria-label') || '';
      const testId = el.getAttribute('data-testid') || '';
      const role = el.getAttribute('role') || '';
      const tag = el.tagName.toLowerCase();
      const id = el.id || '';
      const cls = (el.className && typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      const type = el.getAttribute('type') || '';
      const name = el.getAttribute('name') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const label = el.labels ? [...el.labels].map((l) => (l.innerText || '').trim()).join(' ') : '';
      return { tag, text, ariaLabel, label, testId, role, id, cls, type, name, placeholder };
    });
  });
}

export async function close() {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}
