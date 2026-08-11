#!/usr/bin/env node
/**
 * bootstrap-tickers.js
 *
 * 一次性脚本：从当前 index.html 中的 reports + calendar 数组提取数据，
 * 生成 data/tickers.json（master source of truth）。
 *
 * 不调用 yfinance，纯文本提取。运行后将由人工 review 并补充
 * yfinanceSymbol / lastEarningsReleaseDate 等字段。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const INDEX_PATH = join(repoRoot, 'index.html');
const OUTPUT_PATH = join(repoRoot, 'data', 'tickers.json');

// 从 ticker (NASDAQ: MSFT / HKEX: 0700) 提取 yfinance symbol
function toYfinanceSymbol(marketSymbol, ticker) {
  // marketSymbol 形如 "NASDAQ: MSFT" 或 "HKEX: 0700"
  const market = marketSymbol.split(':')[0].trim().toUpperCase();
  if (market === 'HKEX') {
    // 港股：0700 → 0700.HK；06690 → 6690.HK（yfinance 会去前导零）
    const code = ticker.replace(/^0+/, '') || ticker;
    return `${code.padStart(4, '0')}.HK`;
  }
  if (market === 'NASDAQ' || market === 'NYSE') {
    return ticker;
  }
  // A 股
  if (market === 'SSE' || market === 'SHA') return `${ticker}.SS`;
  if (market === 'SZSE' || market === 'SZ') return `${ticker}.SZ`;
  return ticker;
}

// 从 marketSymbol 提取纯 ticker (e.g. "NASDAQ: MSFT" → "MSFT")
function extractTicker(marketSymbol) {
  const parts = marketSymbol.split(':');
  return parts[parts.length - 1].trim();
}

// 雪球代码映射：港股 4 位补 0 到 5 位
function toXueqiuCode(marketSymbol, ticker) {
  const market = marketSymbol.split(':')[0].trim().toUpperCase();
  if (market === 'HKEX') {
    return ticker.padStart(5, '0');
  }
  return ticker;
}

// 从 lastReportFile 推断 ticker symbol 和 period
// e.g. "haitu/reports/msft-q3-fy2026.html" → { symbol: "msft", period: "Q3 FY2026" }
function parseReportFile(file) {
  const m = file.match(/haitu\/reports\/([^-]+)-(.+)\.html$/);
  if (!m) return { symbol: null, period: null };
  const symbol = m[1].toUpperCase();
  // period: "q3-fy2026" → "Q3 FY2026"; "q4-2025" → "Q4 2025"
  const period = m[2]
    .toUpperCase()
    .replace(/-/g, ' ')
    .replace(/\bFY(\d+)\b/, 'FY$1')
    .replace(/\bQ(\d)\b/, 'Q$1');
  return { symbol, period };
}

// 主逻辑：从 index.html 提取 reports 数组
function extractReports(html) {
  const startMarker = /const reports = \[/;
  const start = html.search(startMarker);
  if (start === -1) throw new Error('Cannot find "const reports = ["');

  // 找到匹配的 "];"
  let depth = 0;
  let i = start + 'const reports = '.length;
  let arrStart = i;
  for (; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  const arrText = html.slice(arrStart, i + 1);

  // 用 eval 安全（这是我们自己的本地文件）
  // 但更安全的做法：用正则提取每条记录
  const records = [];
  // modTime 允许小数：backfillModTime 直接写 statSync().mtimeMs，那是浮点。
  // 原来的 \d+ 会让带小数的记录整条匹配不上而被静默丢弃（实测 99 条只抓到 93 条）。
  const recordPattern = /\{\s*file:\s*"([^"]+)",[\s\S]*?modTime:\s*([\d.]+)\s*\}/g;
  let m;
  while ((m = recordPattern.exec(arrText)) !== null) {
    const block = m[0];
    records.push({
      file: extractField(block, 'file'),
      ticker: extractField(block, 'ticker'),
      title: extractField(block, 'title'),
      desc: extractField(block, 'desc'),
      tag: extractField(block, 'tag'),
      tagClass: extractField(block, 'tagClass'),
      date: extractField(block, 'date'),
      modTime: Math.round(parseFloat(m[2]))
    });
  }
  return records;
}

function extractField(block, name) {
  // 匹配 name: "..." (允许字符串中含转义引号)
  const re = new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = block.match(re);
  return m ? m[1] : null;
}

function main() {
  const html = readFileSync(INDEX_PATH, 'utf-8');
  const reports = extractReports(html);

  console.log(`✓ 从 index.html 提取到 ${reports.length} 条报告记录`);

  // index.html 已不再携带 desc，改从现有 tickers.json 保留（按报告文件名对齐）。
  // 文件不存在时降级为空 Map —— 那是真正的首次 bootstrap，本来就没有 desc 可保。
  const existingDesc = new Map();
  try {
    for (const t of JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')).tickers) {
      if (t.lastReportFile && t.desc) existingDesc.set(t.lastReportFile, t.desc);
    }
    console.log(`✓ 从现有 tickers.json 保留 ${existingDesc.size} 段 desc`);
  } catch (e) {
    console.warn('！未能读取现有 tickers.json，desc 将为空：' + e.message);
  }

  const tickers = reports.map((r) => {
    const ticker = extractTicker(r.ticker); // "NASDAQ: MSFT" → "MSFT"
    const { symbol, period } = parseReportFile(r.file);
    return {
      ticker,
      yfinanceSymbol: toYfinanceSymbol(r.ticker, ticker),
      marketSymbol: r.ticker,
      xueqiuCode: toXueqiuCode(r.ticker, ticker),
      name: r.title.split(' ').slice(0, 2).join(' '), // 粗糙：取标题前两个词
      lastReportFile: r.file,
      lastReportPeriod: period,
      lastAnalyzedDate: r.date,
      // 此字段需要人工补充：上次财报实际发布日期
      // 暂时用 lastAnalyzedDate 作为占位（保守，避免误判）
      lastEarningsReleaseDate: r.date,
      rating: r.tag.split('/')[0].trim(),
      ratingClass: r.tagClass,
      tag: r.tag,
      title: r.title,
      // ⚠️ desc 自 2026-08-11 起不再注入 index.html（它占首页传输量七成而前端一处都不读）。
      //    所以这里必然抓不到，只能从既有的 tickers.json 里保留 —— 否则跑一次 bootstrap
      //    就会把 99 段人工撰写的点评全部写成 null，且不可逆。
      desc: r.desc ?? existingDesc.get(r.file) ?? null,
      modTime: r.modTime
    };
  });

  const output = { tickers };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`✓ 写入 ${OUTPUT_PATH}`);

  console.log('\n提取的 tickers:');
  tickers.forEach((t) => {
    console.log(`  - ${t.ticker.padEnd(8)} ${t.yfinanceSymbol.padEnd(10)} ${t.lastReportPeriod}`);
  });

  console.log(
    '\n⚠️  注意：lastEarningsReleaseDate 暂时设为 lastAnalyzedDate。' +
      '\n   首次 npm run update 后，会被 yfinance 真实数据覆盖（如果 yfinance 返回了 lastEarningsDate）。'
  );
}

main();
