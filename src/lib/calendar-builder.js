import { logger } from './logger.js';

/**
 * 把 yfinance fetch 结果 + tickers.json 转成日历事件数组。
 *
 * 时间窗口：过去 7 天 + 全部未来。
 * 事件类型：earnings | ex-div | payment（match index.html 现有 type 集）
 *
 * 同时保留"已发布的最近一次财报 + 派息已发"事件 7 天内（标记 已发 / 已过）。
 */
export function buildCalendar(fetchResults, todayStr) {
  const events = [];
  const todayDate = new Date(todayStr);
  const sevenDaysAgo = new Date(todayDate);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenAgoStr = sevenDaysAgo.toISOString().slice(0, 10);

  for (const { ticker, data } of fetchResults) {
    if (!data) continue;
    const t = ticker;

    // ── 1. 下次财报 (earnings) ──
    if (data.nextEarningsDate && data.nextEarningsDate >= sevenAgoStr) {
      const isPast = data.nextEarningsDate < todayStr;
      const isToday = data.nextEarningsDate === todayStr;
      events.push({
        date: data.nextEarningsDate,
        ticker: t.xueqiuCode,
        type: 'earnings',
        typeLabel: isPast
          ? `${guessPeriodLabel(t)} 财报(已发)`
          : isToday
            ? `${guessPeriodLabel(t)} 财报(今日)`
            : `${guessPeriodLabel(t)} 财报(估)`,
        detail: buildEarningsDetail(t, data, isPast),
        xueqiu: t.xueqiuCode
      });
    }

    // ── 2. 上次财报（如果还在 7 天窗口内）──
    if (
      data.lastEarningsDate &&
      data.lastEarningsDate >= sevenAgoStr &&
      data.lastEarningsDate < todayStr &&
      data.lastEarningsDate !== data.nextEarningsDate
    ) {
      events.push({
        date: data.lastEarningsDate,
        ticker: t.xueqiuCode,
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
        ticker: t.xueqiuCode,
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
        ticker: t.xueqiuCode,
        type: 'payment',
        typeLabel: isPast ? '派息日(已发)' : '派息日',
        detail: `${getCompanyShortName(t)} — 股息派付 ${amount ? `<strong>${sym} ${formatMoney(amount, currency)}/股</strong>` : ''}`,
        xueqiu: t.xueqiuCode
      });
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
  return `${name} — 来源 yfinance 共识，关注 <a href="https://xueqiu.com/S/${ticker.xueqiuCode}" target="_blank" style="color:var(--accent-gold);">雪球行情</a>`;
}

function formatMoney(amount, currency) {
  if (typeof amount !== 'number') return amount;
  // 整数显示一位小数，非整数最多两位
  if (Math.abs(amount) >= 100) return amount.toFixed(2);
  return amount.toFixed(2);
}
