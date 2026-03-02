"""
prepare_r8.py
令和8年2月の入所状況CSV3種を統合してJSONを生成するスクリプト

CSV構造（実際の横浜市オープンデータ形式）:
  1行目: タイトル行（スキップ）
  2行目: ヘッダー
    - 施設所在区, 標準地域コード, 施設・事業名, 施設番号,
      ０歳児, １歳児, ２歳児, ３歳児, ４歳児, ５歳児, 合計, 更新日
"""

import csv
import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR  = os.path.join(BASE_DIR, "raw_data")
DATA_DIR = os.path.join(BASE_DIR, "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "r8_202602.json")

# 年齢列名（CSV内の実際の列名）
AGE_COLS_CSV  = ["０歳児", "１歳児", "２歳児", "３歳児", "４歳児", "５歳児"]
# アプリ内で使う年齢キー名
AGE_KEYS_APP  = ["０歳", "１歳", "２歳", "３歳", "４歳", "５歳"]

def safe_int(val):
    try:
        v = str(val).strip().replace(",", "")
        if v in ("", "-", "－", "―"):
            return 0
        return int(float(v))
    except (ValueError, TypeError):
        return 0

def load_csv(filename):
    """CSVを読み込む（1行目タイトルをスキップ、2行目をヘッダーとして使用）"""
    path = os.path.join(RAW_DIR, filename)
    if not os.path.exists(path):
        print(f"[WARN] ファイルなし: {path}")
        return []

    for enc in ["shift-jis", "cp932", "utf-8-sig", "utf-8"]:
        try:
            with open(path, encoding=enc, newline="") as f:
                reader = csv.reader(f)
                next(reader)  # 1行目（タイトル行）スキップ
                header = next(reader)  # 2行目がヘッダー
                rows = []
                for row in reader:
                    if len(row) >= len(header):
                        rows.append(dict(zip(header, row)))
                    else:
                        # 列数不足の行は末尾を空文字で補完
                        padded = row + [""] * (len(header) - len(row))
                        rows.append(dict(zip(header, padded)))
            print(f"[OK] {filename} ({enc}) {len(rows)} 施設")
            return rows
        except (UnicodeDecodeError, StopIteration):
            continue

    print(f"[ERROR] {filename} の読み込み失敗")
    return []

def build_age_map(rows):
    """施設番号 → 年齢別数値の辞書を返す"""
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

def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    print("=== 令和8年2月データ変換 ===")

    enrolled_rows = load_csv("0923_20260202.csv")
    capacity_rows = load_csv("0926_20260202.csv")
    waiting_rows  = load_csv("0929_20260202.csv")

    if not enrolled_rows:
        print("[ERROR] 入所児童数CSVが読み込めません")
        sys.exit(1)

    capacity_map = build_age_map(capacity_rows)
    waiting_map  = build_age_map(waiting_rows)

    result = {}
    for row in enrolled_rows:
        key  = str(row.get("施設番号", "")).strip()
        name = str(row.get("施設・事業名", "")).strip()
        ward = str(row.get("施設所在区", "")).strip()
        if not key:
            continue

        enrolled_ages = {}
        for csv_col, app_key in zip(AGE_COLS_CSV, AGE_KEYS_APP):
            enrolled_ages[app_key] = safe_int(row.get(csv_col, 0))

        result[key] = {
            "id":       key,
            "name":     name,
            "ward":     ward,
            "enrolled": enrolled_ages,
            "capacity": capacity_map.get(key, {k: 0 for k in AGE_KEYS_APP}),
            "waiting":  waiting_map.get(key,  {k: 0 for k in AGE_KEYS_APP}),
        }

    output = {
        "year":  "令和8年",
        "month": "2月",
        "label": "R8_202602",
        "facilities": result
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"[完了] {OUTPUT_PATH} → {len(result)} 施設")

if __name__ == "__main__":
    main()
