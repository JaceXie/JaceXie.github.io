import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from './logger.js';

const MARKERS = {
  reports: {
    re: /\/\* HAITU:REPORTS:START[\s\S]*?\/\* HAITU:REPORTS:END \*\//,
    startTag: '/* HAITU:REPORTS:START',
    label: 'reports'
  },
  calendar: {
    re: /\/\* HAITU:CALENDAR:START[\s\S]*?\/\* HAITU:CALENDAR:END \*\//,
    startTag: '/* HAITU:CALENDAR:START',
    label: 'calendar'
  },
  today: {
    re: /\/\* HAITU:TODAY:START \*\/[\s\S]*?\/\* HAITU:TODAY:END \*\//,
    startTag: '/* HAITU:TODAY:START',
    label: 'today'
  }
};

// 首屏预渲染块。刻意不放进上面的 MARKERS —— 那个循环里缺失即 throw，
// 而这一块是渐进增强：缺了页面照常工作，不该为它把每日的日历与日期更新一起阻断。
export const STOCKROWS_RE = /<!-- HAITU:STOCKROWS:START -->[\s\S]*?<!-- HAITU:STOCKROWS:END -->/;
const PRERENDER_ROWS = 16;   // 1920×1080 首屏约看得见 13 行，留 3 行余量

/**
 * 将 reports 数组、calendar 数组、today 日期注入 index.html。
 *
 * tickers: 来自 data/tickers.json 的 tickers 数组
 * calendarEvents: 来自 calendar-builder 输出
 * todayStr: "YYYY-MM-DD"
 */
export function injectHtml(htmlPath, { tickers, calendarEvents, todayStr }) {
  let html = readFileSync(htmlPath, 'utf-8');
  backfillModTime(tickers, dirname(resolve(htmlPath)));

  // 验证每对 marker 恰好存在一份。
  // ⚠️ 不能只查「存在」：正则非全局 + String.replace 只替换第一处，
  //    所以重复的 marker 块不会报错，但会变成一个永远不再更新的僵尸块；
  //    若僵尸块同样声明 const reports，整段脚本 SyntaxError、门户全白。
  for (const [k, m] of Object.entries(MARKERS)) {
    if (!m.re.test(html)) {
      throw new Error(`Marker ${k} (${m.re.source.slice(0, 30)}…) not found in ${htmlPath}`);
    }
    const n = html.split(m.startTag).length - 1;
    if (n !== 1) throw new Error(`Marker ${k} 出现 ${n} 次，必须恰好 1 次（${htmlPath}）`);
  }

  // ── REPORTS ──
  // ⚠️ desc 刻意不注入首页。它是 99 段富文本、gzip 后占全站传输量的 72%，
  //    而门户前端一处都没有读它（没有展开 UI）。原文完整保存在 data/tickers.json。
  const sortedTickers = [...tickers].sort((a, b) => toEpoch(b.modTime) - toEpoch(a.modTime));
  const reportsBlock = renderReportsBlock(sortedTickers);
  assertParses(reportsBlock, 'reports');
  html = html.replace(MARKERS.reports.re, () => reportsBlock);   // 必须函数形式，见文件底部说明
  logger.info(`Injected ${tickers.length} reports`);

  // ── 首屏预渲染（渐进增强，失败不阻断当日注入）──
  try {
    const rowsBlock = renderStockRowsBlock(sortedTickers, html);
    html = html.replace(STOCKROWS_RE, () => rowsBlock);
    logger.info(`Injected ${Math.min(PRERENDER_ROWS, sortedTickers.length)} prerendered rows`);
  } catch (e) {
    logger.error(`预渲染首屏失败，保留上一次的块，不阻断当日注入：${e.message}`);
  }

  // ── CALENDAR ──
  const calendarBlock = renderCalendarBlock(calendarEvents);
  assertParses(calendarBlock, 'calendar');
  html = html.replace(MARKERS.calendar.re, () => calendarBlock);
  logger.info(`Injected ${calendarEvents.length} calendar events`);

  // ── TODAY ──
  const todayBlock = `/* HAITU:TODAY:START */ new Date('${todayStr}') /* HAITU:TODAY:END */`;
  html = html.replace(MARKERS.today.re, () => todayBlock);
  logger.info(`Injected today: ${todayStr}`);

  writeFileSync(htmlPath, html);
  return html;
}

/**
 * 生成写死进 HTML 的首屏若干行。
 *
 * ⚠️ 这里刻意不重写 rowHtml / fmtPrice / COLS —— 预渲染的唯一正确性标准就是
 *    「与前端产出逐字节相同」，再写一份实现等于自造一个会慢慢漂移的分叉：
 *    排序次键、千分位阈值、GBp 的后缀 p、rating||tag 回退，每一条都能悄悄错开。
 *    改为从 index.html 的 HAITU:ROWTPL 段抠出真身在 Node 里执行，漂移在结构上不可能发生。
 *    抠取失败会 throw，被上层 catch 成一条错误日志（这一块是渐进增强，不值得阻断每日更新）。
 */
export function renderStockRowsBlock(sortedTickers, html) {
  const m = html.match(/\/\* HAITU:ROWTPL:START[\s\S]*?\/\* HAITU:ROWTPL:END \*\//);
  if (!m) throw new Error('ROWTPL 段未找到');
  const make = new Function('favs', m[0] + '\n; return { rowHtml, COLS };');
  const { rowHtml, COLS } = make(new Set());          // 构建期不可知收藏态，一律按未收藏渲染

  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const recs = sortedTickers.map((t) => ({
    file: str(t.lastReportFile),
    ticker: str(t.marketSymbol),
    name: str(t.displayName || t.name || t.ticker),
    tag: str(t.tag),
    tagClass: str(t.ratingClass),
    rating: str(t.rating),
    currentPrice: num(t.currentPrice),
    targetPrice: num(t.targetPrice),
    currency: str(t.targetCurrency || t.priceCurrency || 'USD'),
    period: str(t.lastReportPeriod),
    date: str(t.lastAnalyzedDate),
    modTime: toEpoch(t.modTime)
  }));

  // 前端 rowHtml 对 name / period / file 是裸插值的，所以这里做完整 HTML 转义反而会
  // 与 JS 接管后的产出不一致。改为拒绝真正会撕碎表格的字符，让问题在构建期就暴露。
  const cmp = COLS.find((c) => c.key === 'date').sort;   // 用前端的默认排序，不是纯 modTime 降序
  const top = [...recs].sort(cmp).slice(0, PRERENDER_ROWS);
  for (const r of top) {
    for (const k of ['name', 'period', 'file', 'ticker', 'date']) {
      if (/[<>]/.test(r[k])) throw new Error(`${r.ticker} 的 ${k} 含尖括号，会撕碎预渲染表格`);
    }
  }

  const rows = top.map(rowHtml).join('');
  const nTr = (rows.match(/<tr /g) || []).length;
  if (nTr !== top.length) throw new Error(`期望 ${top.length} 行，实得 ${nTr}`);
  if (/<\/script/i.test(rows)) throw new Error('预渲染内容含 </script，会提前闭合脚本');
  if (/HAITU:/.test(rows)) throw new Error('预渲染内容含 HAITU: 标记，会污染 marker 匹配');
  return `<!-- HAITU:STOCKROWS:START -->${rows}<!-- HAITU:STOCKROWS:END -->`;
}

export function renderReportsBlock(tickers) {
  const items = tickers
    .map((t) => {
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
 * modTime 缺失时用报告文件的 mtime 兜底，并修正早于研判日的陈旧值。
 *
 * 为什么需要：门户前端按「研判日降序 → modTime 降序」排序，modTime 缺失会被
 * toEpoch() 变成 0，于是那张卡片沉到当天最后。实测事故：手工插进自动生成区的
 * 4 张卡片（06127 / BCE / RKT / VST）都没写 modTime，结果 8 月 10 日新出的
 * 两份报告排在同一天其它报告的下面，用户以为报告丢了。
 * 另有 11 条的 modTime 早于自己的 lastAnalyzedDate —— 一份 8 月 10 日研判的
 * 报告不可能是 7 月 12 日写的，这类陈旧值同样会把卡片压下去。
 *
 * 兜底只会把时间往后调、不会往前调，所以不可能因此把某张卡片挤下去。
 */
function backfillModTime(tickers, siteRoot) {
  let fixed = 0;
  for (const t of tickers) {
    if (!t.lastReportFile) continue;
    let mtime = 0;
    try { mtime = statSync(resolve(siteRoot, t.lastReportFile)).mtimeMs; } catch { continue; }
    const cur = toEpoch(t.modTime);
    const day = toEpoch(t.lastAnalyzedDate);
    if (!cur || (day && cur < day)) {
      t.modTime = mtime;
      fixed++;
    }
  }
  if (fixed) logger.warn(`modTime 缺失或陈旧，已按报告文件 mtime 兜底 ${fixed} 条`);
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
