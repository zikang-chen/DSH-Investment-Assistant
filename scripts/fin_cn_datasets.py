#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
CN free dataset bridge for DSH 投资助手.

Why a Python bridge: AKShare/BaoStock are Python-only. This keeps the TypeScript
plugin unchanged in shape — the plugin spawns this script and receives JSON.

Contract:
  python fin_cn_datasets.py --list
  python fin_cn_datasets.py --dataset CN_MACRO_CPI --limit 12
  python fin_cn_datasets.py --dataset CN_A_SHARE_DAILY --params '{"symbol":"600519","start_date":"2026-11-01","end_date":"2026-11-17"}'

Output (single line JSON, UTF-8):
  { ok, dataset, provider, source, source_url, fetched_at, as_of, unit, fields,
    rows: [...], row_count, truncated, error?, warnings?[] }

Rules:
  * Missing values stay null. Never coerce NaN/None to 0.
  * Dates are normalised to YYYY-MM-DD (or original period string when monthly text).
  * `as_of` is the latest statistical period found in the data, never the fetch time.
  * Unimplemented / unavailable datasets return ok=false with a clear error.
  * Research-use limits: AKShare is for research; no redistribution of raw data.
"""
import argparse
import datetime as _dt
import json
import math
import sys
import traceback

UTC = _dt.timezone.utc


def now_iso():
    return _dt.datetime.now(UTC).isoformat(timespec="seconds")


def clean(value):
    """JSON-safe scalar: NaN/inf/None -> None (missing), Timestamp/date -> ISO date."""
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (int, bool)):
        return value
    if isinstance(value, float):
        return value
    s = str(value)
    if s.strip().lower() in ("nan", "none", "nat", ""):
        return None
    return s


def records(df):
    out = []
    cols = [str(c) for c in df.columns]
    for _, row in df.iterrows():
        out.append({cols[i]: clean(row.iloc[i]) for i in range(len(cols))})
    return cols, out


import re as _re


def period_key(value):
    """Rough chronological key from a period label (2026年10月份 / 202610 / 2026-10-01 / 202604)."""
    if value is None:
        return (0, 0, 0)
    s = str(value)
    nums = _re.findall(r"\d+", s)
    if not nums:
        return (0, 0, 0)
    year = int(nums[0]) if len(nums[0]) == 4 else 0
    month = 0
    if len(nums) > 1:
        month = int(nums[1])
    elif len(nums[0]) == 6:  # 202604
        year, month = int(nums[0][:4]), int(nums[0][4:])
    elif len(nums[0]) == 8:  # 20260430
        year, month = int(nums[0][:4]), int(nums[0][4:6])
    return (year, month, len(nums))


# ---------------------------------------------------------------- registry
# access_type: official-api | official-download | public-web | manual
# cost_class: free | free-with-account | paid
def _ak():
    import akshare as ak  # imported lazily so --list works without deps
    return ak


def _call(fn_name, params):
    ak = _ak()
    fn = getattr(ak, fn_name)
    return fn(**params)


def _daily(symbol, start_date, end_date, adjust=""):
    return _call("stock_zh_a_hist_em", {
        "symbol": symbol, "period": "daily",
        "start_date": start_date.replace("-", ""), "end_date": end_date.replace("-", ""),
        "adjust": adjust,
    })


DATASETS = {
    # --- 宏观（东财口径）---
    "CN_MACRO_GDP": dict(provider="akshare", fn="macro_china_gdp", source="东方财富-中国GDP",
                         url="https://data.eastmoney.com/cjsj/gdp.html", unit="亿元/%、累计同比",
                         period_field="季度", params=[], frequency="quarterly"),
    "CN_MACRO_CPI": dict(provider="akshare", fn="macro_china_cpi", source="东方财富-中国CPI",
                         url="https://data.eastmoney.com/cjsj/cpi.html", unit="指数(上年=100)/同比%、环比%",
                         period_field="月份", params=[], frequency="monthly"),
    "CN_MACRO_PPI": dict(provider="akshare", fn="macro_china_ppi", source="东方财富-中国PPI",
                         url="https://data.eastmoney.com/cjsj/ppi.html", unit="指数(上年=100)/同比%",
                         period_field="月份", params=[], frequency="monthly"),
    "CN_MACRO_PMI": dict(provider="akshare", fn="macro_china_pmi", source="东方财富-中国PMI",
                         url="https://data.eastmoney.com/cjsj/pmi.html", unit="指数(50=荣枯线)",
                         period_field="月份", params=[], frequency="monthly"),
    "CN_MONEY_M1_M2": dict(provider="akshare", fn="macro_china_money_supply_em", source="东方财富-货币供应量",
                           url="https://data.eastmoney.com/cjsj/hbgyl.html", unit="亿元/同比%、环比%",
                           period_field="月份", params=[], frequency="monthly"),
    "CN_CREDIT_TSFIN_FLOW": dict(provider="akshare", fn="macro_china_social_financing", source="商务数据中心-社会融资规模增量",
                                 url="https://data.eastmoney.com/cjsj/shrzgm.html", unit="亿元（增量，非存量）",
                                 period_field="月份", params=[], frequency="monthly"),
    "CN_FISCAL_REVENUE": dict(provider="akshare", fn="macro_china_fiscal_revenue", source="东方财富-财政收入",
                              url="https://data.eastmoney.com/cjsj/czsr.html", unit="亿元/同比%、累计",
                              period_field="月份", params=[], frequency="monthly"),
    "CN_INDUSTRIAL_PRODUCTION": dict(provider="akshare", fn="macro_china_industrial_value_added",
                                     source="东方财富-工业增加值", url="https://data.eastmoney.com/cjsj/gyzjz.html",
                                     unit="同比%、累计同比%", period_field="月份", params=[], frequency="monthly"),
    "CN_REAL_ESTATE": dict(provider="akshare", fn="macro_china_real_estate", source="东方财富-国房景气指数",
                           url="https://data.eastmoney.com/cjsj/fangjia.html", unit="指数/涨跌幅%",
                           period_field="日期", params=[], frequency="monthly"),
    "CN_IMPORT_EXPORT": dict(provider="akshare", fn="macro_china_customs_trade", source="东方财富-海关进出口",
                             url="https://data.eastmoney.com/cjsj/jinchukou.html", unit="美元/同比%、累计",
                             period_field="月份", params=[], frequency="monthly"),
    "CN_ELECTRICITY_CONSUMPTION": dict(provider="akshare", fn="macro_china_society_electricity",
                                       source="新浪-全社会用电分类", url="https://data.eastmoney.com/cjsj/gdysj.html",
                                       unit="万千瓦时/同比%", period_field="统计时间", params=[], frequency="monthly"),
    # --- 市场 ---
    "CN_A_SHARE_DAILY": dict(provider="akshare", fn="stock_zh_a_hist_em", source="东方财富-A股日线",
                             url="https://quote.eastmoney.com/", unit="元/股、手、元、%",
                             period_field="日期", required=["symbol"], frequency="daily",
                             params=[{"name": "symbol", "default": "600519"},
                                     {"name": "start_date", "default": "20260101"},
                                     {"name": "end_date", "default": "20500101"},
                                     {"name": "adjust", "default": ""}]),
    "CN_A_SHARE_FINANCIALS": dict(provider="akshare", fn="stock_financial_analysis_indicator",
                                  source="新浪-财务指标", url="https://money.finance.sina.com.cn/",
                                  unit="按列名标注（元/%/倍）", period_field="日期", required=["symbol"],
                                  frequency="quarterly",
                                  params=[{"name": "symbol", "default": "600519"},
                                          {"name": "start_year", "default": "2024"}]),
    "CN_ETF_DAILY": dict(provider="akshare", fn="fund_etf_hist_em", source="东方财富-ETF日线",
                         url="https://quote.eastmoney.com/", unit="元/份、手、元、%",
                         period_field="日期", required=["symbol"], frequency="daily",
                         params=[{"name": "symbol", "default": "510300"},
                                 {"name": "start_date", "default": "20260101"},
                                 {"name": "end_date", "default": "20500101"},
                                 {"name": "adjust", "default": ""}]),
    "CN_FUND_NAV": dict(provider="akshare", fn="fund_open_fund_info_em", source="东方财富-基金净值",
                        url="https://fund.eastmoney.com/", unit="元/份、%", period_field="净值日期",
                        required=["symbol"], frequency="daily",
                        params=[{"name": "symbol", "default": "110022"},
                                {"name": "indicator", "default": "单位净值走势"}]),
    "CN_INDEX_DAILY": dict(provider="akshare", fn="index_zh_hist_em", source="东方财富-指数日线",
                           url="https://quote.eastmoney.com/", unit="点、手、元、%",
                           period_field="日期", required=["symbol"], frequency="daily",
                           params=[{"name": "symbol", "default": "000300"},
                                   {"name": "start_date", "default": "20260101"},
                                   {"name": "end_date", "default": "20500101"}]),
    "CN_BOND_YIELD": dict(provider="akshare", fn="bond_china_yield", source="中国债券信息网-收益率曲线",
                          url="https://yield.chinabond.com.cn/", unit="%",
                          period_field="日期", frequency="daily",
                          params=[{"name": "start_date", "default": "20260101"},
                                  {"name": "end_date", "default": "20260110"}]),
    "CN_CORPORATE_ANNOUNCEMENTS": dict(provider=None, available=False,
                                       reason="AKShare 公告接口在本机 SSL 失败；请用现有东财公告能力 get_notice_list / stock_dossier 的 announcements（已实测可用）"),
    "CN_INDUSTRY_SECTOR": dict(provider="akshare", fn="stock_board_industry_name_em", source="东方财富-行业板块",
                               url="https://quote.eastmoney.com/center/boardlist.html", unit="元、%、家",
                               period_field="—", params=[], frequency="snapshot"),
    # --- 明确未实现（保留定义，不填假数据）---
    "CN_CREDIT_TSFIN_STOCK": dict(provider=None, available=False,
                                  reason="AKShare 仅提供社融增量，存量口径未找到稳定免费接口"),
    "CN_FISCAL_EXPENDITURE": dict(provider=None, available=False,
                                  reason="AKShare 仅提供财政收入；支出可经财政部公开报告人工/Evidence 补充"),
    "CN_GOVERNMENT_BONDS": dict(provider=None, available=False, reason="尚未核实稳定的免费国债发行接口"),
    "CN_A_SHARE_VALUATION": dict(provider=None, available=False, reason="请用现有 stock_dossier 的估值分位（东财 F10）"),
    "CN_FUND_HOLDINGS": dict(provider=None, available=False, reason="请用现有 fund_dossier；场外完整持仓需定期报告"),
    "CN_INDEX_COMPONENTS": dict(provider=None, available=False, reason="尚未核实稳定成分股接口"),
    "CN_MARKET_TURNOVER": dict(provider=None, available=False, reason="可由现有行情/板块数据派生，待实现"),
    "CN_INDUSTRY_ELECTRONICS": dict(provider=None, available=False, reason="行业细分需东财板块成分+财务聚合，待实现"),
    "CN_INDUSTRY_AUTOMOTIVE": dict(provider=None, available=False, reason="同上"),
    "CN_INDUSTRY_SOFTWARE": dict(provider=None, available=False, reason="同上"),
}


def dataset_meta(ds_id):
    spec = DATASETS.get(ds_id)
    if not spec:
        return None
    return {
        "dataset": ds_id,
        "provider": spec.get("provider"),
        "available": spec.get("available", True),
        "source": spec.get("source"),
        "source_url": spec.get("url"),
        "unit": spec.get("unit"),
        "frequency": spec.get("frequency"),
        "period_field": spec.get("period_field"),
        "params": spec.get("params", []),
        "reason": spec.get("reason"),
    }


def run_dataset(ds_id, params, limit):
    meta = dataset_meta(ds_id)
    if meta is None:
        return {"ok": False, "dataset": ds_id, "error": f"未知数据集 {ds_id}；可用：{','.join(sorted(DATASETS))}"}
    if not meta["available"]:
        return {"ok": False, "dataset": ds_id, "provider": None,
                "error": f"该数据集尚未接入：{meta.get('reason') or '无可用免费来源'}", "warnings": []}

    spec = DATASETS[ds_id]
    fn_name = spec["fn"]
    merged = {}
    for p in spec.get("params", []):
        merged[p["name"]] = p.get("default")
    # Dynamic date defaults so commands don't silently query an old window.
    if ds_id == "CN_BOND_YIELD":
        today = _dt.date.today()
        if not (params or {}).get("start_date"):
            merged["start_date"] = (today - _dt.timedelta(days=30)).strftime("%Y%m%d")
        if not (params or {}).get("end_date"):
            merged["end_date"] = today.strftime("%Y%m%d")
    for k, v in (params or {}).items():
        merged[k] = v
    for k in merged:
        if isinstance(merged[k], str) and merged[k].isdigit():
            pass  # keep numeric-looking strings (dates/years)
    missing = [r for r in spec.get("required", []) if not str(merged.get(r, "")).strip()]
    if missing:
        return {"ok": False, "dataset": ds_id, "error": f"缺少必填参数：{','.join(missing)}"}

    try:
        if ds_id == "CN_A_SHARE_DAILY":
            df = _daily(merged["symbol"], str(merged["start_date"]), str(merged["end_date"]), str(merged.get("adjust", "")))
        elif ds_id == "CN_ETF_DAILY":
            df = _call("fund_etf_hist_em", {
                "symbol": merged["symbol"], "period": "daily",
                "start_date": str(merged["start_date"]).replace("-", ""),
                "end_date": str(merged["end_date"]).replace("-", ""),
                "adjust": str(merged.get("adjust", "")),
            })
        elif ds_id == "CN_INDEX_DAILY":
            try:
                df = _call("index_zh_hist_em", {
                    "symbol": merged["symbol"], "period": "daily",
                    "start_date": str(merged["start_date"]).replace("-", ""),
                    "end_date": str(merged["end_date"]).replace("-", ""),
                })
            except Exception:
                df = _call("index_zh_daily_sina", {"symbol": "sh" + str(merged["symbol"])})
        else:
            df = _call(fn_name, merged)
    except Exception as exc:  # noqa: BLE001 - report real error, do not fake data
        return {"ok": False, "dataset": ds_id, "provider": spec.get("provider"),
                "error": f"{type(exc).__name__}: {str(exc)[:300]}",
                "warnings": ["上游接口可能改名/限流，详见 /api/interfaces 或 AKShare 文档"]}

    if df is None:
        return {"ok": False, "dataset": ds_id, "error": "接口返回空对象"}
    cols, rows = records(df)
    if not rows:
        return {"ok": True, "dataset": ds_id, "provider": spec.get("provider"), "source": spec.get("source"),
                "source_url": spec.get("url"), "fetched_at": now_iso(), "as_of": None,
                "unit": spec.get("unit"), "fields": cols, "rows": [], "row_count": 0,
                "truncated": False, "warnings": ["上游返回空表"]}

    # Normalise chronological order ascending (some sources return newest-first),
    # so `as_of` and `limit` always refer to the most recent periods.
    period_field = spec.get("period_field")
    if period_field and period_field in cols:
        rows.sort(key=lambda r: period_key(r.get(period_field)))
    as_of = None
    if period_field and period_field in cols:
        for row in reversed(rows):
            val = row.get(period_field)
            if val:
                as_of = str(val)
                break
    truncated = False
    if limit and len(rows) > limit:
        rows = rows[-limit:]
        truncated = True
    return {
        "ok": True, "dataset": ds_id, "provider": spec.get("provider"),
        "source": spec.get("source"), "source_url": spec.get("url"),
        "fetched_at": now_iso(), "as_of": as_of, "unit": spec.get("unit"),
        "period_field": period_field, "fields": cols, "rows": rows,
        "row_count": len(rows), "truncated": truncated, "warnings": [],
        "revision_note": "本接口只返回最新一版；历史修订版本需另行存档比较",
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dataset")
    ap.add_argument("--params", default="{}")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    if args.list:
        print(json.dumps({"ok": True, "datasets": [dataset_meta(k) for k in DATASETS]}, ensure_ascii=False))
        return 0
    if not args.dataset:
        print(json.dumps({"ok": False, "error": "需要 --dataset 或 --list"}, ensure_ascii=False))
        return 2
    try:
        params = json.loads(args.params or "{}")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"params 不是合法 JSON: {exc}"}, ensure_ascii=False))
        return 2
    try:
        result = run_dataset(args.dataset, params, args.limit)
    except Exception:  # noqa: BLE001 - last-resort guard
        result = {"ok": False, "dataset": args.dataset, "error": traceback.format_exc(limit=2)[:500]}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
