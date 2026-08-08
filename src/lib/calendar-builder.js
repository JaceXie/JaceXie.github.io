import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTICES_PATH = resolve(__dirname, '..', '..', 'data', 'earnings-notices.json');

/**
 * 行情链接。
 *
 * ⚠️ 雪球不收录韩国交易所标的（KOSPI 后缀 .KS / KOSDAQ 后缀 .KQ）。
 * 原来这里三处硬编码 `xueqiu.com/S/${xueqiuCode}`，对韩股会给出 404 ——
 * 例如 NICE평가정보（030190）在雪球根本没有页面。韩股一律指向 Naver 金融，
 * 那是韩国本地的标准行情源，用 tickers.json 的 6 位 ticker 作代码。
 *
 * 唯一的例外本可以是「有美股 ADS 的韩国公司」（如 SK 海力士的 SKHY），
 * 但按同一市场一套口径的原则，不再分叉 —— 报告正文里也已统一。
 */
export function quoteLink(t) {
  const sym = String(t.yfinanceSymbol || '');
  if (sym.endsWith('.KS') || sym.endsWith('.KQ')) {
    return {
      url: `https://finance.naver.com/item/main.naver?code=${t.ticker}`,
      label: 'Naver 금융',
    };
  }
  return { url: `https://xueqiu.com/S/${t.xueqiuCode}`, label: '雪球行情' };
}

/**
 * 把 yfinance fetch 结果 + tickers.json 转成日历事件数组。
 *
 * 时间窗口：过去 30 天 + 全部未来。
 * 事件类型：
 *   - earnings：实际财报发布日（yfinance 抓）
 *   - earnings-notice：业绩预告 / 盈利预告 / 盈利警告（从 data/earnings-notices.json 手工维护读取）
 *   - ex-div：除权日（yfinance 抓）
 *   - payment：派息日（yfinance 抓）
 *
 * 同时保留"已发布的最近一次财报 + 派息已发"事件 30 天内（标记 已发 / 已过）。
 */
export function buildCalendar(fetchResults, todayStr) {
  const events = [];
  const todayDate = new Date(todayStr);
  const pastCutoff = new Date(todayDate);
  pastCutoff.setDate(pastCutoff.getDate() - 30);
  const sevenAgoStr = pastCutoff.toISOString().slice(0, 10);

  for (const { ticker, data } of fetchResults) {
    if (!data) continue;
    const t = ticker;

    // displayName 优先（中文名），fallback 到 xueqiuCode
    const displayName = t.displayName || t.xueqiuCode;

    // ── 检测 yfinance 过时数据：nextEarningsDate 比 lastEarningsDate 晚 < 30 天 ──
    // 真正的下次财报应该至少 60 天后。如果 yfinance 的 next 紧贴 last（差 < 30 天），
    // 它一定是"陈旧预测"——已发布但 next 字段未更新。此时优先信任 lastEarningsDate，
    // 跳过 nextEarningsDate 避免重复显示。
    const nextStaleSuspect =
      data.nextEarningsDate &&
      data.lastEarningsDate &&
      daysBetween(data.lastEarningsDate, data.nextEarningsDate) < 30;

    if (nextStaleSuspect) {
      logger.info(
        `[${t.ticker}] yfinance nextEarningsDate=${data.nextEarningsDate} 距 lastEarningsDate=${data.lastEarningsDate} 仅 ${daysBetween(data.lastEarningsDate, data.nextEarningsDate)} 天，判定为过时预测，跳过`
      );
    }

    // ── yfinance 漏数据兜底：tickers.json 的 manualNextEarningsDate 优先级低于 yfinance，
    // 仅在 yfinance 没数据（或被判定为过时）时启用。适用于港股新上市/披露不全等情况。
    const yfNext = data.nextEarningsDate && !nextStaleSuspect ? data.nextEarningsDate : null;
    const nextEarnings = yfNext || t.manualNextEarningsDate || null;
    const isManualNext = !yfNext && !!t.manualNextEarningsDate;

    // ── 1. 下次财报 (earnings) ──
    if (nextEarnings && nextEarnings >= sevenAgoStr) {
      const isPast = nextEarnings < todayStr;
      const isToday = nextEarnings === todayStr;
      const tail = isPast ? '(已发)' : isToday ? '(今日)' : (isManualNext ? '(确认)' : '(估)');
      const name = getCompanyShortName(t);
      const detail = isPast
        ? `${name} — 详见<a href="${t.lastReportFile}" style="color:var(--accent-gold);">海图研判</a>`
        : isManualNext
          ? `${name} — 公司已确认发布日期，关注 <a href="${quoteLink(t).url}" target="_blank" style="color:var(--accent-gold);">${quoteLink(t).label}</a>`
          : `${name} — 来源 yfinance 共识，关注 <a href="${quoteLink(t).url}" target="_blank" style="color:var(--accent-gold);">${quoteLink(t).label}</a>`;
      events.push({
        date: nextEarnings,
        ticker: displayName,
        type: 'earnings',
        typeLabel: `${guessPeriodLabel(t)} 财报${tail}`,
        detail,
        xueqiu: t.xueqiuCode
      });
    }

    // ── 2. 上次财报（如果还在 30 天窗口内）──
    // yfinance 对部分港股（如 0811 新华文轩）不返回财报日期，
    // 此时回退到 tickers.json 已记录的 lastEarningsReleaseDate。
    const lastEarnings = data.lastEarningsDate || t.lastEarningsReleaseDate;
    if (
      lastEarnings &&
      lastEarnings >= sevenAgoStr &&
      lastEarnings < todayStr &&
      lastEarnings !== data.nextEarningsDate
    ) {
      events.push({
        date: lastEarnings,
        ticker: displayName,
        type: 'earnings',
        typeLabel: `${guessPrevPeriodLabel(t)} 财报(已发)`,
        detail: `${getCompanyShortName(t)} — 已发布，详见<a href="${t.lastReportFile}" style="color:var(--accent-gold);">海图研判</a>`,
        xueqiu: t.xueqiuCode
      });
    }

    // ── 3. 除权日 (ex-div) ──
    if (data.exDividendDate && data.exDividendDate >= sevenAgoStr) {
      const amount = data.dividendAmount;
      const currency = data.currency || 'USD';
      const sym = currency === 'HKD' ? 'HKD' : currency === 'CNY' ? '¥' : '$';
      const isPast = data.exDividendDate < todayStr;

      events.push({
        date: data.exDividendDate,
        ticker: displayName,
        type: 'ex-div',
        typeLabel: isPast ? '除权日(已过)' : '除权日',
        detail: `${getCompanyShortName(t)} — 股息 ${amount ? `<strong>${sym} ${formatMoney(amount, currency)}/股</strong>` : '（金额待披露）'}`,
        xueqiu: t.xueqiuCode
      });
    }

    // ── 4. 派息日 (payment) ──
    if (data.dividendPaymentDate && data.dividendPaymentDate >= sevenAgoStr) {
      const amount = data.dividendAmount;
      const currency = data.currency || 'USD';
      const sym = currency === 'HKD' ? 'HKD' : currency === 'CNY' ? '¥' : '$';
      const isPast = data.dividendPaymentDate < todayStr;

      events.push({
        date: data.dividendPaymentDate,
        ticker: displayName,
        type: 'payment',
        typeLabel: isPast ? '派息日(已发)' : '派息日',
        detail: `${getCompanyShortName(t)} — 股息派付 ${amount ? `<strong>${sym} ${formatMoney(amount, currency)}/股</strong>` : ''}`,
        xueqiu: t.xueqiuCode
      });
    }
  }

  // ── 5. 业绩预告 / 盈利预告 (earnings-notice) — 手工维护，从 data/earnings-notices.json 读取 ──
  if (existsSync(NOTICES_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(NOTICES_PATH, 'utf-8'));
      const notices = Array.isArray(raw.notices) ? raw.notices : [];
      let added = 0;
      for (const n of notices) {
        if (!n.noticeDate || n.noticeDate < sevenAgoStr) continue;
        const isPast = n.noticeDate < todayStr;
        const isToday = n.noticeDate === todayStr;
        const tail = isPast ? '(已发)' : isToday ? '(今日)' : '';
        const headline = n.headline || '业绩预告';
        const period = n.period ? `${n.period} ` : '';
        events.push({
          date: n.noticeDate,
          ticker: n.displayName || n.ticker || '',
          type: 'earnings-notice',
          typeLabel: `${period}${headline}${tail}`.trim(),
          detail: `${n.summary || ''}${n.sourceUrl ? ` · <a href="${n.sourceUrl}" target="_blank" style="color:var(--accent-gold);">公告原文</a>` : ''}`,
          xueqiu: n.xueqiu || n.ticker || ''
        });
        added++;
      }
      logger.info(`Loaded ${added} earnings-notice events from earnings-notices.json`);
    } catch (e) {
      logger.warn(`earnings-notices.json 读取失败：${e.message}`);
    }
  }

  // 去重（同 date + ticker + type）
  const seen = new Set();
  const dedup = events.filter((e) => {
    const k = `${e.date}|${e.ticker}|${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 按日期升序
  dedup.sort((a, b) => a.date.localeCompare(b.date));

  logger.info(`Built calendar with ${dedup.length} events (window: ${sevenAgoStr} → future)`);
  return dedup;
}

function daysBetween(dateA, dateB) {
  // 返回 |dateB - dateA| 的天数（绝对值）
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.abs(Math.round((b - a) / (1000 * 60 * 60 * 24)));
}

function getCompanyShortName(t) {
  // "Microsoft MSFT FY2026 Q3 海图研判" → "Microsoft"
  // 找第一段中英文
  const parts = t.title.split(/\s+/);
  const candidates = ['Microsoft', 'Alphabet', 'Lumentum', 'Vipshop', 'PDD', '腾讯', '海尔智家'];
  for (const c of candidates) {
    if (t.title.includes(c)) return c;
  }
  return parts[0];
}

function guessPeriodLabel(t) {
  // "Q3 FY2026" → "Q4 FY26"（下次推测）
  const prev = t.lastReportPeriod || '';
  const m1 = prev.match(/^Q(\d) FY(\d{4})$/);
  if (m1) {
    const q = parseInt(m1[1]);
    const fy = parseInt(m1[2]);
    if (q < 4) return `Q${q + 1} FY${fy.toString().slice(2)}`;
    return `Q1 FY${(fy + 1).toString().slice(2)}`;
  }
  const m2 = prev.match(/^Q(\d) (\d{4})$/);
  if (m2) {
    const q = parseInt(m2[1]);
    const y = parseInt(m2[2]);
    return q < 4 ? `Q${q + 1} ${y}` : `Q1 ${y + 1}`;
  }
  return '下次';
}

function guessPrevPeriodLabel(t) {
  return t.lastReportPeriod || '上次';
}

function buildEarningsDetail(ticker, data, isPast) {
  const name = getCompanyShortName(ticker);
  if (isPast) {
    return `${name} — 详见<a href="${ticker.lastReportFile}" style="color:var(--accent-gold);">海图研判</a>`;
  }
  const q = quoteLink(ticker);
  return `${name} — 来源 yfinance 共识，关注 <a href="${q.url}" target="_blank" style="color:var(--accent-gold);">${q.label}</a>`;
}

function formatMoney(amount, currency) {
  if (typeof amount !== 'number') return amount;
  // 整数显示一位小数，非整数最多两位
  if (Math.abs(amount) >= 100) return amount.toFixed(2);
  return amount.toFixed(2);
}
