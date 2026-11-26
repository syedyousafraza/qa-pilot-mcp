#!/usr/bin/env node
/**
 * demo.mjs — drives qa-pilot-mcp over stdio against the local demo page
 * and prints a transcript, so anyone can see what the server does without
 * owning an MCP client. Also saves screenshots/demo.png.
 *
 * Run with: npm run demo
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'screenshots');

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
    return { text, images };
  }
}

function startDemoServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/demo-page.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(await readFile(path.join(ROOT, 'examples', 'demo-page.html')));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const log = (title, body) => {
  console.log(`\n=== ${title} ===`);
  console.log(body);
};

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const demoServer = await startDemoServer();
  const port = demoServer.address().port;
  const demoUrl = `http://127.0.0.1:${port}/demo-page.html`;

  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, DEMO_URL: demoUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new McpClient(child);

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'qa-pilot-demo', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    log('connected', `${init.serverInfo.name} v${init.serverInfo.version} — protocol ${init.protocolVersion}`);

    const listed = await client.request('tools/list');
    log('tools', listed.tools.map((t) => t.name).join(', '));

    const nav = await client.callTool('browser_navigate', { url: demoUrl });
    log('browser_navigate', nav.text);

    const snap = await client.callTool('browser_snapshot', {});
    log('browser_snapshot (trimmed)', snap.text.split('\n').slice(0, 25).join('\n'));

    const showRef = snap.text.match(/Show message[^\n]*\[ref=(e\d+)\]/)[1];
    const clicked = await client.callTool('browser_click', { ref: showRef });
    log('browser_click (Show message)', clicked.text);

    const healed = await client.callTool('heal_selector', { selector: '#checkout-btn' });
    log('heal_selector (#checkout-btn — renamed in the last release)', healed.text);

    const shot = await client.callTool('browser_screenshot', {});
    const png = Buffer.from(shot.images[0].data, 'base64');
    await writeFile(path.join(SHOTS, 'demo.png'), png);
    log('browser_screenshot', `saved screenshots/demo.png (${png.length} bytes)`);

    const diag = await client.callTool('browser_console', {});
    log('browser_console', diag.text);

    const run = await client.callTool('run_playwright_test', { file: 'examples/demo.spec.js' });
    const runJson = JSON.parse(run.text);
    log('run_playwright_test', `total ${runJson.summary.total}, passed ${runJson.summary.passed}, failed ${runJson.summary.failed} in ${runJson.durationMs}ms\n` +
      runJson.failures.map((f) => `FAILED: ${f.title}\n  ${f.message.split('\n')[0]}\n  at ${f.location}`).join('\n'));

    console.log('\nDemo complete.');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    demoServer.close();
  }
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
