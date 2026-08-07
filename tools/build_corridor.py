#!/usr/bin/env python3
"""路線全体で1つになるもの(線路・駅・バス路線)を corridor.json に出す。

タイル(build_world.py)に入れてはいけないものを分ける。理由は、これらが
タイルをまたぐため。タイルに分割すると「どのタイルが読み込まれているか」で
列車やバスの経路が変わってしまう。データ量は小さいので全域を1ファイルで持つ。

座標系はタイルと違い、**全体原点からのメートル**をそのまま入れる
(タイルは 0..size のローカル座標で、描画側が HALF を引いてから offset を足す)。
corridor は最初から引き算済みの値なので、描画側はそのまま使えばよい。
  x = (lon - lon_o) * m_lon        X=東
  z = -(lat - lat_o) * m_lat       Z=南

実行例:
  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_corridor.py \
      --origin 26.2233 127.7322 \
      --rail naha_railway.geojson --stations naha_station.czml \
      --bus-routes naha_busroutes_osm.json \
      --out public/data/corridor.json
"""
import argparse
import json
import math
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)

from build_world import M_PER_DEG_LAT, NAHA, stitch  # noqa: E402


def clip_rect(ax, az, bx, bz, x0, z0, x1, z1):
    """線分を矩形 [x0,x1]x[z0,z1] で切る(Liang-Barsky)。外なら None。

    build_world.clip_segment は正方形 [lo,hi] 専用なので、こちらは辺ごとに
    範囲を持てるようにした版。corridor の範囲は路線に沿って細長くなる。
    """
    dx, dz = bx - ax, bz - az
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, ax - x0), (dx, x1 - ax), (-dz, az - z0), (dz, z1 - az)):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return (ax + t0 * dx, az + t0 * dz, ax + t1 * dx, az + t1 * dz)


def runs_in_rect(xz, rect, gap=0.5):
    """折れ線を矩形で切り、連続する区間ごとに分ける。"""
    out, cur = [], []
    for i in range(len(xz) - 1):
        seg = clip_rect(*xz[i], *xz[i + 1], *rect)
        if seg is None:
            if len(cur) >= 2:
                out.append(cur)
            cur = []
            continue
        ax, az, bx, bz = seg
        if not cur:
            cur = [(ax, az)]
        elif abs(cur[-1][0] - ax) > gap or abs(cur[-1][1] - az) > gap:
            if len(cur) >= 2:
                out.append(cur)
            cur = [(ax, az)]
        cur.append((bx, bz))
    if len(cur) >= 2:
        out.append(cur)
    return out


def length(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def parse_rail_all(path, to_xz):
    """鉄道 GeoJSON の線形を全長ぶん取り出す(矩形で切らない)。

    細切れの feature を繋いでから返す。切らないのは、corridor が
    「路線全体で1つ」だから。タイル側の parse_rail とはそこが違う。
    """
    d = json.load(open(path, encoding="utf-8"))
    raw = []
    for f in d.get("features", []):
        g = f.get("geometry") or {}
        lines = g.get("coordinates") or []
        if g.get("type") == "LineString":
            lines = [lines]
        for line in lines:
            pts = [to_xz(c[1], c[0]) for c in line]
            if len(pts) >= 2:
                raw.append(pts)
    return [p for p in stitch(raw) if len(p) >= 2]


def parse_stations_all(path, to_xz, rect):
    """駅 CZML から駅名と位置を取り出す。高さは地盤高なので使わない。"""
    out = []
    for p in json.load(open(path, encoding="utf-8")):
        pos = (p.get("position") or {}).get("cartographicDegrees")
        if not pos:
            continue
        x, z = to_xz(pos[1], pos[0])
        if not (rect[0] <= x <= rect[2] and rect[1] <= z <= rect[3]):
            continue
        out.append({
            "name": p.get("name") or (p.get("properties") or {}).get("駅名") or "",
            "x": round(x, 2), "z": round(z, 2),
        })
    return out


def parse_bus_routes_all(path, to_xz, rect, max_routes, min_len=300.0):
    """OSM のバス路線リレーションを走行経路にする。

    メンバーの way は順に並んでいるが向きは揃っていないので、端点の近さで
    反転させながら繋ぐ。そのあと corridor の矩形で切り、いちばん長く続く
    区間だけを採る(出入りを繰り返す破片は使わない)。
    """
    d = json.load(open(path, encoding="utf-8"))
    cands = []
    for rel in d.get("elements", []):
        t = rel.get("tags") or {}
        chain = []
        for m in rel.get("members", []):
            if m.get("type") != "way" or m.get("role", "") not in ("", "forward", "backward"):
                continue
            g = [p for p in (m.get("geometry") or []) if p]
            if len(g) < 2:
                continue
            pts = [(p["lon"], p["lat"]) for p in g]
            if not chain:
                chain = pts
                continue
            a = chain[-1]
            d0 = (a[0] - pts[0][0]) ** 2 + (a[1] - pts[0][1]) ** 2
            d1 = (a[0] - pts[-1][0]) ** 2 + (a[1] - pts[-1][1]) ** 2
            if d1 < d0:
                pts = pts[::-1]
            chain.extend(pts[1:])
        if len(chain) < 2:
            continue

        runs = runs_in_rect([to_xz(lat, lon) for lon, lat in chain], rect)
        if not runs:
            continue
        best = max(runs, key=length)
        L = length(best)
        if L < min_len:                   # かすめるだけの路線は使わない
            continue
        cands.append({
            "ref": t.get("ref", ""), "name": t.get("name", ""),
            "op": t.get("operator", ""), "len": L, "pts": best,
        })

    # 同じ系統番号は往復で2本あるので、長いほうを1本だけ残す
    byref = {}
    for c in sorted(cands, key=lambda c: -c["len"]):
        byref.setdefault(c["ref"], c)
    picked = sorted(byref.values(), key=lambda c: -c["len"])[:max_routes]
    return [{
        "ref": c["ref"], "name": c["name"], "op": c["op"],
        "len": round(c["len"], 1),
        "f": [round(v, 2) for p in c["pts"] for v in p],
    } for c in picked]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--origin", nargs=2, type=float, required=True,
                    metavar=("LAT", "LON"), help="全タイル共通の原点")
    ap.add_argument("--rail", default="", help="鉄道 GeoJSON(モノレール線形)")
    ap.add_argument("--stations", default="", help="鉄道駅 CZML")
    ap.add_argument("--bus-routes", default="", help="バス路線 (OSM route relation JSON)")
    ap.add_argument("--margin", type=float, default=600.0,
                    help="線路からこの距離までを corridor の範囲とする(m)")
    ap.add_argument("--max-routes", type=int, default=6, help="走らせる路線数")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    lat_o, lon_o = args.origin
    m_lat = M_PER_DEG_LAT
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(lat_o))

    def to_xz(lat, lon):
        return ((lon - lon_o) * m_lon, -(lat - lat_o) * m_lat)

    def path_of(p):
        return p if os.path.isabs(p) else os.path.join(NAHA, p)

    # ---- 線路(全長) -------------------------------------------------------
    rail = parse_rail_all(path_of(args.rail), to_xz) if args.rail else []
    for p in sorted(rail, key=length, reverse=True):
        print(f"  線路: {len(p)}点 {length(p):,.0f}m", file=sys.stderr)

    # ---- corridor の範囲は線路の広がりから決める --------------------------
    if rail:
        xs = [x for p in rail for x, _ in p]
        zs = [z for p in rail for _, z in p]
        rect = (min(xs) - args.margin, min(zs) - args.margin,
                max(xs) + args.margin, max(zs) + args.margin)
    else:
        rect = (-args.margin, -args.margin, args.margin, args.margin)
    print(f"  範囲: X {rect[0]:,.0f}〜{rect[2]:,.0f} / Z {rect[1]:,.0f}〜{rect[3]:,.0f}"
          f" ({rect[2] - rect[0]:,.0f}m × {rect[3] - rect[1]:,.0f}m)", file=sys.stderr)

    stations = parse_stations_all(path_of(args.stations), to_xz, rect) if args.stations else []
    print(f"  駅: {len(stations)}", file=sys.stderr)

    routes = (parse_bus_routes_all(path_of(args.bus_routes), to_xz, rect, args.max_routes)
              if args.bus_routes else [])
    for r in routes:
        print(f"  バス {r['ref']}: {r['len']:,.0f}m {r['name']}", file=sys.stderr)

    out = {
        "meta": {
            "originLat": lat_o, "originLon": lon_o,
            "margin": args.margin,
            # 描画側へ: この座標は全体原点からのメートル。HALF を引く必要はない。
            "coords": "global",
            "bbox": [round(v, 2) for v in rect],
        },
        "rail": [[round(v, 2) for p in path for v in p] for path in rail],
        "stations": stations,
        "busRoutes": routes,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"→ {args.out} ({os.path.getsize(args.out):,} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
