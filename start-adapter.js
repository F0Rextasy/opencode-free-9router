#!/usr/bin/env node
/**
 * start-adapter — launch the OpenCode Free adapter with the console key pool.
 *
 * Why a launcher: when the caller does not send an `oc_sk_...` key the adapter
 * falls back to the anonymous `Bearer public` rail. Measured 2026-10-23 that
 * rail WORKS (upstream chat 200 with the attested client fingerprint), so the
 * console keys are optional — they only attribute the traffic to an account.
 * (The 2026-10-17 note claiming that rail answers `401` is outdated.)
 * The console keys, when present, live in `proxy-lab/out/.oc-zen-keys` (never in
 * this repository); this file loads them into `OC_ZEN_KEYS` so every downstream
 * caller (9Router / OmniRoute) can ride a real key without a secret ending up in
 * a command line or scheduled-task argument.
 *
 * The adapter starts its HTTP server only when it is the main module, so this
 * launcher runs it as a child process instead of importing it. The child gets
 * `windowsHide` and file-backed stdio: an inherited stdio from a console-less
 * watchdog makes Windows pop a visible Terminal window.
 *
 *   node start-adapter.js                 # PORT=8795 by default
 *   OC_ZEN_KEYS_FILE=/path/keys PORT=8796 node start-adapter.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.OC_ZEN_KEYS_FILE,
  path.join(here, '..', 'proxy-lab', 'out', '.oc-zen-keys'),      // providers/ layout
  path.join(here, '..', '..', 'proxy-lab', 'out', '.oc-zen-keys'), // repo-root layout
  path.join(os.homedir(), '.oc-zen-keys'),
].filter(Boolean);
const keysFile = candidates.find((p) => fs.existsSync(p));

let keys = [];
try {
  keys = fs.readFileSync(keysFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^oc_sk_[A-Za-z0-9_-]{16,}$/.test(l));
} catch {
  keys = [];
}

const env = { ...process.env, OC_ZEN_KEYS: keys.join(','), PORT: process.env.PORT || '8795' };
console.log(`start-adapter: ${keys.length} console key(s) loaded from ${keysFile || '(none found)'} · PORT=${env.PORT}`);
if (!keys.length) console.log('start-adapter: WARNING — no oc_sk_ keys found; adapter will fall back to Bearer public (upstream 401)');

const logFile = path.join(os.homedir(), '.omp', 'logs', 'ocfree-adapter.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const logFd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, [path.join(here, 'src', 'adapter.js')], {
  env,
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}
child.on('exit', (code) => process.exit(code ?? 0));
