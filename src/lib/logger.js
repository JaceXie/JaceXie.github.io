import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const LOG_DIR = join(repoRoot, 'logs');
const LOG_FILE = join(LOG_DIR, 'daily-update.log');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function fmt(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return `[${ts()}] [${level}] ${msg}`;
}

function write(line) {
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* ignore log errors */
  }
}

export const logger = {
  info(...args) {
    const line = fmt('INFO', args);
    console.log(line);
    write(line);
  },
  warn(...args) {
    const line = fmt('WARN', args);
    console.warn(line);
    write(line);
  },
  error(...args) {
    const line = fmt('ERROR', args);
    console.error(line);
    write(line);
  },
  step(label) {
    const line = fmt('STEP', [`── ${label} ──`]);
    console.log(line);
    write(line);
  }
};
