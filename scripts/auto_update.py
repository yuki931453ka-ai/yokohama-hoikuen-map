"""
auto_update.py
横浜市オープンデータから最新の保育所入所状況CSVを取得し、
アプリ用JSONに変換して data/monthly/ に追加するスクリプト。

GitHub Actions から毎月自動実行される想定。
手動実行も可能: python scripts/auto_update.py [--year 2026] [--month 7]

【データソース】
  横浜市オープンデータ（CC BY 4.0）
  3種のCSV: 入所児童数 / 受入可能数 / 入所待ち人数

【処理フロー】
  1. CKAN API または直接URLからCSVをダウンロード
  2. CSVを解析して月次JSONに変換
  3. data/monthly/{label}.json に保存
  4. data/months.json を更新
"""

import csv
import io
import json
import os
import sys
from datetime import datetime, date
from typing import Optional

try:
    import requests
except ImportError:
    print("[ERROR] pip install requests を実行してください")
    sys.exit(1)

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MONTHLY_DIR = os.path.join(BASE_DIR, "data", "monthly")
MONTHS_JSON = os.path.join(BASE_DIR, "data", "months.json")

AGE_COLS_CSV = ["０歳児", "１歳児", "２歳児", "３歳児", "４歳児", "５歳児"]
AGE_KEYS_APP = ["０歳",   "１歳",   "２歳",   "３歳",   "４歳",   "５歳"]

CKAN_PACKAGE_URL = "https://data.city.yokohama.lg.jp/api/3/action/package_show"
CKAN_PACKAGE_ID  = "kodomo_nyusho-jokyo"

CSV_BASE_URLS = [
    "https://www.city.yokohama.lg.jp/kosodate-kyoiku/hoiku-yoji/shisetsu/riyou/info/nyusho-jokyo.files",
    "https://www.city.yokohama.lg.jp/kurashi/kosodate-kyoiku/hoiku-yoji/shisetsu/info/nyusho.files",
]

CSV_CODE_SETS = [
    {"enrolled": "1007", "capacity": "1000", "waiting": "1001"},
    {"enrolled": "0923", "capacity": "0926", "waiting": "0929"},
]

DATA_TYPES = {
    "enrolled": "入所児童数",
    "capacity": "受入可能数",
    "waiting":  "入所待ち人数",
}


def to_reiwa(western_year: int) -> int:
    return western_year - 2018


def make_month_key(reiwa_year: int, month: int) -> str:
    return f"r{reiwa_year}_{month:02d}"


def make_month_label(reiwa_year: int, month: int) -> str:
    return f"令和{reiwa_year}年{month}月"


def safe_int(val: str) -> int:
    try:
        v = str(val).strip().replace(",", "")
        if v in ("", "-", "－", "―", "None"):
            return 0
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def try_download_csv(url: str) -> Optional[str]:
    try:
        resp = requests.get(url, timeout=30)
        if resp.status_code == 200 and len(resp.content) > 100:
            for enc in ["shift-jis", "cp932", "utf-8-sig", "utf-8"]:
                try:
                    text = resp.content.decode(enc)
                    if "施設番号" in text or "施設所在区" in text:
                        return text
                except UnicodeDecodeError:
                    continue
    except requests.RequestException as e:
        print(f"  [WARN] {url[:80]}... → {e}")
    return None


def try_ckan_api(target_year: int, target_month: int) -> dict[str, str]:
    """CKAN APIからCSVのURLを取得"""
    print("[1] CKAN APIでCSV URLを検索中...")
    try:
        resp = requests.get(
            CKAN_PACKAGE_URL,
            params={"id": CKAN_PACKAGE_ID},
            timeout=15,
        )
        if resp.status_code != 200:
            print(f"  [WARN] CKAN API応答: {resp.status_code}")
            return {}

        data = resp.json()
        resources = data.get("result", {}).get("resources", [])

        found = {}
        for res in resources:
            name = res.get("name", "") + res.get("description", "")
            url  = res.get("url", "")
            if not url.endswith(".csv"):
                continue

            for dtype, jp_name in DATA_TYPES.items():
                if jp_name in name and dtype not in found:
                    found[dtype] = url

        if len(found) == 3:
            print(f"  [OK] CKAN APIから3種のCSV URLを取得")
            for dtype, url in found.items():
                print(f"    {DATA_TYPES[dtype]}: {url[:80]}...")
            return found

        print(f"  [WARN] CKAN APIから{len(found)}/3種のみ取得")
    except Exception as e:
        print(f"  [WARN] CKAN API失敗: {e}")

    return {}


def try_direct_urls(target_year: int, target_month: int) -> dict[str, str]:
    """日付ベースのURLパターンでCSVを探す"""
    print("[2] 直接URLパターンでCSVを検索中...")

    date_patterns = [
        f"{target_year}{target_month:02d}01",
        f"{target_year}{target_month:02d}02",
    ]

    for base_url in CSV_BASE_URLS:
        for codes in CSV_CODE_SETS:
            for date_str in date_patterns:
                found = {}
                for dtype, code in codes.items():
                    url = f"{base_url}/{code}_{date_str}.csv"
                    text = try_download_csv(url)
                    if text:
                        found[dtype] = url
                        print(f"    [HIT] {DATA_TYPES[dtype]}: {url}")

                if len(found) == 3:
                    print(f"  [OK] 3種のCSV URLを発見（{base_url}, codes={list(codes.values())}, date={date_str}）")
                    return found

    return {}


def download_csvs(urls: dict[str, str]) -> dict[str, list[dict]]:
    """CSVをダウンロードして行データに変換"""
    result = {}
    for dtype, url in urls.items():
        text = try_download_csv(url)
        if not text:
            print(f"  [ERROR] {DATA_TYPES[dtype]}のダウンロードに失敗: {url}")
            continue

        reader = csv.reader(io.StringIO(text))
        next(reader)  # タイトル行スキップ
        header = next(reader)
        rows = []
        for row in reader:
            if len(row) < len(header):
                row += [""] * (len(header) - len(row))
            rows.append(dict(zip(header, row)))

        result[dtype] = rows
        print(f"  [OK] {DATA_TYPES[dtype]}: {len(rows)} 施設")

    return result


def build_age_map(rows: list[dict]) -> dict[str, dict]:
    result = {}
    for row in rows:
        key = str(row.get("施設番号", "")).strip()
        if not key:
            continue
        ages = {}
        for csv_col, app_key in zip(AGE_COLS_CSV, AGE_KEYS_APP):
            ages[app_key] = safe_int(row.get(csv_col, 0))
        result[key] = ages
    return result


def convert_to_monthly_json(
    csv_data: dict[str, list[dict]],
    reiwa_year: int,
    month: int,
) -> dict:
    enrolled_rows = csv_data.get("enrolled", [])
    capacity_rows = csv_data.get("capacity", [])
    waiting_rows  = csv_data.get("waiting", [])

    capacity_map = build_age_map(capacity_rows)
    waiting_map  = build_age_map(waiting_rows)

    empty_ages = {k: 0 for k in AGE_KEYS_APP}
    facilities = {}

    for row in enrolled_rows:
        key  = str(row.get("施設番号", "")).strip()
        name = str(row.get("施設・事業名", "")).strip()
        ward = str(row.get("施設所在区", "")).strip()
        if not key:
            continue

        enrolled_ages = {}
        for csv_col, app_key in zip(AGE_COLS_CSV, AGE_KEYS_APP):
            enrolled_ages[app_key] = safe_int(row.get(csv_col, 0))

        facilities[key] = {
            "id":       key,
            "name":     name,
            "ward":     ward,
            "enrolled": enrolled_ages,
            "capacity": capacity_map.get(key, dict(empty_ages)),
            "waiting":  waiting_map.get(key, dict(empty_ages)),
        }

    # capacity/waiting にあって enrolled にない施設も追加
    for key in set(capacity_map) | set(waiting_map):
        if key in facilities:
            continue
        c_row = next((r for r in capacity_rows if str(r.get("施設番号", "")).strip() == key), {})
        w_row = next((r for r in waiting_rows if str(r.get("施設番号", "")).strip() == key), {})
        name = str(c_row.get("施設・事業名", "") or w_row.get("施設・事業名", "")).strip()
        ward = str(c_row.get("施設所在区", "") or w_row.get("施設所在区", "")).strip()
        facilities[key] = {
            "id":       key,
            "name":     name,
            "ward":     ward,
            "enrolled": dict(empty_ages),
            "capacity": capacity_map.get(key, dict(empty_ages)),
            "waiting":  waiting_map.get(key, dict(empty_ages)),
        }

    label = make_month_key(reiwa_year, month)
    return {
        "year":         f"令和{reiwa_year}年",
        "month":        f"{month}月",
        "label":        label,
        "displayLabel": make_month_label(reiwa_year, month),
        "facilities":   facilities,
    }


def update_months_json(reiwa_year: int, month: int) -> bool:
    """data/months.json に新しい月を追加。既に存在すれば更新しない。"""
    key   = make_month_key(reiwa_year, month)
    label = make_month_label(reiwa_year, month)
    entry = {
        "key":   key,
        "label": label,
        "file":  f"data/monthly/{key}.json",
    }

    if os.path.exists(MONTHS_JSON):
        with open(MONTHS_JSON, encoding="utf-8") as f:
            months = json.load(f)
    else:
        months = []

    existing_keys = {m["key"] for m in months}
    if key in existing_keys:
        print(f"  [SKIP] {label} は既に months.json に存在")
        return False

    months.append(entry)
    months.sort(key=lambda m: m["key"])

    with open(MONTHS_JSON, "w", encoding="utf-8") as f:
        json.dump(months, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"  [OK] months.json に {label} を追加（合計 {len(months)} ヶ月）")
    return True


def main():
    import argparse
    parser = argparse.ArgumentParser(description="横浜市保育所データ自動更新")
    parser.add_argument("--year",  type=int, help="西暦年（デフォルト: 今月）")
    parser.add_argument("--month", type=int, help="月（デフォルト: 今月）")
    parser.add_argument("--dry-run", action="store_true", help="ダウンロードのみ、ファイル書き込みなし")
    args = parser.parse_args()

    today = date.today()
    target_year  = args.year  or today.year
    target_month = args.month or today.month
    reiwa_year   = to_reiwa(target_year)

    label     = make_month_label(reiwa_year, target_month)
    month_key = make_month_key(reiwa_year, target_month)
    out_path  = os.path.join(MONTHLY_DIR, f"{month_key}.json")

    print(f"=== 横浜市保育所データ自動更新 ===")
    print(f"対象: {label}（{target_year}年{target_month}月）")
    print(f"出力: {out_path}")
    print()

    # 既に存在する場合はスキップ
    if os.path.exists(out_path) and not args.dry_run:
        print(f"[SKIP] {out_path} は既に存在します。上書きするには削除してから再実行してください。")
        sys.exit(0)

    # CSVのURLを取得（CKAN API → 直接URL の順で試行）
    csv_urls = try_ckan_api(target_year, target_month)
    if len(csv_urls) < 3:
        csv_urls = try_direct_urls(target_year, target_month)

    if len(csv_urls) < 3:
        missing = [DATA_TYPES[d] for d in DATA_TYPES if d not in csv_urls]
        print(f"\n[ERROR] 必要なCSVが見つかりませんでした: {', '.join(missing)}")
        print("横浜市がまだ今月のデータを公開していない可能性があります。")
        print("手動確認: https://www.city.yokohama.lg.jp/kurashi/kosodate-kyoiku/hoiku-yoji/shisetsu/info/")
        sys.exit(1)

    # ダウンロード
    print(f"\n[3] CSVダウンロード中...")
    csv_data = download_csvs(csv_urls)

    if "enrolled" not in csv_data:
        print("[ERROR] 入所児童数CSVの取得に失敗しました")
        sys.exit(1)

    # JSON変換
    print(f"\n[4] JSON変換中...")
    monthly_json = convert_to_monthly_json(csv_data, reiwa_year, target_month)
    n_facilities = len(monthly_json["facilities"])
    print(f"  → {n_facilities} 施設")

    if n_facilities < 100:
        print(f"[WARN] 施設数が少なすぎます（{n_facilities}件）。データに問題がある可能性があります。")

    if args.dry_run:
        print(f"\n[DRY-RUN] ファイル書き込みをスキップ")
        print(f"  施設数: {n_facilities}")
        sample_id = next(iter(monthly_json["facilities"]))
        print(f"  サンプル: {json.dumps(monthly_json['facilities'][sample_id], ensure_ascii=False, indent=2)}")
        sys.exit(0)

    # 保存
    os.makedirs(MONTHLY_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(monthly_json, f, ensure_ascii=False, indent=2)
    print(f"  [OK] {out_path} を保存")

    # months.json 更新
    print(f"\n[5] months.json 更新中...")
    update_months_json(reiwa_year, target_month)

    print(f"\n=== 完了: {label} のデータを追加しました（{n_facilities} 施設） ===")


if __name__ == "__main__":
    main()
