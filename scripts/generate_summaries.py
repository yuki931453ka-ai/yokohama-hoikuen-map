"""
generate_summaries.py
スクレイプ済み口コミデータ + 月次統計データを基に、Claude Haiku で各施設のAIサマリーを生成する。

【入力】
  - data/nurseries_geo.json   : 施設マスター
  - data/reviews_raw.json     : スクレイプ済み口コミ・園情報
  - data/monthly/*.json       : 月次の入所/空き/待ちデータ

【出力】
  data/ai_summaries.json

【実行方法】
  export ANTHROPIC_API_KEY=sk-ant-xxxxx
  python3 scripts/generate_summaries.py

【オプション】
  --limit N      : 最初のN件のみ処理
  --force        : 既存サマリーを上書き
  --concurrency  : 並列リクエスト数（デフォルト: 5）
  --model MODEL  : 使用モデル（デフォルト: claude-haiku-4-5-20251001）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

try:
    import anthropic
except ImportError:
    print("[ERROR] pip3 install anthropic を実行してください")
    sys.exit(1)

# ========================================
# 定数
# ========================================
BASE_DIR = Path(__file__).resolve().parent.parent
GEO_PATH = BASE_DIR / "data" / "nurseries_geo.json"
REVIEWS_PATH = BASE_DIR / "data" / "reviews_raw.json"
MONTHS_PATH = BASE_DIR / "data" / "months.json"
OUTPUT_PATH = BASE_DIR / "data" / "ai_summaries.json"

AGE_KEYS = ["０歳", "１歳", "２歳", "３歳", "４歳", "５歳"]

# advisor-strategy: skipped (バッチ生成スクリプトのためコスト最小化を優先)
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

SYSTEM_PROMPT = """\
あなたは横浜市の保育園情報アドバイザーです。
保護者に向けて、保育園の特徴をわかりやすく簡潔にまとめてください。

以下のJSON形式で出力してください（他のテキストは不要）:
{
  "comment": "園の特徴・口コミ・入りやすさを2〜3文で。保護者目線で具体的に。",
  "tags": ["特徴タグ1", "特徴タグ2", "特徴タグ3"],
  "ease": "入りやすい|普通|やや競争あり|競争率高め"
}

ルール:
- comment は80〜150文字程度。です/ます調で。
- tags は3〜5個。園の特徴を端的に表すキーワード。
- ease は空き/待ちデータから判断。待ちが多ければ「競争率高め」、空きが常にあれば「入りやすい」。
- 口コミがない場合でも、施設種別・立地・空き状況からわかる範囲でコメントする。
- 推測は「～の可能性があります」のように控えめに。\
"""


# ========================================
# データ読み込み
# ========================================
def load_geo() -> dict[str, Any]:
    """施設マスターを読み込み。"""
    with open(GEO_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_reviews() -> dict[str, Any]:
    """スクレイプ済みデータを読み込み。"""
    if not REVIEWS_PATH.exists():
        return {"facilities": {}}
    with open(REVIEWS_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_monthly_trends() -> dict[str, dict[str, Any]]:
    """全月次データを読み込み、施設ごとのトレンドを集計。"""
    if not MONTHS_PATH.exists():
        return {}

    with open(MONTHS_PATH, encoding="utf-8") as f:
        months = json.load(f)

    # 施設ID → { month_label: { vacancy: int, waiting: int } }
    trends: dict[str, list[dict[str, Any]]] = {}

    for month_info in months:
        month_file = BASE_DIR / month_info["file"]
        if not month_file.exists():
            continue
        with open(month_file, encoding="utf-8") as f:
            month_data = json.load(f)

        for fid, fac_data in month_data.get("facilities", {}).items():
            if fid not in trends:
                trends[fid] = []

            enrolled = sum(fac_data.get("enrolled", {}).get(age, 0) for age in AGE_KEYS)
            capacity = sum(fac_data.get("capacity", {}).get(age, 0) for age in AGE_KEYS)
            waiting = sum(fac_data.get("waiting", {}).get(age, 0) for age in AGE_KEYS)
            vacancy = max(0, capacity - enrolled)

            trends[fid].append({
                "month": month_info["label"],
                "vacancy": vacancy,
                "waiting": waiting,
            })

    return trends


def build_prompt(facility: dict[str, Any], review_data: dict[str, Any] | None,
                 trends: list[dict[str, Any]] | None) -> str:
    """施設ごとのプロンプトを構築。"""
    parts = []

    # 基本情報
    parts.append(f"【施設名】{facility['name']}")
    parts.append(f"【種別】{facility.get('type', '不明')}")
    parts.append(f"【所在地】{facility.get('ward', '')} {facility.get('address', '')}")
    if facility.get("temp_childcare"):
        parts.append(f"【一時保育】{facility['temp_childcare']}")

    # 月次トレンド
    if trends:
        # 最新3ヶ月と最古3ヶ月を表示
        recent = trends[-3:] if len(trends) >= 3 else trends
        trend_lines = []
        for t in recent:
            trend_lines.append(f"  {t['month']}: 空き{t['vacancy']}名 / 待ち{t['waiting']}名")
        parts.append(f"【最近の空き状況】\n" + "\n".join(trend_lines))

        # 平均値
        avg_vacancy = sum(t["vacancy"] for t in trends) / len(trends)
        avg_waiting = sum(t["waiting"] for t in trends) / len(trends)
        parts.append(f"【年間平均】空き{avg_vacancy:.1f}名 / 待ち{avg_waiting:.1f}名")

    # 口コミ・園情報
    if review_data:
        source = review_data.get("source", "")
        if source == "minkou":
            rating = review_data.get("rating")
            if rating:
                parts.append(f"【口コミ評価】{rating}/5.0")
            combined = review_data.get("combined_text", "")
            if combined:
                # テキストを1000文字に制限（トークン節約）
                parts.append(f"【口コミ抜粋】\n{combined[:1000]}")
        elif source == "hoicil":
            features = review_data.get("features", [])
            if features:
                parts.append(f"【園の特徴】{', '.join(features)}")
            info_text = review_data.get("info_text", "")
            if info_text:
                parts.append(f"【園の詳細情報】\n{info_text[:1000]}")

    return "\n\n".join(parts)


# ========================================
# AI サマリー生成
# ========================================
async def generate_summary(
    client: anthropic.AsyncAnthropic,
    facility: dict[str, Any],
    review_data: dict[str, Any] | None,
    trends: list[dict[str, Any]] | None,
    model: str,
    semaphore: asyncio.Semaphore,
) -> tuple[str, dict[str, Any] | None]:
    """1施設分のサマリーを非同期生成。"""
    fid = facility["id"]
    prompt = build_prompt(facility, review_data, trends)

    async with semaphore:
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=512,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            text = response.content[0].text.strip()

            # JSONパース
            # テキストから JSON 部分を抽出（前後に余計なテキストがある場合）
            json_match = text
            if not text.startswith("{"):
                import re
                m = re.search(r"\{.*\}", text, re.DOTALL)
                if m:
                    json_match = m.group()

            parsed = json.loads(json_match)

            # バリデーション
            VALID_EASE = {"入りやすい", "普通", "やや競争あり", "競争率高め"}

            raw_tags = parsed.get("tags", [])
            # tagsが文字列の場合はリストに変換
            if isinstance(raw_tags, str):
                raw_tags = [raw_tags]
            tags = [str(t) for t in raw_tags if isinstance(t, str)][:5]

            raw_ease = str(parsed.get("ease", "普通"))
            ease = raw_ease if raw_ease in VALID_EASE else "普通"

            raw_comment = str(parsed.get("comment", ""))
            comment = raw_comment[:200]  # 長すぎるコメントを制限

            result = {
                "comment": comment,
                "tags": tags,
                "ease": ease,
            }

            # 口コミソース情報を追加（数値バリデーション付き）
            if review_data:
                if review_data.get("source") == "minkou":
                    rating = review_data.get("rating")
                    if isinstance(rating, (int, float)) and 0 <= rating <= 5:
                        result["review_rating"] = round(float(rating), 2)
                    count = review_data.get("review_count", 0)
                    if isinstance(count, int) and count >= 0:
                        result["review_count"] = count

            return fid, result

        except json.JSONDecodeError:
            print(f"    [WARN] JSONパース失敗: {facility['name']} → {text[:100]}")
            return fid, None
        except Exception as e:
            print(f"    [ERROR] {facility['name']} → {e}")
            return fid, None


async def run_batch(
    facilities: list[dict[str, Any]],
    reviews: dict[str, Any],
    trends: dict[str, dict[str, Any]],
    model: str,
    concurrency: int,
    output_path: Path,
    existing: dict[str, Any],
) -> dict[str, Any]:
    """全施設のサマリーをバッチ生成。"""
    client = anthropic.AsyncAnthropic()
    semaphore = asyncio.Semaphore(concurrency)

    summaries = existing.get("summaries", {})
    total = len(facilities)

    # チャンクに分割して処理（進捗表示 + 中間保存）
    chunk_size = 50
    success = 0
    errors = 0

    for chunk_start in range(0, total, chunk_size):
        chunk = facilities[chunk_start:chunk_start + chunk_size]
        chunk_end = min(chunk_start + chunk_size, total)

        print(f"\n--- チャンク {chunk_start+1}〜{chunk_end} / {total} ---")

        tasks = []
        for fac in chunk:
            fid = fac["id"]
            review_data = reviews.get("facilities", {}).get(fid)
            fac_trends = trends.get(fid)
            tasks.append(generate_summary(
                client, fac, review_data, fac_trends, model, semaphore,
            ))

        results = await asyncio.gather(*tasks)

        for fid, result in results:
            if result:
                summaries[fid] = result
                success += 1
            else:
                errors += 1

        # 中間保存
        output = {
            "generated_at": time.strftime("%Y-%m-%d %H:%M"),
            "model": model,
            "count": len(summaries),
            "summaries": summaries,
        }
        save_output(output_path, output)
        print(f"  保存完了: {len(summaries)}件 (成功:{success} エラー:{errors})")

    return output


def save_output(output_path: Path, data: dict[str, Any]) -> None:
    """出力ファイルを保存。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="AI保育園サマリー生成")
    parser.add_argument("--limit", type=int, default=0, help="処理件数の制限")
    parser.add_argument("--force", action="store_true", help="既存サマリーを上書き")
    parser.add_argument("--concurrency", type=int, default=5, help="並列リクエスト数")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="使用モデル")
    args = parser.parse_args()

    # API キーチェック（環境変数 or ライブラリのデフォルト設定を使用）
    try:
        test_client = anthropic.Anthropic()
        _ = test_client.api_key  # キーが利用可能か確認
    except anthropic.AuthenticationError:
        print("[ERROR] ANTHROPIC_API_KEY 環境変数を設定してください")
        print("  export ANTHROPIC_API_KEY=sk-ant-xxxxx")
        sys.exit(1)

    # データ読み込み
    print("データ読み込み中...")
    geo = load_geo()
    reviews = load_reviews()
    trends = load_monthly_trends()
    print(f"  施設マスター: {len(geo['facilities'])} 件")
    print(f"  口コミデータ: {len(reviews.get('facilities', {}))} 件")
    print(f"  トレンドデータ: {len(trends)} 件")

    # 既存サマリー読み込み
    existing: dict[str, Any] = {"summaries": {}}
    if OUTPUT_PATH.exists() and not args.force:
        with open(OUTPUT_PATH, encoding="utf-8") as f:
            existing = json.load(f)
        print(f"  既存サマリー: {len(existing.get('summaries', {}))} 件")

    # 処理対象の抽出
    existing_ids = set(existing.get("summaries", {}).keys())
    targets = [f for f in geo["facilities"] if f.get("id") and (args.force or f["id"] not in existing_ids)]
    if args.limit > 0:
        targets = targets[:args.limit]

    print(f"\n生成対象: {len(targets)} 件")
    print(f"モデル: {args.model}")
    print(f"並列数: {args.concurrency}")

    if not targets:
        print("生成対象がありません。完了！")
        return

    # コスト見積もり
    estimated_cost = len(targets) * (500 * 0.80 / 1_000_000 + 200 * 4.0 / 1_000_000)
    print(f"推定コスト: ${estimated_cost:.2f}\n")

    # バッチ実行
    start_time = time.time()
    output = asyncio.run(run_batch(
        targets, reviews, trends, args.model, args.concurrency, OUTPUT_PATH, existing,
    ))
    elapsed = time.time() - start_time

    print(f"""
{'='*50}
AI サマリー生成完了
{'='*50}
生成数: {output['count']} 件
所要時間: {elapsed:.1f}秒
出力: {OUTPUT_PATH}
""")


if __name__ == "__main__":
    main()
