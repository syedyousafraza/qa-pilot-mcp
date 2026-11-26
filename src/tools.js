/**
 * tools.js — the nine tools QA Pilot exposes to AI assistants.
 *
 * Each tool is a plain object: a name, a plain-English description (this is
 * what the AI reads when deciding which tool to use), a zod input schema,
 * and a handler that returns MCP content blocks.
 *
 * Design rules the tools follow:
 * - Refs, not selectors, for clicking/typing: the agent acts on what it
 *   actually saw in the last snapshot.
 * - Every mutating call returns the new URL, so the agent always knows
 *   where it ended up.
 * - Failures are returned as text, never thrown — the agent can read the
 *   error and try another approach instead of the call dying.
 */
import { z } from 'zod';
import * as browser from './browser.js';
import { healSelector } from './healer.js';
import { runPlaywrightTest } from './runner.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (obj) => text(JSON.stringify(obj, null, 2));

export const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Go to a URL in the shared browser session. Returns the page title, final URL and HTTP status.',
    inputSchema: { url: z.string().url().describe('Full URL to open, e.g. https://example.com') },
    handler: async ({ url }) => json(await browser.navigate(url)),
  },
  {
    name: 'browser_snapshot',
    description: 'Get an accessibility snapshot of the current page. Every interactive element has a [ref=eN] handle — use those refs with browser_click and browser_type. Take a fresh snapshot after any navigation or click.',
    inputSchema: {},
    handler: async () => {
      const { snapshot, refs } = await browser.snapshot();
      return text(`Snapshot (${refs} interactive refs):\n${snapshot}`);
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element from the last snapshot, by its ref (e.g. "e123").',
    inputSchema: { ref: z.string().describe('Ref from the last browser_snapshot, e.g. e123') },
    handler: async ({ ref }) => json(await browser.clickRef(ref)),
  },
  {
    name: 'browser_type',
    description: 'Type text into an input from the last snapshot, by its ref. Clears the field first.',
    inputSchema: {
      ref: z.string().describe('Ref from the last browser_snapshot, e.g. e123'),
      text: z.string().describe('Text to type into the field'),
    },
    handler: async ({ ref, text: value }) => json(await browser.typeRef(ref, value)),
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page as a PNG image. Use it to see layout, visual bugs and anything the snapshot cannot show.',
    inputSchema: {},
    handler: async () => {
      const png = await browser.screenshot();
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Run a JavaScript expression in the page and get the result as JSON. Useful for reading state the snapshot hides (e.g. document.title, localStorage, window flags).',
    inputSchema: { expression: z.string().describe('JavaScript expression, e.g. document.title') },
    handler: async ({ expression }) => json(await browser.evaluate(expression)),
  },
  {
    name: 'browser_console',
    description: 'Read console errors, page errors and failed requests seen so far in this session. The first thing to check when a page looks broken.',
    inputSchema: {},
    handler: async () => json(browser.diagnostics()),
  },
  {
    name: 'heal_selector',
    description: 'Fix a CSS selector that stopped matching. Looks at what is actually on the page right now and suggests up to 3 resilient Playwright locators (role/label/text first, CSS last), ranked with reasons.',
    inputSchema: {
      selector: z.string().describe('The broken CSS selector, e.g. #submit-btn-old'),
    },
    handler: async ({ selector }) => {
      const elements = await browser.collectElements();
      return json(healSelector(selector, elements));
    },
  },
  {
    name: 'run_playwright_test',
    description: 'Run a real Playwright test file and return the structured result: passed/failed/skipped counts, per-test status, and the error message + file:line for every failure.',
    inputSchema: {
      file: z.string().describe('Path to a Playwright test file, relative to the project root or absolute'),
    },
    handler: async ({ file }) => json(await runPlaywrightTest(file)),
  },
];

/** Call a tool by name with validated args. Returns MCP content blocks. */
export async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return text(`Unknown tool: ${name}`);
  try {
    return await tool.handler(args ?? {});
  } catch (err) {
    return text(`Tool ${name} failed: ${err.message}`);
  }
}
