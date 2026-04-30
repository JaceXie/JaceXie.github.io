#!/usr/bin/env python3
"""
fetch_calendar_events.py

Input (CLI arg): yfinance ticker symbol (e.g. "MSFT", "0700.HK", "06690.HK")
Output (stdout): single-line JSON

{
  "ticker": "MSFT",
  "nextEarningsDate": "2026-07-30" | null,
  "lastEarningsDate": "2026-04-29" | null,
  "exDividendDate": "2026-06-09" | null,
  "dividendPaymentDate": "2026-06-16" | null,
  "dividendAmount": 0.22 | null,
  "currency": "USD" | null,
  "warnings": [] | ["..."]
}

Usage:
  python3 fetch_calendar_events.py MSFT
  python3 fetch_calendar_events.py 0700.HK
"""
import sys
import json
from datetime import datetime, date


def to_iso(value):
    """Convert various date formats to YYYY-MM-DD string, or None."""
    if value is None:
        return None
    if isinstance(value, str):
        # Already a string, try to normalize
        try:
            d = datetime.fromisoformat(value.split(' ')[0]).date()
            return d.isoformat()
        except Exception:
            return value[:10] if len(value) >= 10 else None
    if isinstance(value, (datetime, date)):
        if isinstance(value, datetime):
            value = value.date()
        return value.isoformat()
    # pandas Timestamp
    try:
        return value.date().isoformat() if hasattr(value, 'date') else str(value)[:10]
    except Exception:
        return None


def fetch(symbol):
    warnings = []
    result = {
        "ticker": symbol,
        "nextEarningsDate": None,
        "lastEarningsDate": None,
        "exDividendDate": None,
        "dividendPaymentDate": None,
        "dividendAmount": None,
        "currency": None,
        "warnings": warnings
    }

    try:
        import yfinance as yf
    except ImportError:
        print(json.dumps({**result, "warnings": ["yfinance not installed"]}, ensure_ascii=False))
        sys.exit(2)

    try:
        t = yf.Ticker(symbol)
    except Exception as e:
        warnings.append(f"yf.Ticker failed: {e}")
        print(json.dumps(result, ensure_ascii=False))
        return

    # ── currency ──
    try:
        info = t.info or {}
        result["currency"] = info.get("currency")
        if info.get("dividendRate"):
            result["dividendAmount"] = info.get("dividendRate")
    except Exception as e:
        warnings.append(f"info fetch failed: {e}")
        info = {}

    # ── earnings dates ──
    # yfinance 的 calendar 返回 dict 或 DataFrame，含 "Earnings Date"
    try:
        cal = t.calendar
        if cal is not None:
            # 新版本 yfinance 返回 dict
            if isinstance(cal, dict):
                ed = cal.get("Earnings Date")
                if isinstance(ed, list) and ed:
                    # 取第一个未来日期
                    today = date.today()
                    future = [to_iso(d) for d in ed if to_iso(d) and to_iso(d) >= today.isoformat()]
                    if future:
                        result["nextEarningsDate"] = future[0]
                elif ed:
                    result["nextEarningsDate"] = to_iso(ed)
            else:
                # 旧版本 DataFrame
                try:
                    if "Earnings Date" in cal.index:
                        ed = cal.loc["Earnings Date"][0]
                        result["nextEarningsDate"] = to_iso(ed)
                except Exception:
                    pass
    except Exception as e:
        warnings.append(f"calendar fetch failed: {e}")

    # ── lastEarningsDate: 用 earnings_dates DataFrame ──
    try:
        ed_df = t.earnings_dates
        if ed_df is not None and len(ed_df) > 0:
            today_str = date.today().isoformat()
            # 索引是日期，找最近的过去日期
            past_dates = []
            for idx in ed_df.index:
                iso = to_iso(idx)
                if iso and iso < today_str:
                    past_dates.append(iso)
            if past_dates:
                result["lastEarningsDate"] = max(past_dates)
            # 如果还没有 nextEarningsDate，从 earnings_dates 的未来记录补
            if not result["nextEarningsDate"]:
                future_dates = [
                    to_iso(idx) for idx in ed_df.index
                    if to_iso(idx) and to_iso(idx) >= today_str
                ]
                if future_dates:
                    result["nextEarningsDate"] = min(future_dates)
    except Exception as e:
        warnings.append(f"earnings_dates fetch failed: {e}")

    # ── dividend events ──
    try:
        # yfinance info 通常含 exDividendDate (epoch)
        if info.get("exDividendDate"):
            ts = info["exDividendDate"]
            if isinstance(ts, (int, float)):
                result["exDividendDate"] = to_iso(datetime.fromtimestamp(ts))
            else:
                result["exDividendDate"] = to_iso(ts)
    except Exception as e:
        warnings.append(f"exDividendDate parse failed: {e}")

    try:
        # 派息日 = info["dividendDate"]
        if info.get("dividendDate"):
            ts = info["dividendDate"]
            if isinstance(ts, (int, float)):
                result["dividendPaymentDate"] = to_iso(datetime.fromtimestamp(ts))
            else:
                result["dividendPaymentDate"] = to_iso(ts)
    except Exception as e:
        warnings.append(f"dividendDate parse failed: {e}")

    # ── HK 股票回退：用历史 dividends 推断 ──
    if symbol.endswith(".HK") and not result["exDividendDate"]:
        try:
            divs = t.dividends
            if divs is not None and len(divs) > 0:
                last_div_date = to_iso(divs.index[-1])
                if last_div_date:
                    warnings.append(f"HK fallback: 取最近一次实际派息日 {last_div_date} 作 exDividendDate（仅参考）")
                    # 这是历史数据，不写入主字段，但附带在 warnings 里
        except Exception as e:
            warnings.append(f"HK dividends fallback failed: {e}")

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: fetch_calendar_events.py <SYMBOL>"}, ensure_ascii=False))
        sys.exit(1)
    fetch(sys.argv[1])
