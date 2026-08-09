#!/usr/bin/env python3
"""OSM の川の中心線を、水面のリボンにして public/data/rivers.json に書く。

OSM の那覇には `waterway=riverbank` の面が1つも無く、川は way(線)しかない。
池のように面を張れないので、線を幅で膨らませてリボンにする。

**川はタイルに分けない。** 水面の高さは川筋に沿って変わるので、タイルごとに
決めると継ぎ目で段差になる（池で実際に踏んだ。龍潭が 110.80m と 98.93m に
割れた）。世界ぜんぶを1本の折れ線として持ち、点ごとに高さを持たせる。

高さは DEM から拾ったうえで **下流に向かって単調に落とす**。素の DEM は
橋・護岸・ノイズで上下するので、そのまま使うと水が坂を登る。

  tools/build_rivers.py

出力: public/data/rivers.json
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAHA = os.path.expanduser("~/dev/tools/blender-mcp/data/naha")
sys.path.insert(0, NAHA)
from dem_grid import load_points  # noqa: E402

DEMS = ["392725_dem_00.gml", "392725_dem_05.gml",
        "392725_dem_50.gml", "392725_dem_55.gml"]
SRC = os.path.join(NAHA, "naha_rivers_osm.json")
OUT = os.path.join(ROOT, "public/data/rivers.json")

M_LAT = 111320.0
CELL = 5.0
# 幅(m)。OSM に width の指定が1件も無いので種別で決める。
# 那覇の二級河川は護岸の内側で 15〜30m、街なかの水路(ガーブ川など)はもっと細い
WIDTH = {"river": 18.0, "canal": 10.0, "stream": 5.0}
# 名前で分かっているものは実際に近い幅にする
WIDTH_BY_NAME = {"国場川": 46.0, "安里川": 24.0, "安謝川": 20.0, "牧港川": 18.0}
STEP = 12.0        # 川筋を刻む間隔(m)
DROP = 0.35        # 川底を水面からどれだけ下げるか(m)


def main():
    meta = json.load(open(os.path.join(ROOT, "public/data/corridor.json")))["meta"]
    olat, olon = meta["originLat"], meta["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))

    d = json.load(open(SRC, encoding="utf-8"))
    ways = []
    for e in d.get("elements", []):
        t = e.get("tags") or {}
        kind = t.get("waterway")
        if kind not in WIDTH:
            continue
        g = [p for p in (e.get("geometry") or []) if p]
        if len(g) < 2:
            continue
        name = t.get("name", "")
        w = WIDTH_BY_NAME.get(name, WIDTH[kind])
        pts = [((p["lon"] - olon) * m_lon, -(p["lat"] - olat) * M_LAT) for p in g]
        ways.append({"name": name, "k": kind, "w": w, "pts": pts,
                     "lat": [p["lat"] for p in g], "lon": [p["lon"] for p in g]})
    if not ways:
        sys.exit("川が1本も無い")
    print(f"川 {len(ways)}本 / 点 {sum(len(w['pts']) for w in ways):,}", file=sys.stderr)

    lat = [v for w in ways for v in w["lat"]]
    lon = [v for w in ways for v in w["lon"]]
    pad = 0.002
    bbox = (min(lat) - pad, max(lat) + pad, min(lon) - pad, max(lon) + pad)
    pts = []
    for name in DEMS:
        path = os.path.join(NAHA, name)
        if not os.path.exists(path):
            continue
        pts.append(load_points(path, bbox, verbose=False))
    if not pts:
        sys.exit("DEM が1枚も無い")
    pts = np.concatenate(pts)
    print(f"  DEM {len(pts):,}点", file=sys.stderr)

    gx = ((pts[:, 1] - bbox[2]) * m_lon / CELL).astype(np.int32)
    gz = ((pts[:, 0] - bbox[0]) * M_LAT / CELL).astype(np.int32)
    nx, nz = gx.max() + 1, gz.max() + 1
    acc = np.zeros((nz, nx))
    cnt = np.zeros((nz, nx))
    np.add.at(acc, (gz, gx), pts[:, 2])
    np.add.at(cnt, (gz, gx), 1)
    grid = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan)

    ox = (bbox[2] - olon) * m_lon
    oz = -(bbox[0] - olat) * M_LAT

    def dem_at(x, z):
        """世界座標(x,z) の DEM。無ければ近傍を少し広げて探す。"""
        cj = int(round((x - ox) / CELL))
        ci = int(round((oz - z) / CELL))
        for r in range(0, 4):
            for i in range(ci - r, ci + r + 1):
                for j in range(cj - r, cj + r + 1):
                    if 0 <= i < nz and 0 <= j < nx and np.isfinite(grid[i, j]):
                        return float(grid[i, j])
        return None

    out = []
    stats = []
    for w in ways:
        # 一定間隔で刻み直す(OSM の点は疎密が大きい)
        src = w["pts"]
        acc_d = 0.0
        samp = [src[0]]
        for i in range(len(src) - 1):
            seg = math.dist(src[i], src[i + 1])
            if seg <= 0:
                continue
            t = 0.0
            while acc_d + (seg - t) >= STEP:
                t += STEP - acc_d
                f = t / seg
                samp.append((src[i][0] + (src[i + 1][0] - src[i][0]) * f,
                             src[i][1] + (src[i + 1][1] - src[i][1]) * f))
                acc_d = 0.0
            acc_d += seg - t
        if samp[-1] != src[-1]:
            samp.append(src[-1])
        if len(samp) < 2:
            continue

        ys = []
        for (x, z) in samp:
            v = dem_at(x, z)
            ys.append(v)
        known = [v for v in ys if v is not None]
        if not known:
            continue
        # 穴を埋める
        last = known[0]
        for i in range(len(ys)):
            if ys[i] is None:
                ys[i] = last
            else:
                last = ys[i]

        # **下流に向かって単調に落とす。** どちらが下流かは端の標高で決める。
        # 走らせる向きを取り違えると川が坂を登るどころではなくなる
        # (最初この向きを逆にしたうえ二度掛けしていて、水面が地形から
        #  ±65m ずれた。二度掛けは全体を最小値へ潰す)。
        #
        # 下流の向きに走らせた累積最小を採ると、
        #   ・下流へ向かって上がらない
        #   ・どの点でも元の DEM 以下（水が地面から浮かない）
        # の両方が同時に満たせる。
        if ys[0] > ys[-1]:
            ys = list(np.minimum.accumulate(ys))            # 始点が上流
        else:
            ys = list(np.minimum.accumulate(ys[::-1]))[::-1]  # 始点が下流
        ys = [round(float(v), 2) for v in ys]

        f = []
        for (x, z), y in zip(samp, ys):
            f.extend([round(x, 1), round(z, 1), y])
        out.append({"name": w["name"], "k": w["k"], "w": w["w"], "f": f})
        if w["name"]:
            stats.append((w["name"], round(min(ys), 1), round(max(ys), 1), len(samp)))

    total = 0.0
    for r in out:
        p = r["f"]
        for i in range(0, len(p) - 3, 3):
            total += math.dist((p[i], p[i + 1]), (p[i + 3], p[i + 4]))
    data = {"meta": {"drop": DROP, "note": "点は x,z,y の3つ組。w は水面の幅(m)"},
            "rivers": out}
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)

    seen = {}
    for n, lo, hi, c in stats:
        a = seen.setdefault(n, [lo, hi, 0])
        a[0] = min(a[0], lo)
        a[1] = max(a[1], hi)
        a[2] += c
    print(f"\n{'名前':<10} {'最低':>7} {'最高':>7} {'点':>6}", file=sys.stderr)
    for n in sorted(seen, key=lambda k: -seen[k][2])[:10]:
        lo, hi, c = seen[n]
        print(f"{n:<10} {lo:7.1f} {hi:7.1f} {c:6d}", file=sys.stderr)
    print(f"\n{OUT}: {len(out)}本 / 総延長 {total / 1000:.1f}km / "
          f"{os.path.getsize(OUT) / 1000:.0f}KB", file=sys.stderr)


if __name__ == "__main__":
    main()
