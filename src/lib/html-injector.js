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
  const sortedTickers = [...tickers].sort((a, b) => toEpoch(b.modTime) - toEpoch(a.modTime));
  const reportsBlock = renderReportsBlock(sortedTickers);
  assertParses(reportsBlock, 'reports');
  html = html.replace(MARKERS.reports.re, reportsBlock);
  logger.info(`Injected ${tickers.length} reports`);

  // ── CALENDAR ──
  const calendarBlock = renderCalendarBlock(calendarEvents);
  assertParses(calendarBlock, 'calendar');
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
      const displayName = escapeJsString(t.displayName || t.name || t.ticker);
      const rating = escapeJsString(t.rating || '');
      const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 'null');
      // ⚠️ 每一个插进 JS 的值都要过 escapeJsString / num / toEpoch，一个都不能裸插。
      // 实测事故：tickers.json 里 SMCI 一条的 modTime 是 ISO 字符串而非纪元毫秒，
      // 裸插值产出 `modTime: 2026-08-09T19:38:22Z`，整段 132KB 内联脚本语法错误，
      // 门户一份报告都渲染不出来，而管线一路 exit 0，没有任何报警。
      return `  {
    file: "${escapeJsString(t.lastReportFile)}",
    ticker: "${escapeJsString(t.marketSymbol)}",
    name: "${displayName}",
    title: "${title}",
    desc: "${desc}",
    tag: "${tag}",
    tagClass: "${escapeJsString(t.ratingClass)}",
    rating: "${rating}",
    currentPrice: ${num(t.currentPrice)},
    targetPrice: ${num(t.targetPrice)},
    currency: "${escapeJsString(t.targetCurrency || t.priceCurrency || 'USD')}",
    period: "${escapeJsString(t.lastReportPeriod || '')}",
    date: "${escapeJsString(t.lastAnalyzedDate)}",
    modTime: ${toEpoch(t.modTime)}
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

  // 按 displayName/ticker 分组添加注释（更可读）
  const byTicker = {};
  for (const e of events) {
    if (!byTicker[e.ticker]) byTicker[e.ticker] = [];
    byTicker[e.ticker].push(e);
  }

  const lines = [];
  for (const [ticker, list] of Object.entries(byTicker)) {
    const xueqiu = list[0].xueqiu;
    lines.push(`  /* ${ticker} (${xueqiu}) */`);
    for (const e of list) {
      const detail = escapeJsString(e.detail);
      const typeLabel = escapeJsString(e.typeLabel);
      const tickerStr = escapeJsString(e.ticker);
      lines.push(
        `  { date: "${escapeJsString(e.date)}", ticker: "${tickerStr}", type: "${escapeJsString(e.type)}", typeLabel: "${typeLabel}", detail: "${detail}", xueqiu: "${escapeJsString(e.xueqiu)}" },`
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
    .replace(/\r/g, '')
    // ⚠️ desc 是人写的任意 HTML。字符串里出现字面量 </script> 会提前关闭外层
    // <script> 标签，后面的代码变成页面文本 —— 和 modTime 那次是同一类事故：
    // 一个字符炸掉整个门户，而且不报错。拆开写成 <\/ 浏览器照样当 </ 解析。
    .replace(/<\//g, '<\\/');
}

/** 纪元毫秒。tickers.json 里历史上混进过 ISO 字符串，这里统一收口，绝不返回 NaN。 */
function toEpoch(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const t = Date.parse(v);
  return isFinite(t) ? t : 0;
}

/**
 * 生成的代码块必须能被解析。
 * new Function 只编译不执行，所以拿它当语法检查是安全的。
 * 没有这道断言，坏数据会一路静默写进 index.html —— 管线 exit 0、日志全绿、
 * 读者打开是一片空白。宁可让每日任务红着脸失败，也不要让门户悄悄空掉。
 */
function assertParses(block, name) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(block);
  } catch (e) {
    throw new Error(
      `注入 ${name} 失败：生成的代码不是合法 JavaScript（${e.message}）。` +
        `多半是 data/tickers.json 里某个字段类型不对。已中止，index.html 未被改动。`
    );
  }
}
