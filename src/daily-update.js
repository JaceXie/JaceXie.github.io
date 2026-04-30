#!/usr/bin/env node
/**
 * daily-update.js — 海图夜读每日维护入口
 *
 * 由 PM2 cron 每天 6:00 AM 触发；亦可手动 `npm run update`。
 *
 * 流程：
 * 1. 加载 data/tickers.json
 * 2. 并行调用 yfinance Python 脚本拉取每个 ticker 的财报/派息日期
 * 3. 检测新财报 → pending.json + 桌面通知
 * 4. 构建日历事件（窗口：过去 7 天 + 全部未来）
 * 5. 注入 index.html 三处 marker
 * 6. 如有 git diff，commit + push
 *
 * 环境变量：
 *   DRY_RUN=1  — 只输出预期变化，不写文件、不通知、不 push
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './lib/logger.js';
import { fetchAll } from './lib/data-fetcher.js';
import { detectNewEarnings } from './lib/earnings-detector.js';
import { buildCalendar } from './lib/calendar-builder.js';
import { injectHtml } from './lib/html-injector.js';
import { notify } from './lib/notifier.js';
import { hasChanges, commitAndPush } from './lib/publisher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const TICKERS_PATH = join(repoRoot, 'data', 'tickers.json');
const PENDING_PATH = join(repoRoot, 'data', 'pending.json');
const INDEX_PATH = join(repoRoot, 'index.html');

const DRY_RUN = process.env.DRY_RUN === '1';

function todayStr() {
  // 本地时区今日，YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function main() {
  const t0 = Date.now();
  const today = todayStr();

  logger.step(`Daily update started · today=${today} · DRY_RUN=${DRY_RUN}`);

  // 1. 加载 tickers
  if (!existsSync(TICKERS_PATH)) {
    logger.error(`tickers.json not found at ${TICKERS_PATH}. Run 'npm run bootstrap' first.`);
    process.exit(1);
  }
  const { tickers } = JSON.parse(readFileSync(TICKERS_PATH, 'utf-8'));
  logger.info(`Loaded ${tickers.length} tickers from data/tickers.json`);

  // 2. 拉取所有 ticker 数据
  logger.step('Fetching yfinance data');
  const fetchResults = await fetchAll(tickers);
  const successCount = fetchResults.filter((r) => r.data).length;
  logger.info(`Fetched ${successCount}/${tickers.length} tickers successfully`);

  if (successCount === 0) {
    logger.error('All yfinance fetches failed. Aborting to avoid wiping calendar.');
    process.exit(2);
  }

  // 3. 检测新财报
  logger.step('Detecting new earnings');
  const pending = detectNewEarnings(fetchResults, today);

  if (pending.length > 0) {
    logger.warn(`🚨 检测到 ${pending.length} 份新财报：${pending.map((p) => p.ticker).join(', ')}`);

    if (!DRY_RUN) {
      writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
      logger.info(`✓ Wrote ${PENDING_PATH}`);

      const tickerNames = pending.map((p) => p.ticker).join(', ');
      notify(
        `海图：发现 ${pending.length} 份新财报`,
        `${tickerNames} 已发布新财报。请手动跑 /haitu <TICKER> 重新分析。`
      );
    } else {
      logger.info(`DRY_RUN: would write pending.json with ${pending.length} entries`);
    }
  } else {
    logger.info('✓ 无新财报检测');
  }

  // 4. 构建日历
  logger.step('Building calendar (window: -7d to future)');
  const calendarEvents = buildCalendar(fetchResults, today);

  // 5. 注入 index.html
  logger.step('Injecting index.html');
  if (DRY_RUN) {
    logger.info('DRY_RUN: would inject index.html with:');
    logger.info(`  - ${tickers.length} report cards`);
    logger.info(`  - ${calendarEvents.length} calendar events`);
    logger.info(`  - today = ${today}`);
  } else {
    try {
      injectHtml(INDEX_PATH, { tickers, calendarEvents, todayStr: today });
      logger.info(`✓ index.html updated`);
    } catch (e) {
      logger.error(`injectHtml failed: ${e.message}`);
      process.exit(3);
    }
  }

  // 6. 提交 + 推送
  logger.step('Publishing');
  if (DRY_RUN) {
    logger.info('DRY_RUN: skipping git operations');
  } else if (hasChanges(repoRoot)) {
    const summary = pending.length > 0
      ? `chore(daily): 自动更新日历 + 检测 ${pending.length} 份新财报 [skip ci]`
      : `chore(daily): 自动更新日历 (${today}) [skip ci]`;
    const ok = commitAndPush(repoRoot, summary);
    if (!ok) process.exitCode = 4;
  } else {
    logger.info('No changes, skipping commit');
  }

  const ms = Date.now() - t0;
  logger.step(`Daily update finished in ${ms}ms`);
}

main().catch((e) => {
  logger.error(`Unhandled error: ${e.stack || e.message}`);
  process.exit(99);
});
