/**
 * Integration test: speaks MCP over stdio to the real server and drives a
 * real Chromium against the local demo page.
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Minimal JSON-RPC client over the server's stdio. */
class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    child.stdout.on('data', (d) => {
      this.buffer += d.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const images = (result.content ?? []).filter((c) => c.type === 'image');
    return { text, images, raw: result };
  }
}

function startDemoServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/demo-page.html') {
        const html = await readFile(path.join(ROOT, 'examples', 'demo-page.html'));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('MCP server: list tools, navigate, snapshot, click, type, heal, run test', { timeout: 180000 }, async () => {
  const demoServer = await startDemoServer();
  const port = demoServer.address().port;
  const demoUrl = `http://127.0.0.1:${port}/demo-page.html`;

  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, DEMO_URL: demoUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new McpClient(child);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'qa-pilot-test', version: '1.0.0' },
    });
    assert.equal(init.serverInfo.name, 'qa-pilot-mcp');
    client.notify('notifications/initialized');

    const listed = await client.request('tools/list');
    const names = listed.tools.map((t) => t.name);
    for (const expected of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_evaluate', 'browser_console', 'heal_selector', 'run_playwright_test']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    // navigate + snapshot
    const nav = await client.callTool('browser_navigate', { url: demoUrl });
    const navJson = JSON.parse(nav.text);
    assert.equal(navJson.title, 'QA Pilot demo shop');

    const snap = await client.callTool('browser_snapshot', {});
    assert.match(snap.text, /QA Pilot demo shop/);
    assert.match(snap.text, /Add to cart/);
    const refMatch = snap.text.match(/Add to cart[^\n]*\[ref=(e\d+)\]/);
    assert.ok(refMatch, 'Add to cart button should have a ref');

    // click "Show message" and confirm the message appears
    const showRef = snap.text.match(/Show message[^\n]*\[ref=(e\d+)\]/);
    assert.ok(showRef, 'Show message button should have a ref');
    await client.callTool('browser_click', { ref: showRef[1] });
    const evalAfter = await client.callTool('browser_evaluate', { expression: "document.getElementById('message').textContent" });
    assert.match(evalAfter.text, /Hello from the demo page/);

    // type into the quantity field, then click Add to cart
    const qtyRef = snap.text.match(/Quantity[^\n]*\[ref=(e\d+)\]/) || snap.text.match(/textbox[^\n]*\[ref=(e\d+)\]/);
    assert.ok(qtyRef, 'quantity field should have a ref');
    await client.callTool('browser_type', { ref: qtyRef[1], text: '3' });
    await client.callTool('browser_click', { ref: refMatch[1] });
    const cartMsg = await client.callTool('browser_evaluate', { expression: "document.getElementById('message').textContent" });
    assert.match(cartMsg.text, /Added 3/);

    // screenshot returns an image block
    const shot = await client.callTool('browser_screenshot', {});
    assert.equal(shot.images.length, 1);
    assert.ok(shot.images[0].data.length > 1000, 'screenshot should be a real PNG');

    // console should be clean
    const diag = await client.callTool('browser_console', {});
    const diagJson = JSON.parse(diag.text);
    assert.deepEqual(diagJson.pageErrors, []);

    // heal the renamed checkout button
    const healed = await client.callTool('heal_selector', { selector: '#checkout-btn' });
    const healedJson = JSON.parse(healed.text);
    assert.equal(healedJson.found, true);
    assert.match(healedJson.suggestions[0].locator, /Add to cart/);

    // run the real Playwright spec: 2 pass, 1 fails on purpose
    const run = await client.callTool('run_playwright_test', { file: 'examples/demo.spec.js' });
    const runJson = JSON.parse(run.text);
    assert.equal(runJson.summary.total, 3);
    assert.equal(runJson.summary.passed, 2);
    assert.equal(runJson.summary.failed, 1);
    assert.equal(runJson.failures.length, 1);
    assert.match(runJson.failures[0].message, /demo store/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    demoServer.close();
    assert.doesNotMatch(stderr, /failed to start/);
  }
});
