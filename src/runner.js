/**
 * runner.js — run a real Playwright test file and return structured results.
 *
 * It shells out to `playwright test` (from @playwright/test) with the JSON
 * reporter, then parses the report into a small summary: how many passed,
 * failed or were skipped, and for each failure the test title, the error
 * message and the file/line. No screen-scraping of terminal output.
 *
 * The test file runs with the project's own playwright.config (see the repo
 * root), which points the runner at the installed Chromium. A test file
 * outside the project can be run too — pass its absolute path.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Playwright error messages carry terminal colour codes — strip them. */
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runPlaywrightTest(testFile, { timeoutMs = 120000 } = {}) {
  const absolute = path.isAbsolute(testFile) ? testFile : path.join(ROOT, testFile);
  try {
    await access(absolute, constants.R_OK);
  } catch {
    return { ok: false, error: `Test file not found or not readable: ${testFile}` };
  }

  const playwrightBin = path.join(ROOT, 'node_modules', '.bin', 'playwright');
  // NOTE: do NOT set PLAYWRIGHT_JSON_OUTPUT_NAME — it would redirect the
  // JSON report to a file; we need it on stdout so we can parse it here.
  const env = { ...process.env, CI: '1' };
  const started = Date.now();
  const { code, stdout, stderr } = await runProcess(
    playwrightBin,
    ['test', absolute, '--reporter=json'],
    { cwd: ROOT, env, timeout: timeoutMs },
  );
  const durationMs = Date.now() - started;

  // The JSON reporter pretty-prints to stdout, so find the first '{'
  // and parse everything from there.
  let report = null;
  const jsonStart = stdout.indexOf('{');
  if (jsonStart >= 0) {
    try {
      report = JSON.parse(stdout.slice(jsonStart));
    } catch {
      report = null;
    }
  }

  if (!report) {
    return {
      ok: false,
      error: 'Could not parse the Playwright JSON report.',
      exitCode: code,
      durationMs,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr.slice(-2000),
    };
  }

  const tests = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const result = test.results?.[0];
        const status = result?.status ?? 'unknown';
        const title = [...(suite.title ? [suite.title] : []), spec.title, test.title].filter(Boolean).join(' › ');
        tests.push({ title, status, durationMs: result?.duration ?? 0 });
        if (status === 'passed') passed += 1;
        else if (status === 'skipped') skipped += 1;
        else {
          failed += 1;
          const err = result?.error;
          failures.push({
            title,
            message: err?.message ? stripAnsi(String(err.message)).split('\n').slice(0, 5).join('\n') : 'Unknown failure',
            location: err?.location
              ? `${err.location.file}:${err.location.line}:${err.location.column}`
              : spec.file ?? absolute,
          });
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);

  return {
    ok: code === 0,
    exitCode: code,
    durationMs,
    summary: { total: tests.length, passed, failed, skipped },
    tests,
    failures,
  };
}
