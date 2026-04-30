import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = join(__dirname, '..', 'scripts', 'fetch_calendar_events.py');

/**
 * Fetch one ticker's calendar/earnings/dividend data via Python yfinance.
 * Returns null on hard error.
 */
export async function fetchTicker(yfinanceSymbol, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn('python3', [PYTHON_SCRIPT, yfinanceSymbol], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        proc.kill();
      } catch {}
      logger.warn(`fetchTicker(${yfinanceSymbol}) timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (code !== 0) {
        logger.warn(`fetchTicker(${yfinanceSymbol}) exit ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }

      // 取最后一行 JSON（前面可能有 yfinance 警告）
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];

      try {
        const data = JSON.parse(lastLine);
        if (data.warnings && data.warnings.length) {
          data.warnings.forEach((w) => logger.warn(`[${yfinanceSymbol}] ${w}`));
        }
        resolve(data);
      } catch (e) {
        logger.warn(`fetchTicker(${yfinanceSymbol}) JSON parse failed: ${lastLine.slice(0, 100)}`);
        resolve(null);
      }
    });
  });
}

/**
 * Fetch all tickers in parallel with concurrency limit.
 */
export async function fetchAll(tickers, concurrency = 4) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tickers.length) {
      const idx = i++;
      const t = tickers[idx];
      const data = await fetchTicker(t.yfinanceSymbol);
      results[idx] = { ticker: t, data };
      if (data) {
        logger.info(
          `[${t.ticker}] next=${data.nextEarningsDate || '—'} last=${data.lastEarningsDate || '—'} exDiv=${data.exDividendDate || '—'} pay=${data.dividendPaymentDate || '—'}`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
