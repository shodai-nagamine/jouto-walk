#!/usr/bin/env python3
"""PLATEAU CityGML(建物 LOD1) + DEM(地形) → Three.js が読むワールドJSON。

既存の ~/dev/tools/blender-mcp/data/naha/ のパーサ資産を再利用する。
  parse_buildings / pick_footprint : gml_to_schematic.py
  load_points                      : dem_grid.py

実行例:
  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_world.py \
      --center 26.2233 127.7322 --size 1000 \
      --gml 39272568.gml 39272578.gml \
      --dem 392725_dem_55.gml \
      --out public/data/world.json

座標系: X=東, Z=南, Y=標高(m, T.P. 実値)。原点=中心点の地表。
"""
import argparse
import json
import math
import os
import sys

import numpy as np

NAHA = os.path.expanduser("~/dev/tools/blender-mcp/data/naha")
sys.path.insert(0, NAHA)

from dem_grid import load_points  # noqa: E402
from gml_to_schematic import fill_missing, parse_buildings  # noqa: E402

M_PER_DEG_LAT = 111320.0


def ring_area(pts):
    """靴ひも公式。符号付き面積(m^2)。"""
    n = len(pts)
    return 0.5 * sum(
        pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
        for i in range(n)
    )


def simplify(pts, tol=0.35):
    """連続する頂点がほぼ同一直線なら間引く(LOD1底面は冗長な頂点が多い)。"""
    if len(pts) < 4:
        return pts
    out = []
    n = len(pts)
    for i in range(n):
        ax, az = pts[(i - 1) % n]
        bx, bz = pts[i]
        cx, cz = pts[(i + 1) % n]
        # b の a→c 直線からの距離
        ux, uz = cx - ax, cz - az
        L = math.hypot(ux, uz)
        if L < 1e-9:
            continue
        d = abs(ux * (az - bz) - (ax - bx) * uz) / L
        if d > tol:
            out.append(pts[i])
    return out if len(out) >= 3 else pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--center", nargs=2, type=float, required=True, metavar=("LAT", "LON"))
    ap.add_argument("--size", type=int, default=1000, help="一辺のメートル数")
    ap.add_argument("--cell", type=int, default=5, help="地形グリッドの間隔(m)")
    ap.add_argument("--gml", nargs="+", required=True, help="建物CityGML(複数可)")
    ap.add_argument("--dem", nargs="*", default=[], help="地形CityGML(複数可)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    lat_c, lon_c = args.center
    half = args.size / 2.0
    m_lat = M_PER_DEG_LAT
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(lat_c))
    bbox = (
        lat_c - half / m_lat, lat_c + half / m_lat,
        lon_c - half / m_lon, lon_c + half / m_lon,
    )

    # ---- 地形 -------------------------------------------------------------
    n = args.size // args.cell + 1
    terrain = None
    for dem in args.dem:
        path = dem if os.path.isabs(dem) else os.path.join(NAHA, dem)
        pts = load_points(path, bbox)
        if not len(pts):
            print(f"  {os.path.basename(path)}: 範囲内に点なし", file=sys.stderr)
            continue
        # cell m 格子へ平均で集約
        gx = np.floor(((pts[:, 1] - lon_c) * m_lon + half) / args.cell).astype(int)
        gz = np.floor((-(pts[:, 0] - lat_c) * m_lat + half) / args.cell).astype(int)
        ok = (gx >= 0) & (gx < n) & (gz >= 0) & (gz < n)
        gx, gz, zv = gx[ok], gz[ok], pts[ok, 2]
        acc = np.zeros((n, n))
        cnt = np.zeros((n, n))
        np.add.at(acc, (gx, gz), zv)
        np.add.at(cnt, (gx, gz), 1)
        mask = cnt > 0
        seed = np.zeros((n, n))
        seed[mask] = acc[mask] / cnt[mask]
        cov = mask.sum() / (n * n)
        print(f"  {os.path.basename(path)}: {len(pts):,}点 被覆{cov:.1%}", file=sys.stderr)
        grid = fill_missing(seed, mask, relax=80)
        terrain = grid if terrain is None else np.maximum(terrain, grid)

    if terrain is None:
        print("地形DEMなし → 平坦(0m)にする", file=sys.stderr)
        terrain = np.zeros((n, n))

    # ---- 建物 -------------------------------------------------------------
    buildings = []
    for g in args.gml:
        path = g if os.path.isabs(g) else os.path.join(NAHA, g)
        recs, _ = parse_buildings(path, lod="lod1")
        kept = 0
        for r in recs:
            # 底面(複数ポリゴンのことがある)から最大面積のものを外周とみなす
            rings = []
            for poly in r["foot"]:
                xz = [
                    ((lo - lon_c) * m_lon + half, -(la - lat_c) * m_lat + half)
                    for la, lo in poly
                ]
                rings.append(xz)
            ring = max(rings, key=lambda p: abs(ring_area(p)))
            cx = sum(p[0] for p in ring) / len(ring)
            cz = sum(p[1] for p in ring) / len(ring)
            if not (0 <= cx <= args.size and 0 <= cz <= args.size):
                continue
            ring = simplify(ring)
            if ring_area(ring) < 0:  # 反時計回り(Three.js の Shape 向き)に揃える
                ring = ring[::-1]
            area = abs(ring_area(ring))
            if area < 4:  # 物置レベルは捨てる
                continue
            h = r["top_z"] - r["base_z"]
            if h < 1.5:
                continue
            buildings.append({
                "b": round(r["base_z"], 2),
                "h": round(h, 2),
                "a": round(area),
                "f": [round(v, 2) for p in ring for v in p],
            })
            kept += 1
        print(f"  {os.path.basename(path)}: 建物 {len(recs):,} → 採用 {kept:,}", file=sys.stderr)

    # 中心の地表高さ(スポーン基準)
    ci = n // 2
    world = {
        "meta": {
            "lat": lat_c, "lon": lon_c, "size": args.size,
            "cell": args.cell, "n": n,
            "groundAtCenter": round(float(terrain[ci, ci]), 2),
            "minZ": round(float(terrain.min()), 2),
            "maxZ": round(float(terrain.max()), 2),
        },
        # X が外側、Z が内側の row-major (terrain[x*n+z])
        "terrain": [round(float(v), 2) for v in terrain.reshape(-1)],
        "buildings": buildings,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(world, f, separators=(",", ":"))
    mb = os.path.getsize(args.out) / 1e6
    print(
        f"建物 {len(buildings):,} 棟 / 地形 {n}x{n} ({args.cell}m格子) "
        f"標高 {world['meta']['minZ']}〜{world['meta']['maxZ']}m\n"
        f"中心の地表 {world['meta']['groundAtCenter']}m\n"
        f"→ {args.out} ({mb:.1f}MB)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
