#!/usr/bin/env python3
"""OSM(Overpass) の抽出を、タイル展開ぶんまとめて 1 回で取る。

これまで curl を手で叩いていたので、バス停・地名・信号・歩道が城東小まわりの
1km 四方しか無く、隣のタイルが信号 0 基・バス停 0 基になっていた。範囲を
corridor 全体に広げると 1 発では 504 が返るので、緯度で帯に割って取り、
重複を除いて結合する。

  python3 tools/fetch_osm.py                # 全部
  python3 tools/fetch_osm.py footways named # 指定したものだけ
  python3 tools/fetch_osm.py --dry-run      # クエリだけ書き出す

出力は ~/dev/tools/blender-mcp/data/naha/ の naha_*_osm.json と、
実際に投げたクエリを写した naha_*_osm.query.txt。
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

NAHA = os.path.expanduser("~/dev/tools/blender-mcp/data/naha")
ENDPOINT = "https://overpass-api.de/api/interpreter"

# corridor.json の bbox(那覇空港〜石嶺、路線±600m)に、タイルが中心から
# ±500m はみ出すぶんの余白を足した範囲。tools/build_world.py が各タイルの
# bbox で切るので、広いぶんには害がない。
BBOX = (26.182, 127.638, 26.246, 127.742)

# 名前は build_world.py の引数に対応する。timeout は Overpass 側の秒数。
QUERIES = {
    # --bus
    "bus": (30, [
        'node["highway"="bus_stop"]{bbox};',
        'node["public_transport"="platform"]["bus"="yes"]{bbox};',
    ], "out body;"),
    # --signals
    "signals": (90, [
        'node["highway"="traffic_signals"]{bbox};',
        'node["crossing"="traffic_signals"]{bbox};',
    ], "out body;"),
    # --footways。歩道と車道の区別を持たない PLATEAU の tran を補う
    "footways": (300, [
        'way["highway"~"^(footway|path|pedestrian|steps|living_street)$"]{bbox};',
        'way["sidewalk"]{bbox};',
        'way["highway"]["width"]{bbox};',
    ], "out geom tags;"),
    # --osm-named。市議会リンクの地名辞書に使う
    "named": (300, [
        'node["name"]{bbox};',
        'way["name"]{bbox};',
    ], "out center tags;"),
    # --parks。["name"] で絞らないのが要点(那覇の街区公園と校庭は半数以上が無名で、
    # 名前で絞ると見た目に一番効く大きなグラウンドが軒並み落ちる)
    "parks": (300, [
        'way["leisure"="park"]{bbox};',
        'way["leisure"="garden"]{bbox};',
        'way["leisure"="playground"]{bbox};',
        'way["leisure"="pitch"]{bbox};',
    ], "out geom tags;"),
}


def build_query(name, bbox):
    timeout, parts, out = QUERIES[name]
    b = "({:.4f},{:.4f},{:.4f},{:.4f})".format(*bbox)
    body = "\n".join("  " + p.replace("{bbox}", b) for p in parts)
    return f"[out:json][timeout:{timeout}];\n(\n{body}\n);\n{out}\n"


def bands(bbox, k):
    """bbox を緯度で k 本の帯に割る。境界の地物が落ちないよう少し重ねる。"""
    s, w, n, e = bbox
    step = (n - s) / k
    lap = min(0.002, step / 4)          # 約 220m の重なり
    out = []
    for i in range(k):
        lo = s + step * i - (lap if i else 0)
        hi = s + step * (i + 1) + (lap if i < k - 1 else 0)
        out.append((round(lo, 4), w, round(hi, 4), e))
    return out


def post(query, timeout_s):
    req = urllib.request.Request(
        ENDPOINT, data=query.encode("utf-8"),
        headers={"User-Agent": "jouto-walk/1.0 (PLATEAU world builder)"},
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch(name, bbox, max_split=4):
    """1 発で取り、駄目なら帯に割って結合する。"""
    for k in range(1, max_split + 1):
        chunks = [bbox] if k == 1 else bands(bbox, k)
        label = "1発" if k == 1 else f"{k}分割"
        seen, elements = set(), []
        try:
            for i, bb in enumerate(chunks, 1):
                q = build_query(name, bb)
                timeout = QUERIES[name][0]
                if k > 1:
                    print(f"    {label} {i}/{k} lat {bb[0]}〜{bb[2]}", file=sys.stderr)
                data = post(q, timeout + 60)
                for el in data.get("elements", []):
                    key = (el.get("type"), el.get("id"))
                    if key in seen:
                        continue
                    seen.add(key)
                    elements.append(el)
                if i < len(chunks):
                    time.sleep(3)       # Overpass に連続で投げない
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            print(f"    {label} 失敗 ({code or e}) → 分割を増やす", file=sys.stderr)
            time.sleep(8)
            continue
        return elements, k
    raise RuntimeError(f"{name}: {max_split} 分割まで試したが取れなかった")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*", default=[], help=f"既定は全部: {', '.join(QUERIES)}")
    ap.add_argument("--dry-run", action="store_true", help="クエリの書き出しだけ")
    ap.add_argument("--out-dir", default=NAHA)
    args = ap.parse_args()

    names = args.names or list(QUERIES)
    bad = [n for n in names if n not in QUERIES]
    if bad:
        sys.exit(f"知らない名前: {', '.join(bad)}")

    print(f"範囲 lat {BBOX[0]}〜{BBOX[2]} / lon {BBOX[1]}〜{BBOX[3]}", file=sys.stderr)
    for name in names:
        path = os.path.join(args.out_dir, f"naha_{name}_osm.json")
        qpath = os.path.join(args.out_dir, f"naha_{name}_osm.query.txt")
        # 実際に投げたのは分割後のクエリだが、記録は「本来の 1 発ぶん」を残す。
        # 分割は取得の都合なので、範囲の記録としてはこちらが正しい。
        query = build_query(name, BBOX)
        with open(qpath, "w") as f:
            f.write(query)
        if args.dry_run:
            print(f"  {name}: クエリのみ書き出し → {os.path.basename(qpath)}", file=sys.stderr)
            continue

        print(f"  {name} …", file=sys.stderr)
        t0 = time.time()
        elements, k = fetch(name, BBOX)
        # 既存を .bak に退避してから置き換える(取り直しに失敗しても戻せる)
        if os.path.exists(path):
            os.replace(path, path + ".bak")
        with open(path, "w") as f:
            json.dump({"version": 0.6, "elements": elements}, f)
        mb = os.path.getsize(path) / 1e6
        print(f"  {name}: {len(elements):,}件 {mb:.1f}MB "
              f"({'1発' if k == 1 else f'{k}分割'} / {time.time() - t0:.0f}秒)", file=sys.stderr)


if __name__ == "__main__":
    main()
