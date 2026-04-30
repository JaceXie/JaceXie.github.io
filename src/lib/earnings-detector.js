import { logger } from './logger.js';

/**
 * 检测哪些 ticker 发布了新财报但还没分析过。
 *
 * 规则：
 *   if yfinance 返回的 lastEarningsDate > tickers.json 的 lastEarningsReleaseDate
 *   AND lastEarningsDate <= today（已发布，不是预测）
 *   → 该 ticker 进入 pending 队列
 */
export function detectNewEarnings(fetchResults, todayStr) {
  const pending = [];

  for (const { ticker, data } of fetchResults) {
    if (!data || !data.lastEarningsDate) continue;

    const lastEarn = data.lastEarningsDate;
    const recorded = ticker.lastEarningsReleaseDate;

    // 必须是真实已过去的日期（不是 yfinance 的预估）
    if (lastEarn > todayStr) continue;

    // 比对：yfinance 的更新（且严格大于已记录）
    if (lastEarn > recorded) {
      const suggestedPeriod = guessNextPeriod(ticker.lastReportPeriod);
      pending.push({
        ticker: ticker.ticker,
        yfinanceSymbol: ticker.yfinanceSymbol,
        marketSymbol: ticker.marketSymbol,
        previousReleaseDate: recorded,
        newReleaseDate: lastEarn,
        suggestedPeriod,
        previousReport: ticker.lastReportFile,
        suggestedCommand: `/haitu ${ticker.ticker}`
      });
      logger.warn(
        `🚨 ${ticker.ticker} 发布了新财报：${recorded} → ${lastEarn}（建议重新分析为 ${suggestedPeriod}）`
      );
    }
  }

  return pending;
}

/**
 * 简单的下一期推断（仅启发式，海图分析时会确认）
 */
function guessNextPeriod(prev) {
  if (!prev) return '最新季度';
  // "Q3 FY2026" → "Q4 FY2026"
  const m1 = prev.match(/^Q(\d) FY(\d{4})$/);
  if (m1) {
    const q = parseInt(m1[1]);
    const fy = parseInt(m1[2]);
    return q < 4 ? `Q${q + 1} FY${fy}` : `Q1 FY${fy + 1}`;
  }
  // "Q4 2025" → "Q1 2026"
  const m2 = prev.match(/^Q(\d) (\d{4})$/);
  if (m2) {
    const q = parseInt(m2[1]);
    const y = parseInt(m2[2]);
    return q < 4 ? `Q${q + 1} ${y}` : `Q1 ${y + 1}`;
  }
  return '最新季度';
}
