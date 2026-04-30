import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from './logger.js';

const MARKERS = {
  reports: {
    re: /\/\* HAITU:REPORTS:START[\s\S]*?\/\* HAITU:REPORTS:END \*\//,
    label: 'reports'
  },
  calendar: {
    re: /\/\* HAITU:CALENDAR:START[\s\S]*?\/\* HAITU:CALENDAR:END \*\//,
    label: 'calendar'
  },
  today: {
    re: /\/\* HAITU:TODAY:START \*\/[\s\S]*?\/\* HAITU:TODAY:END \*\//,
    label: 'today'
  }
};

/**
 * 将 reports 数组、calendar 数组、today 日期注入 index.html。
 *
 * tickers: 来自 data/tickers.json 的 tickers 数组
 * calendarEvents: 来自 calendar-builder 输出
 * todayStr: "YYYY-MM-DD"
 */
export function injectHtml(htmlPath, { tickers, calendarEvents, todayStr }) {
  let html = readFileSync(htmlPath, 'utf-8');

  // 验证所有 marker 都存在
  for (const [k, m] of Object.entries(MARKERS)) {
    if (!m.re.test(html)) {
      throw new Error(`Marker ${k} (${m.re.source.slice(0, 30)}…) not found in ${htmlPath}`);
    }
  }

  // ── REPORTS ──
  const sortedTickers = [...tickers].sort((a, b) => b.modTime - a.modTime);
  const reportsBlock = renderReportsBlock(sortedTickers);
  html = html.replace(MARKERS.reports.re, reportsBlock);
  logger.info(`Injected ${tickers.length} reports`);

  // ── CALENDAR ──
  const calendarBlock = renderCalendarBlock(calendarEvents);
  html = html.replace(MARKERS.calendar.re, calendarBlock);
  logger.info(`Injected ${calendarEvents.length} calendar events`);

  // ── TODAY ──
  const todayBlock = `/* HAITU:TODAY:START */ new Date('${todayStr}') /* HAITU:TODAY:END */`;
  html = html.replace(MARKERS.today.re, todayBlock);
  logger.info(`Injected today: ${todayStr}`);

  writeFileSync(htmlPath, html);
  return html;
}

function renderReportsBlock(tickers) {
  const items = tickers
    .map((t) => {
      const desc = escapeJsString(t.desc);
      const title = escapeJsString(t.title);
      const tag = escapeJsString(t.tag);
      return `  {
    file: "${t.lastReportFile}",
    ticker: "${t.marketSymbol}",
    title: "${title}",
    desc: "${desc}",
    tag: "${tag}",
    tagClass: "${t.ratingClass}",
    date: "${t.lastAnalyzedDate}",
    modTime: ${t.modTime}
  }`;
    })
    .join(',\n');

  return `/* HAITU:REPORTS:START -- 自动生成区域，请勿手工编辑 -- 由 src/daily-update.js 维护 */
const reports = [
${items},
];
/* HAITU:REPORTS:END */`;
}

function renderCalendarBlock(events) {
  if (!events.length) {
    return `/* HAITU:CALENDAR:START -- 自动生成区域，请勿手工编辑 -- 由 src/daily-update.js 每日 6am 更新 */
const calendar = [];
/* HAITU:CALENDAR:END */`;
  }

  // 按 ticker 分组添加注释（更可读）
  const byTicker = {};
  for (const e of events) {
    if (!byTicker[e.ticker]) byTicker[e.ticker] = [];
    byTicker[e.ticker].push(e);
  }

  const lines = [];
  for (const [ticker, list] of Object.entries(byTicker)) {
    lines.push(`  /* ${ticker} */`);
    for (const e of list) {
      const detail = escapeJsString(e.detail);
      const typeLabel = escapeJsString(e.typeLabel);
      lines.push(
        `  { date: "${e.date}", ticker: "${e.ticker}", type: "${e.type}", typeLabel: "${typeLabel}", detail: "${detail}", xueqiu: "${e.xueqiu}" },`
      );
    }
  }

  return `/* HAITU:CALENDAR:START -- 自动生成区域，请勿手工编辑 -- 由 src/daily-update.js 每日 6am 更新 */
const calendar = [
${lines.join('\n')}
];
/* HAITU:CALENDAR:END */`;
}

function escapeJsString(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}
