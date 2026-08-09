#!/usr/bin/env python3
"""水面ごとの水位を **1回だけ** 決めて対応表に書き出す。

タイルごとに地形から水位を決めると、タイルをまたぐ池で値が割れる。
実測で龍潭が t_-1_0 では 110.80m、t_-2_0 では 98.93m になり、境界で
12m の段差ができた（タイルは自分の中の地形しか見ていないため）。

水位は「池ごとに1つ」でなければいけないので、ここで世界ぜんぶの DEM を
1回読んで、OSM の要素 id ごとに1つの値を出す。build_world.py はこの表を
引くだけにする。判断を取得側に置いて対応表を印字するのは、この案件の作法
（史跡と文化財の突き合わせと同じ）。

  tools/build_water_levels.py

出力: ~/dev/tools/blender-mcp/data/naha/naha_water_levels.json
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NAHA = os.path.expanduser("~/dev/tools/blender-mcp/data/naha")
sys.path.insert(0, NAHA)
from dem_grid import load_points  # noqa: E402

DEMS = ["392725_dem_00.gml", "392725_dem_05.gml",
        "392725_dem_50.gml", "392725_dem_55.gml"]

WATER = os.path.join(NAHA, "naha_water_osm.json")
OUT = os.path.join(NAHA, "naha_water_levels.json")

# 水位に採る分位。最低値だと池底の1点に引きずられて水が痩せ、
# 平均だと岸より高くなって溢れる。
Q = 0.10
CELL = 5.0        # 標高を引くときの格子(m)


def ring_of(e):
    g = [p for p in (e.get("geometry") or []) if p]
    if not g and e.get("type") == "relation":
        g = [p for m in e.get("members", []) for p in (m.get("geometry") or []) if p]
    return g


def point_in_ring(px, pz, ring):
    n = len(ring)
    inside = False
    j = n - 1
    for i in range(n):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > pz) != (zj > pz) and px < (xj - xi) * (pz - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def main():
    d = json.load(open(WATER, encoding="utf-8"))
    els = []
    for e in d.get("elements", []):
        t = e.get("tags") or {}
        nat = t.get("natural")
        if not (nat in ("water", "wetland") or t.get("landuse") == "reservoir"
                or t.get("waterway") == "riverbank"):
            continue
        g = ring_of(e)
        if len(g) < 3:
            continue
        els.append((e, t, g))
    if not els:
        sys.exit("水面が1つも無い")

    lat = [p["lat"] for _, _, g in els for p in g]
    lon = [p["lon"] for _, _, g in els for p in g]
    pad = 0.002
    bbox = (min(lat) - pad, max(lat) + pad, min(lon) - pad, max(lon) + pad)
    print(f"水面 {len(els)}面 / DEM を読む範囲 "
          f"lat {bbox[0]:.4f}〜{bbox[1]:.4f} lon {bbox[2]:.4f}〜{bbox[3]:.4f}",
          file=sys.stderr)

    pts = []
    for name in DEMS:
        path = os.path.join(NAHA, name)
        if not os.path.exists(path):
            print(f"  {name}: 無い（飛ばす）", file=sys.stderr)
            continue
        p = load_points(path, bbox, verbose=False)
        print(f"  {name}: {len(p):,}点", file=sys.stderr)
        pts.append(p)
    if not pts:
        sys.exit("DEM が1枚も無い")
    pts = np.concatenate(pts)

    # 緯度経度をメートルに直してから格子に落とす。原点は範囲の南西角
    olat, olon = bbox[0], bbox[2]
    M = 111320.0
    mlon = M * math.cos(math.radians((bbox[0] + bbox[1]) / 2))
    gx = ((pts[:, 1] - olon) * mlon / CELL).astype(np.int32)
    gz = ((pts[:, 0] - olat) * M / CELL).astype(np.int32)
    nx, nz = gx.max() + 1, gz.max() + 1
    acc = np.zeros((nz, nx))
    cnt = np.zeros((nz, nx))
    np.add.at(acc, (gz, gx), pts[:, 2])
    np.add.at(cnt, (gz, gx), 1)
    grid = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan)
    print(f"  格子 {nz}x{nx} ({CELL}m) 被覆 "
          f"{np.isfinite(grid).mean():.1%}", file=sys.stderr)

    levels = {}
    rows = []
    for e, t, g in els:
        ring = [(((p["lon"] - olon) * mlon), ((p["lat"] - olat) * M)) for p in g]
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        samp = []
        steps = 40
        for i in range(steps + 1):
            for j in range(steps + 1):
                px = xs and min(xs) + (max(xs) - min(xs)) * i / steps
                pz = zs and min(zs) + (max(zs) - min(zs)) * j / steps
                if not point_in_ring(px, pz, ring):
                    continue
                ci = int(round(pz / CELL))
                cj = int(round(px / CELL))
                if 0 <= ci < nz and 0 <= cj < nx and np.isfinite(grid[ci, cj]):
                    samp.append(float(grid[ci, cj]))
        key = f"{e['type']}/{e['id']}"
        if not samp:
            rows.append((t.get("name", ""), key, None, 0, 0, 0, 0, 0))
            continue
        samp.sort()
        lv = samp[max(0, int(len(samp) * Q) - 1)]
        levels[key] = round(lv, 2)
        pc = lambda q: samp[max(0, min(len(samp) - 1, int(len(samp) * q)))]
        rows.append((t.get("name", ""), key, round(lv, 2), len(samp),
                     round(pc(0.10), 2), round(pc(0.50), 2), round(pc(0.90), 2),
                     round(samp[-1], 2)))

    json.dump(levels, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # 対応表を印字する。目視できるし再現する
    rows.sort(key=lambda r: (r[2] is None, -(r[2] or 0)))
    print(f"\n{'名前':<14} {'標本':>6} {'p10':>7} {'p50':>7} {'p90':>7} {'max':>7}",
          file=sys.stderr)
    for name, key, lv, n, p10, p50, p90, mx in rows:
        if lv is None:
            continue
        print(f"{name or '(無名)':<14} {n:6d} {p10:7.2f} {p50:7.2f} {p90:7.2f} {mx:7.2f}",
              file=sys.stderr)
    miss = sum(1 for r in rows if r[2] is None)
    print(f"\n{OUT}: {len(levels)}面（水位を出せなかった {miss}面）", file=sys.stderr)


if __name__ == "__main__":
    main()
