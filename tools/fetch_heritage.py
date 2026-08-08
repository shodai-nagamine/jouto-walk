#!/usr/bin/env python3
"""国指定文化財を文化庁のデータベースから取って、この world の座標に直す。

**国土数値情報の「都道府県指定文化財データ(P32)」は使わない。** 利用許諾が
「非商用」で、複製物の再配布が禁止されている（バス停の P11 と同じ罠）。
公開リポジトリに載せられない。

使うのは文化庁の国指定文化財等データベース。利用規約に
「文字情報は、出典を記載の上、自由にご利用ください」と明記されている。
**画像は「第三者が権利を有しているものがあるため、作品毎に個別の許諾が必要」**
なので、thumbnail は取らない。

取得の口:
  1. /bsys/index を GET してセッションと _csrfToken を得る（POST に要る）
  2. /search/map-move?ne_lat=…&zoomLevel=…&zoomMode=HERITAGE が JSON を返す。
     zoomLevel を渡さないと都道府県単位に丸められる（"zoom up" のマーカーになる）
  3. /heritage/detail/{subtype}/{code} が解説文を持つ

  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_heritage.py
  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_heritage.py --relink

--relink は取得をやり直さず、既存の heritage.json と OSM 史跡の突き合わせだけ
やり直す。突き合わせの規則をいじるときはこちら（文化庁に何度も投げない）。

出力は public/data/heritage.json。
"""
import argparse
import html
import http.cookiejar
import json
import math
import pathlib
import re
import time
import urllib.parse
import urllib.request

BASE = "https://kunishitei.bunka.go.jp"
# 取ってきたままのものを OSM の生データと同じ場所に置く。--relink はこれを読む。
# 加工後の heritage.json を読み直すと、まとめた標柱を二度まとめることになり
# 結果が変わる（実測で parts が消えた）
RAW = pathlib.Path.home() / "dev/tools/blender-mcp/data/naha/heritage_raw.json"
UA = "jouto-walk/1.0 (https://github.com/shodai-nagamine/jouto-walk)"
M_LAT = 111320.0
# 那覇市域を覆う外接矩形（lat0, lon0, lat1, lon1）
CITY_BBOX = (26.176, 127.646, 26.268, 127.760)


def opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA)]
    return op


def get(op, url, timeout=60):
    with op.open(url, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def markers(op, bbox, zoom=14):
    lat0, lon0, lat1, lon1 = bbox
    get(op, f"{BASE}/bsys/index")          # セッションを張る
    q = urllib.parse.urlencode({
        "ne_lat": lat1, "ne_lng": lon1, "sw_lat": lat0, "sw_lng": lon0,
        "zoomLevel": zoom, "zoomMode": "HERITAGE",
    })
    d = json.loads(get(op, f"{BASE}/search/map-move?{q}"))
    return [m for m in d.get("marker", []) if m.get("type") == "HERITAGE"]


def detail_text(op, subtype, code, limit=1200):
    """解説文。無ければ空文字。"""
    try:
        h = get(op, f"{BASE}/heritage/detail/{subtype}/{code}")
    except Exception:
        return ""
    h = re.sub(r"<script.*?</script>", "", h, flags=re.S)
    body = html.unescape(re.sub(r"<[^>]+>", "\n", h))
    # 解説文は 80 字を超える段落として現れる。ページ内で 2 回出るので重複を除く
    seen, paras = set(), []
    for line in (l.strip() for l in body.splitlines()):
        if len(line) < 80 or "Copyright" in line or line in seen:
            continue
        seen.add(line)
        paras.append(line)
    return "".join(paras)[:limit]


# ---------------------------------------------------------- OSM 史跡との対応
#
# 世界には OSM 由来の史跡（標柱）がすでに立っている。同じものが二重に立つのを
# 避けるため、対応が取れる文化財は OSM の標柱に解説を「載せる」だけにし、
# 対応の無いものだけ独立した標柱として立てる。
#
# **近いだけで結びつけてはいけない。** 60m の近さだけで当てたら
# 「沖縄師範学校跡 → 天女橋」「内金城嶽 → 首里金城の大アカギ」のように
# 別物の由緒が付いた（実測）。史跡の由緒の取り違えは公開物として最悪なので、
# 名前が対応することを条件にし、距離は保険としてしか使わない。
LINK_FAR = 400.0          # 名前が合っても、これより遠ければ別物とみなす(m)


def norm_name(s):
    """比較用に名前を均す。「跡」「石門」などの語尾差を吸収する。"""
    for ch in " \u3000・（）()「」【】":
        s = s.replace(ch, "")
    for suf in ("跡", "址", "阯"):
        if s.endswith(suf):
            s = s[: -len(suf)]
            break
    for suf in ("石門", "門"):
        if s.endswith(suf):
            s = s[: -len(suf)]
            break
    return s


def tile_sites(root, tiles_dir):
    """全タイルの OSM 史跡をワールド座標で集める。"""
    out = []
    for f in sorted((root / tiles_dir).glob("t_*.json")):
        d = json.loads(f.read_text())
        ox, oz = d["meta"]["offset"]
        half = d["meta"]["size"] / 2
        for h in d.get("historic", []):
            out.append({"name": h["name"],
                        "x": h["x"] - half + ox, "z": h["z"] - half + oz})
    return out


def link(sites, heritage):
    """文化財に、対応する OSM 史跡の鍵を書き込む。戻り値は対応の一覧。"""
    pairs = []
    for h in heritage:
        # 美術工芸品(絵画・写真・文書)は「場所」ではなく所蔵先の座標。
        # 標柱としても立てないし、OSM にも当てない
        if any(k in h["k"] for k in NOT_A_PLACE):
            h["skip"] = 1
            continue
        b = norm_name(h["name"])
        if len(b) < 2:
            continue
        best = None
        for s in sites:
            a = norm_name(s["name"])
            if len(a) < 2:
                continue
            # 「重修天女橋碑記」は天女橋そのものではない。碑・記念碑に
            # 構造物の解説を載せると別物の由緒になるので当てない
            if a != b and a.endswith(("碑", "碑記", "碑文")) and not b.endswith("碑"):
                continue
            # 一致の強さ: 2=完全 / 1=文化財名が OSM 名を含む / 0=その逆
            if a == b:
                rank = 2
            elif b.find(a) >= 0:
                rank = 1
            elif a.find(b) >= 0:
                rank = 0
            else:
                continue
            d = math.hypot(s["x"] - h["x"], s["z"] - h["z"])
            if d > LINK_FAR:
                continue
            if best is None or (rank, -d) > (best[0], -best[1]):
                best = (rank, d, s)
        if best:
            _, d, s = best
            h["osm"] = f"{s['name']}|{round(s['x'])}|{round(s['z'])}"
            pairs.append((s["name"], h["name"], h["k"], round(d)))
    return pairs


# 「場所」を持たない指定。標柱を立てると嘘になる。
# 「宮古島のパーントゥ」(重要無形民俗文化財)は宮古島の行事だが、DB の座標が
# 那覇に落ちるので、そのまま立てると那覇の史跡になってしまう（実測）。
NOT_A_PLACE = ("美術工芸品", "無形")

# 史跡名勝天然記念物の解説は、元の台帳ファイルの名前と振り仮名の記法が
# そのまま残っている: 「S47-5-174[[末吉宮]すえよしぐう]跡.txt:　末吉宮は…」
FILE_HEAD = re.compile(r"^[A-Z]?\d+-\d+-\d+.*?\.txt[:：]?\s*")
RUBY = re.compile(r"\[\[([^\]]+)\]([^\]]+)\]")


def clean_text(t, limit=360):
    """台帳ファイル由来の記法を読める文に直し、句点で切る。

    文字数で切ると「石畳道がつくられ、」のように文の途中で終わる（実測）。
    """
    t = FILE_HEAD.sub("", t or "").strip()
    t = RUBY.sub(lambda m: f"{m.group(1)}（{m.group(2)}）", t)
    if len(t) <= limit:
        return t
    cut = t.rfind("。", 0, limit + 1)
    return t[: cut + 1] if cut > limit // 2 else t[:limit] + "…"


CLUSTER_R = 120.0        # これ以内で名前の頭が揃うものは一つの屋敷とみなす(m)


def common_head(names):
    """名前の共通の頭。「新垣家住宅主屋」「新垣家住宅石垣」→「新垣家住宅」。"""
    head = names[0]
    for n in names[1:]:
        i = 0
        while i < len(head) and i < len(n) and head[i] == n[i]:
            i += 1
        head = head[:i]
    return head.rstrip(" \u3000　・")


def cluster(solo):
    """一つの屋敷の部材ごとに立つ標柱をまとめる。

    「新垣家住宅」は主屋・ヒンプン・フール・石垣・東池・南池の 6 件が
    半径 20m に登録されている。6 本立てると屋敷が標柱に埋もれる。
    """
    used, groups = set(), []
    for i, a in enumerate(solo):
        if i in used:
            continue
        mem = [a]
        used.add(i)
        for j, b in enumerate(solo):
            if j in used:
                continue
            if math.hypot(a["x"] - b["x"], a["z"] - b["z"]) > CLUSTER_R:
                continue
            if len(common_head([a["name"], b["name"]])) < 3:
                continue
            mem.append(b)
            used.add(j)
        head = common_head([m["name"] for m in mem]) if len(mem) > 1 else mem[0]["name"]

        # 代表は「その屋敷そのもの」を指すもの。長さで選ぶと、新垣家住宅で
        # いちばん詳しい「フール（豚小屋兼便所）」の解説が屋敷の説明になる
        def rank(m):
            return (m["name"] == head, m["name"].endswith("主屋"),
                    len(m.get("text", "")))
        lead = max(mem, key=rank)
        groups.append({
            "name": head or lead["name"],
            "k": "／".join(dict.fromkeys(m["k"] for m in mem)),
            "x": round(sum(m["x"] for m in mem) / len(mem), 1),
            "z": round(sum(m["z"] for m in mem) / len(mem), 1),
            "text": lead.get("text", ""),
            "url": lead["url"],
            **({"parts": [m["name"] for m in mem]} if len(mem) > 1 else {}),
        })
    return groups


def finish(root, out, sites_json, args):
    """突き合わせて書き出す。"""
    for r in out:
        if r.get("text"):
            r["text"] = clean_text(r["text"])
    sites = tile_sites(root, args.tiles)
    pairs = link(sites, out)
    live = [r for r in out if not r.get("skip")]
    solo = cluster([r for r in live if not r.get("osm")])
    live = [r for r in live if r.get("osm")] + solo
    print(f"\nOSM 史跡 {len(sites)}件と突き合わせ")
    for a, b, k, d in sorted(pairs):
        print(f"  {a} ← {b} [{k}] {d}m")
    print(f"  対応 {len(pairs)}件 / 独立して立てる {len(solo)}件")
    for r in solo:
        n = len(r.get("parts", []))
        print(f"    {r['name']} [{r['k']}]" + (f" ({n}件をまとめた)" if n else ""))
    print(f"  場所を持たない指定として除外 "
          f"{sum(1 for r in out if r.get('skip'))}件")

    outp = root / args.out
    outp.write_text(json.dumps(
        {"source": "文化庁 国指定文化財等データベース",
         "url": f"{BASE}/",
         "note": "文字情報のみ。画像は個別許諾が要るので取っていない。"
                 "x,z はこの world のワールド座標（m）。"
                 "osm があるものは、その OSM 史跡の標柱に解説を載せる",
         "sites": live}, ensure_ascii=False, separators=(",", ":")) + "\n")
    withtext = sum(1 for r in live if r.get("text"))
    print(f"→ {outp} ({outp.stat().st_size / 1024:.0f}KB) "
          f"／ {len(live)}件・解説文つき {withtext}件")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corridor", default="public/data/corridor.json")
    ap.add_argument("--index", default="public/data/tiles/index.json")
    ap.add_argument("--out", default="public/data/heritage.json")
    ap.add_argument("--tiles", default="public/data/tiles")
    ap.add_argument("--no-detail", action="store_true", help="解説文を取らない")
    ap.add_argument("--relink", action="store_true",
                    help="取得せず、既存 heritage.json の突き合わせだけやり直す")
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    meta = json.loads((root / args.corridor).read_text())["meta"]
    olat, olon = meta["originLat"], meta["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))
    keys = {(t[0], t[1]) for t in
            json.loads((root / args.index).read_text())["tiles"]}

    if args.relink:
        cur = json.loads(RAW.read_text())
        print(f"生データ {len(cur)} 件（{RAW}）を読み直して加工だけやり直す")
        finish(root, cur, None, args)
        return

    op = opener()
    ms = markers(op, CITY_BBOX)
    print(f"文化庁DB: {len(ms)} 件")

    out = []
    for i, m in enumerate(ms, 1):
        lat, lon = float(m["latitude"]), float(m["longitude"])
        x = (lon - olon) * m_lon
        z = -(lat - olat) * M_LAT
        if (round(x / 1000), round(z / 1000)) not in keys:
            continue
        rec = {
            "name": m.get("description", "").strip(),
            "k": m.get("subtype_name", "").strip(),
            "addr": m.get("address", "") if isinstance(m.get("address"), str) else "",
            "x": round(x, 1), "z": round(z, 1),
            "url": f"{BASE}/heritage/detail/{m['subtype']}/{m['code']}",
        }
        if not args.no_detail:
            rec["text"] = detail_text(op, m["subtype"], m["code"])
            time.sleep(0.5)                # 文化庁に連続で投げない
            if i % 10 == 0:
                print(f"  {i}/{len(ms)} …")
        out.append(rec)

    RAW.write_text(json.dumps(out, ensure_ascii=False) + "\n")
    print(f"世界のタイルに乗る {len(out)} 件 → 生データ {RAW}")
    finish(root, out, None, args)


if __name__ == "__main__":
    main()
