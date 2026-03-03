"""
fetch_review_links.py
保育園ごとの口コミサイトURL・公式HPをnurseries_geo.jsonに追記するスクリプト

【処理内容】
  1. みんなの幼稚園・保育園情報 (minkou.jp) の神奈川全施設をスクレイピング
     → 横浜市の施設を名前→URLマップとして保持
  2. ホイシル (hoicil.com) の横浜市全施設をスクレイピング
     → 施設名→URLマップとして保持
  3. nurseries_geo.json の施設と名前マッチング
  4. ホイシルにある施設は個別ページから公式HPも取得
  5. 結果をnurseries_geo.jsonに保存・集計を出力

【実行方法】
  pip3 install requests beautifulsoup4
  python3 scripts/fetch_review_links.py

【オプション】
  --test          : 最初の20件のみマッチング確認（スクレイピングは全件）
  --skip-hp       : 公式HP取得をスキップ（速度優先）
  --no-scrape     : スクレイピングをスキップ（キャッシュ使用。--cache-fileと組み合わせ）
  --cache-file F  : 中間データをJSONとして保存/読み込みするファイルパス（デフォルト: /tmp/review_cache.json）
"""

import json
import re
import sys
import time
import urllib.parse
import os
import argparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("[ERROR] pip3 install requests beautifulsoup4 を実行してください")
    sys.exit(1)

BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEO_PATH   = os.path.join(BASE_DIR, "data", "nurseries_geo.json")

SLEEP_SEC  = 0.5
HEADERS    = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# 口コミサイトドメイン（公式HPとして除外するドメイン）
REVIEW_DOMAINS = {
    "minkou.jp", "hoicil.com", "ensagaso.com", "mamari.jp",
    "chibi-navi.com", "hokatsu-navi.com", "hoikuen-ranking.com",
    "google.com", "google.co.jp", "yahoo.co.jp", "wikipedia.org",
    "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com",
    # LINEシェアリンク・短縮URL・フォームサービス（公式HPではない）
    "line.me", "lin.ee", "forms.gle", "bit.ly", "t.co",
}


def fetch(url, timeout=15, retries=3):
    """URLを取得してBeautifulSoupを返す。失敗時はNone。リトライあり。"""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=timeout)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "html.parser")
        except Exception as e:
            if attempt < retries - 1:
                wait = (attempt + 1) * 2
                print(f"  [RETRY {attempt+1}/{retries}] {url[:60]}... → {e} (待機{wait}s)")
                time.sleep(wait)
            else:
                print(f"  [WARN] {url[:70]}... → {e}")
    return None


def normalize_name(name: str) -> str:
    """施設名を正規化（マッチング用）"""
    n = name.strip()
    n = n.replace("　", "").replace(" ", "")
    for prefix in ["【公式】", "横浜市立", "横浜市", "(認可)", "（認可）"]:
        if n.startswith(prefix):
            n = n[len(prefix):]
    # 括弧内情報（支店名など）を除去
    n = re.sub(r'[（(][^）)]*[）)]', '', n)
    # 「（イメージ写真）」のような末尾の情報を除去
    n = re.sub(r'\s*（.*?）\s*$', '', n)
    return n.strip()


def names_match(our_name: str, site_name: str) -> bool:
    """施設名のマッチング判定"""
    n1 = normalize_name(our_name)
    n2 = normalize_name(site_name)
    if n1 == n2:
        return True
    if n1 and n2:
        # 片方がもう片方を含む場合（4文字以上）
        if (n1 in n2 or n2 in n1) and len(min(n1, n2, key=len)) >= 4:
            return True
    return False


# ============================================================
# みんなの幼稚園・保育園情報 (minkou.jp)
# ============================================================
def scrape_minkou_yokohama():
    """minkou.jp の神奈川全施設をページングして横浜市の施設を抽出。name→url マップを返す"""
    print("=== みんなの幼稚園・保育園情報 (minkou.jp) スクレイピング ===")
    all_facilities = {}
    base_url = "https://www.minkou.jp/kinder/search/kanagawa/"
    page = 1

    while True:
        # ページネーションは /page=N 形式（クエリパラメータではなくパス形式）
        url = f"{base_url}page={page}" if page > 1 else base_url
        soup = fetch(url)
        if not soup:
            break

        # 施設カード: div.sch-searchBox > a > div > div.sch-searchBox-name > h3
        cards = soup.find_all("div", class_="sch-searchBox")
        if not cards:
            print(f"  page {page}: 施設なし → 終了")
            break

        added = 0
        for card in cards:
            a_tag = card.find("a", href=re.compile(r'/kinder/school/\d+/'))
            if not a_tag:
                continue
            href = a_tag.get("href", "")
            h3 = a_tag.find("h3")
            if not h3:
                continue
            fac_name = h3.get_text(strip=True)

            # 場所（横浜市かどうか確認）
            spans = a_tag.find_all("span")
            location = spans[0].get_text(strip=True) if spans else ""
            if "横浜市" not in location:
                continue

            url_full = "https://www.minkou.jp" + href
            all_facilities[fac_name] = url_full
            added += 1

        print(f"  page {page}: 全{len(cards)}件中 横浜市{added}件 (累計: {len(all_facilities)}件)")

        # 次のページへ
        if len(cards) < 20:
            break
        page += 1
        time.sleep(SLEEP_SEC)

    print(f"  → 横浜市施設合計: {len(all_facilities)} 件\n")
    return all_facilities


# ============================================================
# ホイシル (hoicil.com)
# ============================================================
def scrape_hoicil_yokohama():
    """hoicil.com の横浜市全施設をページングしてname→urlマップを返す"""
    print("=== ホイシル (hoicil.com) スクレイピング ===")
    all_facilities = {}
    base_url = "https://www.hoicil.com/f?area=141003"
    page = 1

    while True:
        url = f"{base_url}&page={page}" if page > 1 else base_url
        soup = fetch(url)
        if not soup:
            break

        # 施設カード: a[href^=https://www.hoicil.com/f/] の中の img[alt]
        added = 0
        for a in soup.find_all("a", href=re.compile(r'hoicil\.com/f/[a-zA-Z0-9]+')):
            href = a.get("href", "")
            img = a.find("img", alt=True)
            if not img:
                continue
            fac_name = img.get("alt", "").strip()
            # 「（イメージ写真）」などを除去
            fac_name = re.sub(r'\s*（.*?）\s*$', '', fac_name).strip()
            if fac_name and href:
                all_facilities[fac_name] = href
                added += 1

        if added == 0:
            print(f"  page {page}: 施設なし → 終了")
            break

        print(f"  page {page}: {added}件 (累計: {len(all_facilities)}件)")
        page += 1
        time.sleep(SLEEP_SEC)

    print(f"  → 横浜市施設合計: {len(all_facilities)} 件\n")
    return all_facilities


def fetch_hoicil_official_hp(hoicil_url: str):
    """ホイシルの施設個別ページから公式HPを取得

    ホイシルのページ構造:
    - 公式HPは facilityDetailFacilitySummary_content クラス内にリンクとして掲載
    - その他の外部リンク（LINE・フォーム等）はページ全体に散在しているため除外
    """
    soup = fetch(hoicil_url)
    if not soup:
        return None

    # 施設概要エリア（facilityDetailFacilitySummary_content）内のリンクを優先探索
    for div in soup.find_all(class_="facilityDetailFacilitySummary_content"):
        for a in div.find_all("a", href=True):
            href = a.get("href", "")
            if not href.startswith("http"):
                continue
            domain = urllib.parse.urlparse(href).netloc
            if domain and "hoicil.com" not in domain and not any(d in domain for d in REVIEW_DOMAINS):
                if "docs.google.com" not in href and "codmon" not in href:
                    return href

    return None


# ============================================================
# マッチング
# ============================================================
def match_to_facilities(our_facilities: list, site_map: dict) -> dict:
    """nurseries_geo の施設とサイトマップを名前マッチング。id→urlの辞書を返す"""
    # 正規化済みマップ
    norm_map = {normalize_name(k): v for k, v in site_map.items()}

    result = {}
    for f in our_facilities:
        name = f.get("name", "")
        fid  = f.get("id", "")

        # 完全一致
        if name in site_map:
            result[fid] = site_map[name]
            continue

        # 正規化一致
        norm_name = normalize_name(name)
        if norm_name in norm_map:
            result[fid] = norm_map[norm_name]
            continue

        # 部分一致（正規化後）
        for site_name_norm, site_url in norm_map.items():
            if names_match(name, site_name_norm):
                result[fid] = site_url
                break

    return result


# ============================================================
# メイン
# ============================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test",       action="store_true", help="最初の20件のみ処理")
    parser.add_argument("--skip-hp",    action="store_true", help="公式HP取得をスキップ")
    parser.add_argument("--no-scrape",  action="store_true", help="スクレイピングをスキップ（キャッシュ使用）")
    parser.add_argument("--cache-file", default="/tmp/review_cache.json", help="中間データのキャッシュファイル")
    args = parser.parse_args()

    # nurseries_geo.json 読み込み
    with open(GEO_PATH, encoding="utf-8") as f:
        geo = json.load(f)
    facilities = geo["facilities"]
    print(f"対象施設数: {len(facilities)}\n")

    # ---- スクレイピング（またはキャッシュ読み込み） ----
    if args.no_scrape and os.path.exists(args.cache_file):
        with open(args.cache_file, encoding="utf-8") as f:
            cache = json.load(f)
        minkou_map = cache.get("minkou", {})
        hoicil_map = cache.get("hoicil", {})
        print(f"[キャッシュ読込] minkou:{len(minkou_map)}件 / hoicil:{len(hoicil_map)}件\n")
    else:
        minkou_map = scrape_minkou_yokohama()
        hoicil_map = scrape_hoicil_yokohama()
        # キャッシュ保存
        with open(args.cache_file, "w", encoding="utf-8") as f:
            json.dump({"minkou": minkou_map, "hoicil": hoicil_map}, f, ensure_ascii=False, indent=2)
        print(f"[キャッシュ保存] {args.cache_file}\n")

    # ---- マッチング ----
    target = facilities[:20] if args.test else facilities

    minkou_matched = match_to_facilities(target, minkou_map)
    hoicil_matched = match_to_facilities(target, hoicil_map)

    print(f"マッチング結果:")
    print(f"  みんなの: {len(minkou_matched)} / {len(target)}")
    print(f"  ホイシル: {len(hoicil_matched)} / {len(target)}")

    # ---- 施設データ更新 ----
    print("\n=== 施設データ更新 ===")
    hp_fetched = 0

    for i, f in enumerate(target, 1):
        fid  = f.get("id", "")
        name = f.get("name", "")

        # 口コミURL（みんなの優先）
        if fid in minkou_matched:
            f["review_url"]  = minkou_matched[fid]
            f["review_site"] = "minkou"
        elif fid in hoicil_matched:
            f["review_url"]  = hoicil_matched[fid]
            f["review_site"] = "hoicil"
        else:
            f.setdefault("review_url", "")
            f.setdefault("review_site", "")

        # 公式HP（ホイシルの個別ページから取得）
        if not args.skip_hp:
            existing_hp = f.get("official_url", "")
            if not existing_hp and fid in hoicil_matched:
                hoicil_url = hoicil_matched[fid]
                hp = fetch_hoicil_official_hp(hoicil_url)
                if hp:
                    f["official_url"] = hp
                    hp_fetched += 1
                    print(f"  [{i}] {name} → HP: {hp[:60]}")
                else:
                    f.setdefault("official_url", "")
                time.sleep(SLEEP_SEC)
            else:
                f.setdefault("official_url", existing_hp or "")

        # 10件ごとに中間保存
        if i % 50 == 0:
            with open(GEO_PATH, "w", encoding="utf-8") as fp:
                json.dump(geo, fp, ensure_ascii=False, indent=2)
            print(f"[中間保存] {i}/{len(target)} 件処理済み")

    # 最終保存
    with open(GEO_PATH, "w", encoding="utf-8") as fp:
        json.dump(geo, fp, ensure_ascii=False, indent=2)

    # ---- 集計 ----
    all_facs     = geo["facilities"]
    n_minkou     = sum(1 for f in all_facs if f.get("review_site") == "minkou")
    n_hoicil     = sum(1 for f in all_facs if f.get("review_site") == "hoicil")
    n_no_review  = sum(1 for f in all_facs if not f.get("review_url"))
    n_hp         = sum(1 for f in all_facs if f.get("official_url"))
    total        = len(all_facs)

    print(f"""
==================================================
=== 集計結果（全 {total} 施設）===
==================================================
【口コミサイト】
  みんなの幼稚園・保育園情報: {n_minkou:5d} 件  ({n_minkou/total*100:.1f}%)
  ホイシル（代替）           : {n_hoicil:5d} 件  ({n_hoicil/total*100:.1f}%)
  口コミリンクなし           : {n_no_review:5d} 件  ({n_no_review/total*100:.1f}%)
  ─────────────────────────────
  口コミリンクあり合計       : {n_minkou+n_hoicil:5d} 件  ({(n_minkou+n_hoicil)/total*100:.1f}%)

【公式HP】
  公式HP取得済み             : {n_hp:5d} 件  ({n_hp/total*100:.1f}%)
  公式HP未発見               : {total-n_hp:5d} 件

[完了] {GEO_PATH} を更新しました
""")


if __name__ == "__main__":
    main()
