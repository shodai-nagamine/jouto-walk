#!/usr/bin/env python3
"""那覇市議会の会議録を、ワールド内の地点に結びつける。

world.json の施設名(建物 gml:name)・バス停名・駅名から検索語を作り、
okinawa-civic-api の Postgres(speeches) を全文検索して、
「どの場所が、誰に、いつ、どう言及されたか」を council.json に落とす。

実行例(全タイルぶん):
  python3 tools/link_council.py \
      --world public/data/tiles/t_*.json --out public/data/council.json

タイルの JSON は座標がタイル内なので meta.offset でワールド座標に直す。
描画側(main.js)は council.json をそのままワールド座標として読む。

前提: okinawa-civic-api の DB が立っていること(既定 okinawa_civic)。
      収録は那覇市議会 令和8年2月定例会 本会議13日分 + 沖縄県議会。
      どちらの議会かは各発言の body に入れる。
"""
import argparse
import json
import os
import re
import subprocess
import sys

# 地名として弱すぎる語(市全体の話に付いてしまう)。
# 施設の「種類」の名前は、OSM に固有名の無い地物として登録されていることがあり、
# 拾うと関係ない場所の発言が刺さる。例: 漫湖公園のテニスコートの話が、
# たまたま「テニスコート」という名で登録された奥武山の地物に付いた(実際に出た)。
STOP_TERMS = {
    "那覇", "沖縄", "首里", "石嶺", "小学校", "中学校", "公園", "郵便局",
    "テニスコート", "運動場", "体育館", "駐車場", "グラウンド", "広場",
    "プール", "球場", "陸上競技場", "多目的広場", "駐輪場", "バス停",
}

# 議会が議題にするのは公共施設・道路。店舗名を入れると無関係な発言を拾う
# (例: 「ほっともっと」が金芽米の話に、「コープ」が労働者協同組合ワーカーズコープに当たった)
CIVIC_KINDS = (
    "amenity=school", "amenity=library", "amenity=community_centre",
    "amenity=townhall", "amenity=fire_station", "amenity=police",
    "amenity=hospital", "amenity=kindergarten", "amenity=social_facility",
    "amenity=public_building", "amenity=bicycle_rental",
    "leisure=park", "leisure=sports_centre", "leisure=swimming_pool",
    "leisure=pitch", "leisure=stadium",
    "building=public", "building=school", "building=train_station",
    "building=apartments", "landuse=residential", "landuse=construction",
    "highway=",
)
CIVIC_WORDS = (
    "学校", "公民館", "図書館", "市営住宅", "県営住宅", "団地", "公園", "保育",
    "児童", "会館", "センター", "消防", "警察", "交番", "病院", "駅", "プール",
    "市道", "県道", "国道", "線", "通り", "給食", "役所", "支所", "こども園",
)


def is_civic(name, kind):
    if any(kind.startswith(k) for k in CIVIC_KINDS):
        return True
    return any(w in name for w in CIVIC_WORDS)
MIN_LEN = 3          # これより短い語は曖昧すぎる
MAX_HITS = 40        # ヒットが多すぎる語は地点に結びつかない一般語とみなす
PER_PLACE = 4        # 1地点あたりに載せる発言数
EXCERPT = 150        # 抜粋の前後の文字数


def psql_json(db, sql):
    """psql で JSON を1個だけ返すクエリを実行する。"""
    r = subprocess.run(
        ["psql", "-d", db, "-Atc", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stderr.strip(), file=sys.stderr)
        raise SystemExit(f"psql 失敗: {r.stderr.strip()[:200]}")
    out = r.stdout.strip()
    return json.loads(out) if out and out != "null" else None


def esc(s):
    return s.replace("'", "''")


def normalize(name):
    """施設名・バス停名から検索語を作る。"""
    t = name.strip()
    t = re.sub(r"^(那覇市立|市立|那覇市|沖縄県立|県立)", "", t)
    t = re.sub(r"(前|入口|入り口|バス停)$", "", t)
    return t.strip()


def excerpt_around(text, term):
    """語の周りを切り出す。改行と全角空白は詰める。"""
    t = re.sub(r"[\s　]+", " ", text).strip()
    i = t.find(term)
    if i < 0:
        return t[:EXCERPT * 2]
    a = max(0, i - EXCERPT)
    b = min(len(t), i + len(term) + EXCERPT)
    return ("…" if a > 0 else "") + t[a:b] + ("…" if b < len(t) else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", nargs="+", required=True,
                    help="タイルの JSON(複数可)。glob を展開して全部渡してよい")
    ap.add_argument("--out", required=True)
    ap.add_argument("--db", default=os.environ.get("CIVIC_DB", "okinawa_civic"))
    args = ap.parse_args()

    # 検索語 → 座標。建物(施設名)を優先し、無ければバス停・駅を使う
    places = {}

    def add(name, x, z, kind, prio, osm_kind=""):
        term = normalize(name)
        if len(term) < MIN_LEN or term in STOP_TERMS:
            return
        if not is_civic(name, osm_kind):
            return
        cur = places.get(term)
        if cur and cur["prio"] <= prio:
            return
        places[term] = {"term": term, "label": name, "kind": kind,
                        "x": round(x, 2), "z": round(z, 2), "prio": prio}

    # タイルの JSON は座標がタイル内(0〜size)なので、meta.offset を足して
    # ワールド座標に直す。council.json は最初からワールド座標で持つ。
    for path in args.world:
        w = json.load(open(path, encoding="utf-8"))
        half = w["meta"]["size"] / 2
        ox, oz = w["meta"].get("offset", [0, 0])
        X = lambda v: v - half + ox
        Z = lambda v: v - half + oz
        for l in w.get("landmarks", []):
            add(l["name"], X(l["x"]), Z(l["z"]), "施設", 0, l.get("kind", ""))
        for st in w.get("stations", []):
            add(st["name"] + "駅", X(st["x"]), Z(st["z"]), "駅", 1,
                "building=train_station")
        for b in w.get("bus", []):
            if b.get("name"):
                add(b["name"], X(b["x"]), Z(b["z"]), "バス停", 2, "highway=bus_stop")

    print(f"検索語 {len(places)}件: {'、'.join(sorted(places))}", file=sys.stderr)

    results = []
    for term, p in sorted(places.items()):
        n = psql_json(args.db, f"""
            select json_build_object('n', count(*))
            from speeches where text like '%{esc(term)}%';""")["n"]
        if n == 0:
            continue
        if n > MAX_HITS:
            print(f"  {term}: {n}件 → 一般語とみなして除外", file=sys.stderr)
            continue
        rows = psql_json(args.db, f"""
            select coalesce(json_agg(r), '[]'::json) from (
              select s.speaker_raw as speaker,
                     coalesce(s.speaker_title,'') as title,
                     coalesce(s.speaker_kind,'') as kind,
                     coalesce(m.date::text,'') as date,
                     coalesce(m.title,'') as meeting,
                     coalesce(m.source_url,'') as url,
                     -- 収録は那覇市議会と沖縄県議会の両方。どちらの発言かを
                     -- 持たせないと、表示側が一律「市議会」と名乗ってしまう
                     case when mu.name = '沖縄県' then '沖縄県議会'
                          else mu.name || '議会' end as body,
                     s.text as text
              from speeches s
                   join meetings m on m.id = s.meeting_id
                   join municipalities mu on mu.id = m.municipality_id
              where s.text like '%{esc(term)}%'
              -- 発言者不明(32件ある)と議長の議事進行を後ろへ回し、
              -- 議員の質疑と執行部の答弁を先に出す
              order by (coalesce(nullif(s.speaker_raw, ''), '') = ''),
                       (s.speaker_kind = '議長'),
                       (length(s.text) < 200),
                       m.date desc nulls last
              limit {PER_PLACE}
            ) r;""")
        if not rows:
            continue
        results.append({
            "term": term, "label": p["label"], "kind": p["kind"],
            "x": p["x"], "z": p["z"],
            "hits": n,
            "speeches": [{
                "speaker": r["speaker"], "title": r["title"], "kind": r["kind"],
                "date": r["date"], "meeting": r["meeting"], "url": r["url"],
                "body": r["body"],
                "excerpt": excerpt_around(r["text"], term),
            } for r in rows],
        })
        print(f"  {term}: {n}件 → {len(rows)}件を採用", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump({
        "source": "那覇市議会・沖縄県議会 会議録(okinawa-civic-api)",
        "places": results,
    }, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    total = sum(len(r["speeches"]) for r in results)
    print(f"\n地点 {len(results)} / 発言 {total} → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
