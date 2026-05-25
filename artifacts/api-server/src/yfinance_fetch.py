#!/usr/bin/env python3
"""
Fetch OHLCV candles from Yahoo Finance and print a JSON array to stdout.

Usage:
  python3 yfinance_fetch.py <symbol> <interval> <period>   — historical bars
  python3 yfinance_fetch.py <symbol> live                  — live price + market status

interval: 1m | 5m | 15m | 30m | 60m | 1h | 4h | 1d | 1wk | 1mo
period:   7d | 60d | 730d | max

4h is not native to yfinance — we fetch 1h and resample.
"""

import sys
import json
import math

try:
    import yfinance as yf
    import pandas as pd
except ImportError as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)


def safe_float(v):
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    except Exception:
        return None


def resample_4h(df: "pd.DataFrame") -> "pd.DataFrame":
    """Resample 1h OHLCV data into 4h bars."""
    df = df.resample("4h", closed="left", label="left").agg({
        "Open":   "first",
        "High":   "max",
        "Low":    "min",
        "Close":  "last",
        "Volume": "sum",
    }).dropna(subset=["Open"])
    return df


def fetch(symbol: str, interval: str, period: str) -> list:
    yf_interval = interval
    resample = False
    if interval == "4h":
        yf_interval = "1h"
        resample = True

    ticker = yf.Ticker(symbol)
    df = ticker.history(interval=yf_interval, period=period, auto_adjust=True)

    if df is None or df.empty:
        return []

    if resample:
        df = resample_4h(df)

    bars = []
    for ts, row in df.iterrows():
        try:
            epoch = int(ts.timestamp())
        except Exception:
            continue

        o = safe_float(row.get("Open"))
        h = safe_float(row.get("High"))
        l = safe_float(row.get("Low"))
        c = safe_float(row.get("Close"))
        v = int(row.get("Volume", 0) or 0)

        if o is None or h is None or l is None or c is None:
            continue

        # Filter out bars with zero/near-zero prices (corrupted data)
        if c < 0.001 or o < 0.001:
            continue

        bars.append({"time": epoch, "open": o, "high": h, "low": l, "close": c, "volume": v})

    return bars


def is_nyse_open() -> bool:
    """Return True if NYSE is currently in regular trading hours (9:30–16:00 ET, Mon–Fri)."""
    try:
        import pytz
        from datetime import datetime, time as dtime
        et = pytz.timezone("America/New_York")
        now = datetime.now(et)
        if now.weekday() >= 5:          # Saturday=5, Sunday=6
            return False
        t = now.time()
        return dtime(9, 30) <= t < dtime(16, 0)
    except Exception:
        # Fallback: UTC-based approximation (EDT = UTC-4, ~13:30–20:00 UTC)
        import datetime as dt
        now_utc = dt.datetime.utcnow()
        if now_utc.weekday() >= 5:
            return False
        h, m = now_utc.hour, now_utc.minute
        total_min = h * 60 + m
        return (13 * 60 + 30) <= total_min < (20 * 60)


def get_live_price(symbol: str) -> dict:
    """
    Return the current market price for `symbol` along with:
      - isMarketOpen: whether NYSE regular session is active
      - lastClose:    previous session close
      - bar:          OHLCV snapshot for the current 5-minute interval
    """
    try:
        ticker = yf.Ticker(symbol)
        fi = ticker.fast_info

        price      = safe_float(fi.last_price)     or 0.0
        prev_close = safe_float(fi.previous_close) or 0.0
        day_high   = safe_float(fi.day_high)        or price
        day_low    = safe_float(fi.day_low)         or price
        day_open   = safe_float(fi.open)            or price
        volume     = int(fi.last_volume or fi.ten_day_average_volume or 1_000_000)

        open_now = is_nyse_open()

        import time as time_mod
        now_ts = int(time_mod.time())
        bar_ts = now_ts - (now_ts % 300)   # round down to 5-minute boundary

        current_price = price if price else prev_close

        return {
            "symbol":       symbol,
            "price":        current_price,
            "lastClose":    prev_close if prev_close else current_price,
            "isMarketOpen": open_now,
            "timestamp":    now_ts,
            "bar": {
                "time":   bar_ts,
                "open":   day_open  if day_open  else current_price,
                "high":   day_high  if day_high  else current_price,
                "low":    day_low   if day_low   else current_price,
                "close":  current_price,
                "volume": volume,
            },
        }
    except Exception as exc:
        import time as time_mod
        return {
            "symbol":       symbol,
            "price":        0.0,
            "lastClose":    0.0,
            "isMarketOpen": False,
            "timestamp":    int(time_mod.time()),
            "bar":          None,
            "error":        str(exc),
        }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: yfinance_fetch.py <symbol> <interval|live> [period]"}))
        sys.exit(1)

    symbol = sys.argv[1].upper()
    mode   = sys.argv[2]

    if mode == "live":
        print(json.dumps(get_live_price(symbol)))
        return

    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: yfinance_fetch.py <symbol> <interval> <period>"}))
        sys.exit(1)

    period = sys.argv[3]
    bars   = fetch(symbol, mode, period)
    print(json.dumps(bars))


if __name__ == "__main__":
    main()
