/**
 * Bundled dev server.
 *
 * The Vite dev server answers a cold page load with one request per module:
 * ~80 requests and a module waterfall ~13 hops deep. Through a portal that is
 * tens of milliseconds away, that latency dominates the load. This script
 * serves the production bundle instead and rebuilds it on change, so the same
 * page loads in a handful of requests while the source stays live.
 *
 * Use `npm run dev` when you want HMR while editing components.
 *
 * Usage: node scripts/serve-bundled.mjs [--port 30384] [--host 0.0.0.0]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = readFlag('port', process.env.PORT ?? '5173');
const host = readFlag('host', '0.0.0.0');

const children = [];

function run(label, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.log(`[serve-bundled] ${label} exited (${signal ?? code})`);
    shutdown();
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Rebuild on change, then serve dist/. Preview picks up new files from disk.
run('build', 'npx', ['vite', 'build', '--watch']);
run('preview', 'npx', ['vite', 'preview', '--host', host, '--port', String(port), '--strictPort']);
