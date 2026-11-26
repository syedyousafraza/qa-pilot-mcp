#!/usr/bin/env node
/**
 * qa-pilot-mcp — MCP server entry point.
 *
 * Speaks the Model Context Protocol over stdio, which is how Claude Desktop,
 * VS Code and other MCP clients launch it:
 *
 *   { "mcpServers": { "qa-pilot": { "command": "node", "args": ["/path/to/qa-pilot-mcp/src/server.js"] } } }
 *
 * Nine tools (see src/tools.js) + one prompt ("qa-smoke-test") that tells
 * an AI assistant how to smoke-test a URL step by step.
 *
 * Nothing is logged to stdout — stdio is the protocol channel. Diagnostics
 * go to stderr so they never corrupt a JSON-RPC frame.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOOLS } from './tools.js';
import { close as closeBrowser } from './browser.js';

const server = new McpServer({
  name: 'qa-pilot-mcp',
  version: '1.0.0',
});

for (const tool of TOOLS) {
  server.tool(tool.name, tool.description, tool.inputSchema, async (args) => tool.handler(args));
}

server.prompt(
  'qa-smoke-test',
  'Smoke-test a URL end to end and report what works and what breaks',
  { url: z.string().url() },
  async ({ url }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Smoke-test ${url} like a QA engineer would. Steps: 1) browser_navigate to the URL. 2) browser_snapshot and describe what the page offers. 3) browser_console — report any errors. 4) Click the main call-to-action and take a browser_snapshot + browser_screenshot after it. 5) If any selector fails, use heal_selector to fix it and retry once. 6) Report: what worked, what broke, and the exact failing step with evidence. Do not invent results — only report what the tools returned.`,
        },
      },
    ],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[qa-pilot-mcp] server started (stdio)');
}

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((err) => {
  console.error('[qa-pilot-mcp] failed to start:', err);
  process.exit(1);
});
