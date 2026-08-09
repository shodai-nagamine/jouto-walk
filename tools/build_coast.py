#!/usr/bin/env python3
"""OSM の海岸線を、世界座標の折れ線にして public/data/coast.json に書く。

海面をどこに張るかを決めるために要る。世界の外周は 80% が標高 0〜12m で、
受け皿(外へ 1500m、12m 下がる)をそのまま海面 0m と突き合わせると、
内陸側まで海になってしまう（実測）。海と陸の別は地形からは出せない。

OSM の `natural=coastline` は「**進行方向の左が陸**」という約束の線。
この向きがあるので、点がどちら側かを見れば海か陸かが分かる。面ではないので、
ここでは鎖に繋ぐところまでをやり、判定は描画側で行う。

  tools/build_coast.py

出力: public/data/coast.json
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAHA = os.path.expanduser("~/dev/tools/blender-mcp/data/naha")
SRC = os.path.join(NAHA, "naha_coast_osm.json")
OUT = os.path.join(ROOT, "public/data/coast.json")

M_LAT = 111320.0
PAD = 2200.0        # 世界の外側どこまで持つか(受け皿の 1500m + 余白)
TOL = 1.0           # 端点がこの距離なら繋ぐ(m)
SIMP = 3.0          # 折れ線の間引き(m)。海陸の判定にしか使わないので粗くてよい


def simplify(pts, tol):
    """Douglas-Peucker。再帰は深くならない(海岸線1本は数百点)。"""
    if len(pts) < 3:
        return pts
    ax, az = pts[0]
    bx, bz = pts[-1]
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    worst, wi = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, pz = pts[i]
        if L2 == 0:
            d = math.hypot(px - ax, pz - az)
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
            d = math.hypot(px - (ax + t * dx), pz - (az + t * dz))
        if d > worst:
            worst, wi = d, i
    if worst <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[:wi + 1], tol)[:-1] + simplify(pts[wi:], tol)


def main():
    meta = json.load(open(os.path.join(ROOT, "public/data/corridor.json")))["meta"]
    olat, olon = meta["originLat"], meta["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))

    d = json.load(open(SRC, encoding="utf-8"))
    ways = []
    for e in d.get("elements", []):
        g = [p for p in (e.get("geometry") or []) if p]
        if len(g) < 2:
            continue
        ways.append([((p["lon"] - olon) * m_lon, -(p["lat"] - olat) * M_LAT)
                     for p in g])
    if not ways:
        sys.exit("海岸線が1本も無い")
    print(f"海岸線 {len(ways)}本 / 点 {sum(len(w) for w in ways):,}", file=sys.stderr)

    # 端点で繋ぐ。**向きは反転させない**（左が陸という約束が壊れる）
    chains = []
    used = [False] * len(ways)
    heads = {}
    for i, w in enumerate(ways):
        heads.setdefault((round(w[0][0], 1), round(w[0][1], 1)), []).append(i)
    for i, w in enumerate(ways):
        if used[i]:
            continue
        used[i] = True
        chain = list(w)
        while True:
            k = (round(chain[-1][0], 1), round(chain[-1][1], 1))
            nxt = None
            for j in heads.get(k, []):
                if not used[j]:
                    nxt = j
                    break
            if nxt is None:
                break
            used[nxt] = True
            chain.extend(ways[nxt][1:])
        chains.append(chain)
    print(f"鎖に繋いだ: {len(chains)}本", file=sys.stderr)

    # 世界＋余白で切る。またぐ所は切れ目で分ける
    b = json.load(open(os.path.join(ROOT, "public/data/tiles/index.json")))["tiles"]
    txs = [t[0] for t in b]
    tzs = [t[1] for t in b]
    lo_x = (min(txs) - 0.5) * 1000 - PAD
    hi_x = (max(txs) + 0.5) * 1000 + PAD
    lo_z = (min(tzs) - 0.5) * 1000 - PAD
    hi_z = (max(tzs) + 0.5) * 1000 + PAD

    def inside(p):
        return lo_x <= p[0] <= hi_x and lo_z <= p[1] <= hi_z

    out = []
    for ch in chains:
        cur = []
        for p in ch:
            if inside(p):
                cur.append(p)
            else:
                if len(cur) >= 2:
                    out.append(cur)
                cur = []
        if len(cur) >= 2:
            out.append(cur)

    out = [simplify(c, SIMP) for c in out]
    out = [c for c in out if len(c) >= 2]
    total = sum(
        sum(math.dist(c[i], c[i + 1]) for i in range(len(c) - 1)) for c in out)
    print(f"世界＋{PAD:.0f}m で切って {len(out)}本 / 点 {sum(len(c) for c in out):,} "
          f"/ 総延長 {total / 1000:.1f}km", file=sys.stderr)

    data = {
        "meta": {
            "originLat": olat, "originLon": olon,
            "bbox": [round(lo_x, 1), round(lo_z, 1), round(hi_x, 1), round(hi_z, 1)],
            "note": "natural=coastline。進行方向の左が陸・右が海",
        },
        "lines": [[round(v, 1) for p in c for v in p] for c in out],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{OUT}: {os.path.getsize(OUT) / 1000:.0f}KB", file=sys.stderr)


if __name__ == "__main__":
    main()
