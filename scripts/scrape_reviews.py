"""
scrape_reviews.py
保育園の口コミテキスト・施設情報をスクレイピングして reviews_raw.json に保存する。

【処理内容】
  - minkou.jp : レビューページから口コミテキスト・評価を抽出
  - hoicil.com: 施設ページから特徴・設備・行事などの情報を抽出
  - 口コミURLなし: スキップ（基本データのみでAI生成）

【出力】
  data/reviews_raw.json

【実行方法】
  pip3 install requests beautifulsoup4
  python3 scripts/scrape_reviews.py

【オプション】
  --limit N       : 最初のN件のみ処理（テスト用）
  --force         : 既存データを上書き
  --delay FLOAT   : リクエスト間隔（秒、デフォルト: 0.8）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import requests
    from bs4 import BeautifulSoup, Tag
except ImportError:
    print("[ERROR] pip3 install requests beautifulsoup4 を実行してください")
    sys.exit(1)

# ========================================
# 定数
# ========================================
BASE_DIR = Path(__file__).resolve().parent.parent
GEO_PATH = BASE_DIR / "data" / "nurseries_geo.json"
OUTPUT_PATH = BASE_DIR / "data" / "reviews_raw.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

MAX_REVIEW_CHARS = 2000  # 1施設あたりの口コミテキスト上限

# SSRF対策: 許可するホストのリスト
ALLOWED_HOSTS = {"www.minkou.jp", "minkou.jp", "www.hoicil.com", "hoicil.com"}


# ========================================
# HTTP ユーティリティ
# ========================================
def validate_url(url: str) -> bool:
    """URLのスキームとホストを検証し、許可リストのみ通す。"""
    try:
        parsed = urlparse(url)
        return parsed.scheme in ("http", "https") and parsed.hostname in ALLOWED_HOSTS
    except Exception:
        return False


def fetch_soup(url: str, timeout: int = 15, retries: int = 3) -> BeautifulSoup | None:
    """URLをGETしてBeautifulSoupを返す。失敗時はNone。"""
    if not validate_url(url):
        print(f"    [BLOCKED] 許可されていないURL: {url[:70]}")
        return None
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=False)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "html.parser")
        except Exception as e:
            if attempt < retries - 1:
                wait = (attempt + 1) * 2
                print(f"    [RETRY {attempt+1}] {url[:60]}… → {e} (待機{wait}s)")
                time.sleep(wait)
            else:
                print(f"    [WARN] {url[:70]}… → {e}")
    return None


def clean_text(text: str) -> str:
    """テキストから余分な空白・改行を除去。"""
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ========================================
# minkou.jp スクレイパー
# ========================================
def extract_minkou_school_id(url: str) -> str | None:
    """URLからminkou.jpの学校IDを抽出。"""
    match = re.search(r"/school/(\d+)/", url)
    return match.group(1) if match else None


def scrape_minkou_reviews(review_url: str) -> dict[str, Any] | None:
    """minkou.jpのレビューページから口コミを抽出。

    HTML構造:
      div.mod-reviewList > ul > li（1件ずつ）
        li 内:
          div.mod-reviewTop    → ヘッダー（タイトル・評価・年）
          div.mod-reviewBottom → 本文（mod-reviewList-txt が複数）
        li.mod-reviewList-list__ad → 広告（スキップ）
    """
    school_id = extract_minkou_school_id(review_url)
    if not school_id:
        return None

    # レビューページを直接取得
    review_page_url = f"https://www.minkou.jp/kinder/school/review/{school_id}/"
    soup = fetch_soup(review_page_url)
    if not soup:
        soup = fetch_soup(review_url)
        if not soup:
            return None

    result: dict[str, Any] = {"rating": None, "review_count": 0, "reviews": []}

    # 総合評価スコア取得
    rate_star = soup.find("div", class_="mod-reviewTotal-rate-star")
    if rate_star:
        text = rate_star.get_text(strip=True)
        m = re.search(r"(\d+\.\d+)", text)
        if m:
            result["rating"] = float(m.group(1))

    # 各口コミを li 単位で抽出
    review_list = soup.find("div", class_="mod-reviewList")
    reviews: list[dict[str, str]] = []

    if review_list:
        ul = review_list.find("ul")
        lis = ul.find_all("li", recursive=False) if ul else []

        for li in lis:
            # 広告liをスキップ
            li_classes = " ".join(li.get("class", []))
            if "__ad" in li_classes:
                continue

            review: dict[str, str] = {}

            # ヘッダー部分（mod-reviewTop）
            top_div = li.find("div", class_="mod-reviewTop")
            if top_div:
                title_div = top_div.find("div", class_="mod-reviewTitle")
                if title_div:
                    review["title"] = title_div.get_text(strip=True)

                inner = top_div.find("div", class_="mod-reviewTop-inner")
                if inner:
                    meta = inner.get_text(" ", strip=True)
                    year_m = re.search(r"(\d{4})年", meta)
                    if year_m:
                        review["year"] = year_m.group(0)

                score_span = top_div.find("span", class_="mod-reviewScore-num")
                if score_span:
                    review["score"] = score_span.get_text(strip=True)

            # 本文部分（mod-reviewBottom 内の mod-reviewList-txt）
            bottom_div = li.find("div", class_="mod-reviewBottom")
            texts: list[str] = []
            if bottom_div:
                for txt_div in bottom_div.find_all("div", class_="mod-reviewList-txt"):
                    t = txt_div.get_text(strip=True)
                    if t:
                        texts.append(t)

            review["text"] = " ".join(texts)

            if review.get("title") or review.get("text"):
                reviews.append(review)

    # テキスト量を制限して combined_text を構築
    combined_parts: list[str] = []
    total_len = 0
    for rev in reviews:
        title = rev.get("title", "")
        text = rev.get("text", "")
        year = rev.get("year", "")
        score = rev.get("score", "")
        entry = f"[{year} 評価{score}] {title}\n{text}" if title else text
        if total_len + len(entry) > MAX_REVIEW_CHARS:
            break
        combined_parts.append(entry)
        total_len += len(entry)

    result["reviews"] = reviews[:10]
    result["review_count"] = len(reviews)
    result["combined_text"] = "\n\n".join(combined_parts)

    return result


# ========================================
# hoicil.com スクレイパー
# ========================================
def scrape_hoicil_info(hoicil_url: str) -> dict[str, Any] | None:
    """hoicil.comの施設ページから園情報を抽出。"""
    soup = fetch_soup(hoicil_url)
    if not soup:
        return None

    # スクリプト・スタイルを除去
    for tag_name in ["script", "style"]:
        for tag in soup.find_all(tag_name):
            tag.decompose()

    result: dict[str, Any] = {
        "features": [],
        "info_text": "",
    }

    # 特徴タグ（園庭あり、延長保育、自園調理 など）
    feature_keywords = [
        "園庭", "延長保育", "一時保育", "自園調理", "給食",
        "英語", "体操", "リトミック", "看護師", "栄養士",
        "連絡アプリ", "駐車場", "駐輪場", "送迎バス",
    ]
    page_text = soup.get_text(" ", strip=True)
    for keyword in feature_keywords:
        if keyword in page_text:
            result["features"].append(keyword)

    # メインコンテンツのテキスト抽出
    # ナビ・フッターを除去してテキスト取得
    for tag_name in ["nav", "footer", "header"]:
        for tag in soup.find_all(tag_name):
            tag.decompose()

    main = soup.find("main") or soup.body
    if main:
        info_text = clean_text(main.get_text("\n", strip=True))
        # 不要な部分を削除（近隣施設リストなど）
        cut_markers = ["近くの保育施設", "周辺の保育", "よくある質問"]
        for marker in cut_markers:
            idx = info_text.find(marker)
            if idx > 0:
                info_text = info_text[:idx]

        result["info_text"] = info_text[:MAX_REVIEW_CHARS]

    return result


# ========================================
# メイン処理
# ========================================
def load_existing(output_path: Path) -> dict[str, Any]:
    """既存の出力ファイルを読み込む（レジューム用）。"""
    if output_path.exists():
        with open(output_path, encoding="utf-8") as f:
            return json.load(f)
    return {"scraped_at": "", "facilities": {}}


def save_output(output_path: Path, data: dict[str, Any]) -> None:
    """出力ファイルを保存。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="保育園口コミ・園情報スクレイパー")
    parser.add_argument("--limit", type=int, default=0, help="処理件数の制限（0=全件）")
    parser.add_argument("--force", action="store_true", help="既存データを上書き")
    parser.add_argument("--delay", type=float, default=0.8, help="リクエスト間隔（秒）")
    args = parser.parse_args()

    # nurseries_geo.json 読み込み
    with open(GEO_PATH, encoding="utf-8") as f:
        geo = json.load(f)
    facilities = geo["facilities"]
    print(f"全施設数: {len(facilities)}")

    # 既存データ読み込み（レジューム対応）
    output = load_existing(OUTPUT_PATH) if not args.force else {"scraped_at": "", "facilities": {}}
    existing_ids = set(output["facilities"].keys())
    print(f"スクレイプ済み: {len(existing_ids)} 件")

    # 処理対象の抽出
    targets = []
    for fac in facilities:
        fid = fac.get("id", "")
        if not fid:
            continue
        if fid in existing_ids and not args.force:
            continue
        review_url = fac.get("review_url", "")
        review_site = fac.get("review_site", "")
        if review_url and review_site:
            targets.append(fac)

    if args.limit > 0:
        targets = targets[:args.limit]

    print(f"スクレイプ対象: {len(targets)} 件\n")

    if not targets:
        print("スクレイプ対象がありません。完了！")
        return

    # スクレイピング実行
    success_count = 0
    error_count = 0

    for i, fac in enumerate(targets, 1):
        fid = fac["id"]
        name = fac["name"]
        site = fac.get("review_site", "")
        url = fac.get("review_url", "")

        print(f"[{i}/{len(targets)}] {name} ({site})")

        try:
            if site == "minkou":
                data = scrape_minkou_reviews(url)
            elif site == "hoicil":
                data = scrape_hoicil_info(url)
            else:
                continue

            if data:
                output["facilities"][fid] = {
                    "source": site,
                    "name": name,
                    **data,
                }
                success_count += 1
                review_info = ""
                if site == "minkou":
                    rating = data.get("rating")
                    count = data.get("review_count", 0)
                    review_info = f" → 評価:{rating} 口コミ:{count}件"
                elif site == "hoicil":
                    features = data.get("features", [])
                    review_info = f" → 特徴:{', '.join(features[:3])}"
                print(f"  ✅ 成功{review_info}")
            else:
                error_count += 1
                print(f"  ❌ データ取得失敗")

        except Exception as e:
            error_count += 1
            print(f"  ❌ エラー: {e}")

        # 定期保存（50件ごと）
        if i % 50 == 0:
            output["scraped_at"] = time.strftime("%Y-%m-%d %H:%M")
            save_output(OUTPUT_PATH, output)
            print(f"  [中間保存] {i}/{len(targets)} 件処理済み")

        # レート制限
        time.sleep(args.delay)

    # 最終保存
    output["scraped_at"] = time.strftime("%Y-%m-%d %H:%M")
    save_output(OUTPUT_PATH, output)

    # 集計
    total_scraped = len(output["facilities"])
    minkou_count = sum(1 for v in output["facilities"].values() if v.get("source") == "minkou")
    hoicil_count = sum(1 for v in output["facilities"].values() if v.get("source") == "hoicil")

    print(f"""
{'='*50}
スクレイピング完了
{'='*50}
今回処理: {success_count} 成功 / {error_count} エラー
累計:
  minkou: {minkou_count} 件
  hoicil: {hoicil_count} 件
  合計:   {total_scraped} 件

出力: {OUTPUT_PATH}
""")


if __name__ == "__main__":
    main()
