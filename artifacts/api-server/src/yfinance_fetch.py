#!/usr/bin/env python3
"""
Fetch OHLCV candles from Yahoo Finance and print a JSON array to stdout.
Usage: python3 yfinance_fetch.py <symbol> <interval> <period>

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
    # Map our 4h pseudo-interval to real yfinance params
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
        # ts may be tz-aware; convert to UTC Unix seconds
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

        bars.append({"time": epoch, "open": o, "high": h, "low": l, "close": c, "volume": v})

    return bars


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: yfinance_fetch.py <symbol> <interval> <period>"}))
        sys.exit(1)

    symbol   = sys.argv[1].upper()
    interval = sys.argv[2]   # e.g. 5m, 1h, 4h, 1d, 1wk, 1mo
    period   = sys.argv[3]   # e.g. 7d, 60d, max

    bars = fetch(symbol, interval, period)
    print(json.dumps(bars))


if __name__ == "__main__":
    main()
