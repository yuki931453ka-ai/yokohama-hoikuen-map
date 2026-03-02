"""
geocode.py
認可保育所・小規模保育マスターCSVの住所を
国土地理院ジオコーディングAPIで緯度経度に変換し nurseries_geo.json を生成する

【CSVの実際の列名】
認可保育所（ninka-opendata.csv）:
  - 事業所番号   → 施設ID
  - 施設の名称   → 施設名
  - 施設の所在地 市区町村 → 市区町村（例: 横浜市港北区）
  - 施設の所在地 町名・番地 → 番地
  - 施設の連絡先 電話番号  → 電話番号
  - 施設類型     → 種別（保育所 等）

小規模保育（syoukibo-opendata.csv）: 同様の形式
"""

import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR     = os.path.join(BASE_DIR, "raw_data")
DATA_DIR    = os.path.join(BASE_DIR, "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "nurseries_geo.json")

GSI_API  = "https://msearch.gsi.go.jp/address-search/AddressSearch?q={}"
SLEEP_SEC = 0.3

TYPE_NINKA  = "認可保育所"
TYPE_SYOUKI = "小規模保育"

# 横浜市のみ対象（施設マスターには全国データが含まれるため）
TARGET_CITY = "横浜市"

def safe_str(val):
    return str(val).strip() if val else ""

def geocode(address):
    if not address:
        return None, None
    try:
        url = GSI_API.format(urllib.parse.quote(address))
        req = urllib.request.Request(url, headers={"User-Agent": "hoikuen-map/1.0"})
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode("utf-8"))
        if data:
            coords = data[0].get("geometry", {}).get("coordinates", [])
            if len(coords) >= 2:
                return float(coords[1]), float(coords[0])  # lat, lng
    except Exception as e:
        print(f"    [API ERROR] {address}: {e}")
    return None, None

def load_csv_file(filename, skip_first_row=False):
    path = os.path.join(RAW_DIR, filename)
    if not os.path.exists(path):
        print(f"[WARN] {filename} が見つかりません")
        return []
    for enc in ["shift-jis", "cp932", "utf-8-sig", "utf-8"]:
        try:
            rows = []
            with open(path, encoding=enc, newline="") as f:
                reader = csv.reader(f)
                if skip_first_row:
                    next(reader)
                header = next(reader)
                for row in reader:
                    padded = row + [""] * max(0, len(header) - len(row))
                    rows.append(dict(zip(header, padded)))
            print(f"[OK] {filename} ({enc}) {len(rows)} 行")
            return rows
        except (UnicodeDecodeError, StopIteration):
            continue
    print(f"[ERROR] {filename} 読み込み失敗")
    return []

def parse_ninka(rows):
    """認可保育所マスターを施設リストに変換（横浜市のみ）"""
    facilities = []
    for row in rows:
        # 横浜市のみ対象
        city = safe_str(row.get("施設の所在地 市区町村", ""))
        if TARGET_CITY not in city:
            continue

        fid  = safe_str(row.get("事業所番号", "")).rstrip()  # 末尾スペースあり
        name = safe_str(row.get("施設の名称", ""))
        if not name:
            continue

        # 区名を抽出（「横浜市港北区」→「港北区」）
        ward = city.replace("横浜市", "").strip()

        town = safe_str(row.get("施設の所在地 町名・番地", ""))
        address = city + town  # 例: 横浜市港北区綱島西６−２３−５６

        facilities.append({
            "id":         fid,
            "name":       name,
            "type":       TYPE_NINKA,
            "type_detail": safe_str(row.get("施設類型", "")),
            "ward":       ward,
            "address":    address,
            "tel":        safe_str(row.get("施設の連絡先 電話番号", "")),
            "lat":        None,
            "lng":        None,
        })
    return facilities

def parse_syoukibo(rows):
    """小規模保育マスターを施設リストに変換（横浜市のみ）"""
    facilities = []
    for row in rows:
        city = safe_str(row.get("施設の所在地 市区町村", ""))
        if TARGET_CITY not in city:
            continue

        fid  = safe_str(row.get("事業所番号", "")).rstrip()
        name = safe_str(row.get("施設の名称", ""))
        if not name:
            continue

        ward = city.replace("横浜市", "").strip()
        town = safe_str(row.get("施設の所在地 町名・番地", ""))
        address = city + town

        facilities.append({
            "id":         fid,
            "name":       name,
            "type":       TYPE_SYOUKI,
            "type_detail": safe_str(row.get("施設類型", "")),
            "ward":       ward,
            "address":    address,
            "tel":        safe_str(row.get("施設の連絡先 電話番号", "")),
            "lat":        None,
            "lng":        None,
        })
    return facilities

def load_existing():
    if not os.path.exists(OUTPUT_PATH):
        return {}
    with open(OUTPUT_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return {f["id"]: f for f in data.get("facilities", [])}

def save(facilities):
    output = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(facilities),
        "facilities": facilities
    }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    print("=== 施設マスター ジオコーディング ===")

    existing = load_existing()
    if existing:
        print(f"[Resume] 既存 {len(existing)} 施設をスキップ")

    ninka_rows   = load_csv_file("ninka-opendata.csv")
    syoukibo_rows = load_csv_file("syoukibo-opendata.csv")

    facilities = []
    facilities.extend(parse_ninka(ninka_rows))
    facilities.extend(parse_syoukibo(syoukibo_rows))

    if not facilities:
        print("[ERROR] 横浜市内の施設が見つかりません")
        sys.exit(1)

    total = len(facilities)
    print(f"\n横浜市内 {total} 施設のジオコーディングを開始")
    print(f"推定所要時間: {total * SLEEP_SEC / 60:.1f} 分\n")

    ok = skip = fail = 0

    for i, fac in enumerate(facilities):
        fid = fac["id"]
        ex = existing.get(fid)
        if ex and ex.get("lat") is not None:
            fac["lat"] = ex["lat"]
            fac["lng"] = ex["lng"]
            skip += 1
            continue

        addr = fac["address"]
        lat, lng = geocode(addr)
        fac["lat"] = lat
        fac["lng"] = lng

        status = "OK" if lat else "NG"
        print(f"  [{i+1}/{total}] {status} {fac['name']} → {lat}, {lng}")

        if lat:
            ok += 1
        else:
            fail += 1

        if (i + 1) % 100 == 0:
            save(facilities)
            print(f"  [中間保存] {i+1}/{total} 完了")

        time.sleep(SLEEP_SEC)

    save(facilities)
    print(f"\n=== 完了 ===  成功:{ok} スキップ:{skip} 失敗:{fail}")
    print(f"出力: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
