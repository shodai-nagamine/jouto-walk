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
import xml.etree.ElementTree as ET

import numpy as np

NAHA = os.path.expanduser("~/dev/tools/blender-mcp/data/naha")
sys.path.insert(0, NAHA)

from dem_grid import load_points  # noqa: E402
from gml_to_schematic import (  # noqa: E402
    fill_missing, local_name, parse_buildings, polygons_of,
)

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


def parse_roads(gml_path):
    """交通(tran)モデルから道路の面ポリゴンを取り出す。

    PLATEAU の tran は LOD1 = lod1MultiSurface で、道路の「面」がそのまま入っている
    (中心線ではない)。高さは一律 0 なので平面として扱い、描画時に地形へ伏せる。
    """
    out = []
    for _ev, el in ET.iterparse(gml_path, events=("end",)):
        if local_name(el.tag) != "Road":
            continue
        fn = ""
        for ch in el.iter():
            if local_name(ch.tag) == "function":
                fn = (ch.text or "").strip()
                break
        for poly in polygons_of(el):
            out.append((poly, fn))
        el.clear()
    return out


def clip_segment(ax, az, bx, bz, lo, hi):
    """線分を [lo,hi]x[lo,hi] の矩形で切る(Liang-Barsky)。外なら None。"""
    dx, dz = bx - ax, bz - az
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, ax - lo), (dx, hi - ax), (-dz, az - lo), (dz, hi - az)):
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


def stitch(lines, tol=3.0):
    """端点が接する折れ線どうしを繋ぐ(必要なら反転する)。

    鉄道 GeoJSON は路線が細切れの feature で入っているので、繋がないと
    「813m / 82m / 130m」のような断片になり、列車が短い往復をしてしまう。
    """
    rest = [list(l) for l in lines if len(l) >= 2]
    out = []
    while rest:
        cur = rest.pop(0)
        joined = True
        while joined:
            joined = False
            for i, l in enumerate(rest):
                if math.dist(cur[-1], l[0]) <= tol:
                    cur += l[1:]
                elif math.dist(cur[-1], l[-1]) <= tol:
                    cur += l[-2::-1]
                elif math.dist(cur[0], l[-1]) <= tol:
                    cur = l[:-1] + cur
                elif math.dist(cur[0], l[0]) <= tol:
                    cur = l[:0:-1] + cur
                else:
                    continue
                rest.pop(i)
                joined = True
                break
        out.append(cur)
    return out


def parse_rail(path, lat_c, lon_c, m_lat, m_lon, half, margin):
    """鉄道 GeoJSON(国土数値情報由来)の線形をローカル座標の折れ線にする。

    高さは持たない(2Dの中心線)ので、桁の高さは描画側で地形から合成する。
    細切れの feature を先に繋いでから矩形で切る(先に切ると繋がらなくなる)。
    """
    d = json.load(open(path, encoding="utf-8"))
    lo, hi = -margin, 2 * half + margin
    raw = []
    for f in d.get("features", []):
        g = f.get("geometry") or {}
        lines = g.get("coordinates") or []
        if g.get("type") == "LineString":
            lines = [lines]
        for line in lines:
            pts = [
                ((c[0] - lon_c) * m_lon + half, -(c[1] - lat_c) * m_lat + half)
                for c in line
            ]
            if len(pts) >= 2:
                raw.append(pts)

    out = []
    for pts in stitch(raw):
        cur = []
        for i in range(len(pts) - 1):
            seg = clip_segment(*pts[i], *pts[i + 1], lo, hi)
            if seg is None:
                if len(cur) >= 2:
                    out.append(cur)
                cur = []
                continue
            ax, az, bx, bz = seg
            if not cur:
                cur = [(ax, az)]
            elif abs(cur[-1][0] - ax) > 0.5 or abs(cur[-1][1] - az) > 0.5:
                if len(cur) >= 2:
                    out.append(cur)
                cur = [(ax, az)]
            cur.append((bx, bz))
        if len(cur) >= 2:
            out.append(cur)
    return out


def parse_stations(path, lat_c, lon_c, m_lat, m_lon, half, margin):
    """駅 CZML から駅名と位置を取り出す。position の高さは地盤高なので使わない。"""
    out = []
    for p in json.load(open(path, encoding="utf-8")):
        pos = (p.get("position") or {}).get("cartographicDegrees")
        if not pos:
            continue
        lon, lat = pos[0], pos[1]
        x = (lon - lon_c) * m_lon + half
        z = -(lat - lat_c) * m_lat + half
        if not (-margin <= x <= 2 * half + margin and -margin <= z <= 2 * half + margin):
            continue
        out.append({
            "name": p.get("name") or (p.get("properties") or {}).get("駅名") or "",
            "x": round(x, 2), "z": round(z, 2),
        })
    return out


GMLNS = "{http://www.opengis.net/gml}"


def parse_landmarks(gml_path, lat_c, lon_c, m_lat, m_lon, half, size):
    """建物CityGMLの gml:name(施設名)を代表点つきで拾う。

    名前が付く建物は疎(1タイルに5〜16件)だが、学校・駅・郵便局など
    議事録に出てくる固有名詞がここに入っている。
    """
    out = []
    for _ev, el in ET.iterparse(gml_path, events=("end",)):
        if local_name(el.tag) != "Building":
            continue
        nm = el.find(f"{GMLNS}name")
        if nm is not None and nm.text and nm.text.strip():
            pos = None
            for p in el.iter(f"{GMLNS}posList"):
                if p.text:
                    pos = [float(v) for v in p.text.split()[:3]]
                    break
            if pos:
                x = (pos[1] - lon_c) * m_lon + half
                z = -(pos[0] - lat_c) * m_lat + half
                if 0 <= x <= size and 0 <= z <= size:
                    out.append({"name": nm.text.strip(),
                                "x": round(x, 2), "z": round(z, 2)})
        el.clear()
    return out


def parse_osm_named(path, lat_c, lon_c, m_lat, m_lon, half, size):
    """OSM の名前付き地物(node/way)を地名辞書として取り込む。

    CityGML の gml:name はタイルあたり数件しかないので、議事録に出てくる
    「石嶺市営住宅」「石嶺図書館」「市道城東城北線」などを拾うにはこちらが要る。
    way は Overpass の `out center` が返す代表点を使う。
    """
    d = json.load(open(path, encoding="utf-8"))
    out = []
    for e in d.get("elements", []):
        t = e.get("tags") or {}
        nm = (t.get("name") or "").strip()
        if not nm:
            continue
        lat = e.get("lat", (e.get("center") or {}).get("lat"))
        lon = e.get("lon", (e.get("center") or {}).get("lon"))
        if lat is None or lon is None:
            continue
        x = (lon - lon_c) * m_lon + half
        z = -(lat - lat_c) * m_lat + half
        if not (0 <= x <= size and 0 <= z <= size):
            continue
        kind = next((f"{k}={t[k]}" for k in
                     ("amenity", "leisure", "highway", "landuse", "building",
                      "office", "tourism", "shop", "man_made") if k in t), "")
        out.append({"name": nm, "x": round(x, 2), "z": round(z, 2), "kind": kind})
    return out


def parse_footways(path, lat_c, lon_c, m_lat, m_lon, half, size):
    """OSM の歩行者系 way を種別つきの折れ線にする。

    PLATEAU の交通モデル(tran)は那覇では LOD1 のみで、TrafficArea /
    AuxiliaryTrafficArea を持たない = 歩道と車道の区別が無い。
    そこで歩道・横断歩道・階段は OSM から取る。
    """
    d = json.load(open(path, encoding="utf-8"))
    lo, hi = 0.0, float(size)
    out = []
    for e in d.get("elements", []):
        t = e.get("tags") or {}
        hw = t.get("highway", "")
        fw = t.get("footway", "")
        if hw == "steps":
            kind = "steps"
        elif fw == "crossing" or t.get("crossing"):
            kind = "crossing"
        elif fw == "sidewalk" or hw in ("footway", "pedestrian"):
            kind = "sidewalk"
        else:
            kind = "path"
        pts = [
            ((p["lon"] - lon_c) * m_lon + half, -(p["lat"] - lat_c) * m_lat + half)
            for p in (e.get("geometry") or []) if p
        ]
        if len(pts) < 2:
            continue
        cur = []
        for i in range(len(pts) - 1):
            seg = clip_segment(*pts[i], *pts[i + 1], lo, hi)
            if seg is None:
                if len(cur) >= 2:
                    out.append({"k": kind, "f": [round(v, 2) for p in cur for v in p]})
                cur = []
                continue
            ax, az, bx, bz = seg
            if not cur:
                cur = [(ax, az)]
            elif abs(cur[-1][0] - ax) > 0.5 or abs(cur[-1][1] - az) > 0.5:
                if len(cur) >= 2:
                    out.append({"k": kind, "f": [round(v, 2) for p in cur for v in p]})
                cur = [(ax, az)]
            cur.append((bx, bz))
        if len(cur) >= 2:
            out.append({"k": kind, "f": [round(v, 2) for p in cur for v in p]})
    return out


def parse_signals(path, lat_c, lon_c, m_lat, m_lon, half, size, radius=32.0):
    """OSM の信号ノードを、交差点ごとにまとめて系統(青になる向き)を決める。

    1つの交差点に複数のノードがあるので、近いものを1つの交差点として束ね、
    交差点中心から見た向きで東西(axis=0)と南北(axis=1)に振り分ける。
    こうすると直交する系統が交互に青になる。
    """
    d = json.load(open(path, encoding="utf-8"))
    pts = []
    for e in d.get("elements", []):
        if "lat" not in e or "lon" not in e:
            continue
        t = e.get("tags") or {}
        x = (e["lon"] - lon_c) * m_lon + half
        z = -(e["lat"] - lat_c) * m_lat + half
        if not (0 <= x <= size and 0 <= z <= size):
            continue
        # crossing=traffic_signals は歩行者用、highway=traffic_signals は車両用
        kind = "ped" if t.get("crossing") == "traffic_signals" else "car"
        pts.append({"x": x, "z": z, "kind": kind})

    # 近いノードを同じ交差点に束ねる(単純な連結成分)
    n = len(pts)
    grp = list(range(n))

    def find(a):
        while grp[a] != a:
            grp[a] = grp[grp[a]]
            a = grp[a]
        return a

    for i in range(n):
        for j in range(i + 1, n):
            if math.dist((pts[i]["x"], pts[i]["z"]), (pts[j]["x"], pts[j]["z"])) <= radius:
                a, b = find(i), find(j)
                if a != b:
                    grp[a] = b

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out = []
    for gi, (root, members) in enumerate(sorted(groups.items())):
        cx = sum(pts[i]["x"] for i in members) / len(members)
        cz = sum(pts[i]["z"] for i in members) / len(members)
        for i in members:
            dx, dz = pts[i]["x"] - cx, pts[i]["z"] - cz
            axis = 0 if abs(dx) >= abs(dz) else 1
            out.append({
                "x": round(pts[i]["x"], 2), "z": round(pts[i]["z"], 2),
                "k": pts[i]["kind"], "g": gi, "a": axis,
                # 交差点中心を向く角度(灯器の正面を車の来る側へ向ける)
                "r": round(math.atan2(-dx, -dz), 3),
            })
    return out


def parse_bus_routes(path, lat_c, lon_c, m_lat, m_lon, half, size, max_routes):
    """OSM のバス路線リレーション(type=route, route=bus)を走行経路にする。

    メンバーの way は順に並んでいるが向きは揃っていないので、端点の近さで
    反転させながら繋ぐ。そのあとワールドの矩形で切り、いちばん長く連続する
    区間だけを採る(出入りを繰り返す破片は使わない)。
    """
    d = json.load(open(path, encoding="utf-8"))
    lo, hi = 0.0, float(size)
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

        xz = [((lon - lon_c) * m_lon + half, -(lat - lat_c) * m_lat + half)
              for lon, lat in chain]
        # ワールド内で最も長く続く区間を採る
        runs, cur = [], []
        for i in range(len(xz) - 1):
            seg = clip_segment(*xz[i], *xz[i + 1], lo, hi)
            if seg is None:
                if len(cur) >= 2:
                    runs.append(cur)
                cur = []
                continue
            ax, az, bx, bz = seg
            if not cur:
                cur = [(ax, az)]
            elif abs(cur[-1][0] - ax) > 0.5 or abs(cur[-1][1] - az) > 0.5:
                if len(cur) >= 2:
                    runs.append(cur)
                cur = [(ax, az)]
            cur.append((bx, bz))
        if len(cur) >= 2:
            runs.append(cur)
        if not runs:
            continue

        def length(r):
            return sum(math.dist(r[i], r[i + 1]) for i in range(len(r) - 1))

        best = max(runs, key=length)
        L = length(best)
        if L < 150:                       # かすめるだけの路線は使わない
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
        "f": [round(v, 2) for p in c["pts"] for v in p],
    } for c in picked]


def parse_bus(path, lat_c, lon_c, m_lat, m_lon, half, margin):
    """OpenStreetMap(Overpass API)のバス停ノードをローカル座標にする。

    国土数値情報のバス停(P11)は「非商用」区分で複製物の再配布が禁止なので、
    公開物には ODbL の OSM を使う。出典表示と継承が条件。
    """
    d = json.load(open(path, encoding="utf-8"))
    out = []
    for e in d.get("elements", []):
        if "lat" not in e or "lon" not in e:
            continue
        t = e.get("tags") or {}
        x = (e["lon"] - lon_c) * m_lon + half
        z = -(e["lat"] - lat_c) * m_lat + half
        if not (-margin <= x <= 2 * half + margin and -margin <= z <= 2 * half + margin):
            continue
        out.append({
            "name": t.get("name", ""),
            "op": t.get("operator", ""),
            "x": round(x, 2), "z": round(z, 2),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--center", nargs=2, type=float, required=True, metavar=("LAT", "LON"))
    ap.add_argument("--size", type=int, default=1000, help="一辺のメートル数")
    ap.add_argument("--cell", type=int, default=5, help="地形グリッドの間隔(m)")
    ap.add_argument("--gml", nargs="+", required=True, help="建物CityGML(複数可)")
    ap.add_argument("--dem", nargs="*", default=[], help="地形CityGML(複数可)")
    ap.add_argument("--tran", nargs="*", default=[], help="交通(道路)CityGML(複数可)")
    ap.add_argument("--rail", default="", help="鉄道 GeoJSON(モノレール線形)")
    ap.add_argument("--stations", default="", help="鉄道駅 CZML")
    ap.add_argument("--bus", default="", help="バス停 (OSM Overpass JSON)")
    ap.add_argument("--osm-named", default="", help="名前付き地物 (OSM Overpass JSON)")
    ap.add_argument("--bus-routes", default="", help="バス路線 (OSM route relation JSON)")
    ap.add_argument("--signals", default="", help="信号 (OSM Overpass JSON)")
    ap.add_argument("--footways", default="", help="歩道・横断歩道・階段 (OSM Overpass JSON)")
    ap.add_argument("--max-routes", type=int, default=4, help="走らせる路線数")
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

    # ---- 道路 -------------------------------------------------------------
    roads = []
    for g in args.tran:
        path = g if os.path.isabs(g) else os.path.join(NAHA, g)
        recs = parse_roads(path)
        kept = 0
        for poly, fn in recs:
            xz = [
                ((lo - lon_c) * m_lon + half, -(la - lat_c) * m_lat + half)
                for la, lo, *_ in poly
            ]
            xs = [p[0] for p in xz]
            zs = [p[1] for p in xz]
            # ワールドの矩形と交差しないものは捨てる(タイルは窓より広い)
            if max(xs) < -20 or min(xs) > args.size + 20:
                continue
            if max(zs) < -20 or min(zs) > args.size + 20:
                continue
            ring = simplify(xz, tol=0.25)
            if len(ring) < 3 or abs(ring_area(ring)) < 1.5:
                continue
            roads.append({
                "fn": fn,
                "f": [round(v, 2) for p in ring for v in p],
            })
            kept += 1
        print(
            f"  {os.path.basename(path)}: 道路面 {len(recs):,} → 採用 {kept:,}",
            file=sys.stderr,
        )

    # ---- 施設名(建物の gml:name) --------------------------------------------
    landmarks = []
    for g in args.gml:
        path = g if os.path.isabs(g) else os.path.join(NAHA, g)
        got = parse_landmarks(path, lat_c, lon_c, m_lat, m_lon, half, args.size)
        landmarks.extend(got)
        if got:
            print(
                f"  {os.path.basename(path)}: 施設名 {len(got)}"
                f" ({'、'.join(l['name'] for l in got[:4])}…)",
                file=sys.stderr,
            )

    if args.osm_named:
        path = (args.osm_named if os.path.isabs(args.osm_named)
                else os.path.join(NAHA, args.osm_named))
        got = parse_osm_named(path, lat_c, lon_c, m_lat, m_lon, half, args.size)
        # CityGML 側と同名のものは重複させない
        have = {l["name"] for l in landmarks}
        add = [g for g in got if g["name"] not in have]
        landmarks.extend(add)
        print(
            f"  {os.path.basename(path)}: 名前付き地物 {len(got)} → 追加 {len(add)}",
            file=sys.stderr,
        )

    # ---- モノレール ---------------------------------------------------------
    # 桁が地形の端でぶつ切りにならないよう、ワールドより少し外まで延ばす
    RAIL_MARGIN = 80
    rail = []
    if args.rail:
        path = args.rail if os.path.isabs(args.rail) else os.path.join(NAHA, args.rail)
        for line in parse_rail(path, lat_c, lon_c, m_lat, m_lon, half, RAIL_MARGIN):
            rail.append([round(v, 2) for p in line for v in p])
        pts = sum(len(r) // 2 for r in rail)
        print(f"  {os.path.basename(path)}: 線形 {len(rail)}本 / {pts}点", file=sys.stderr)

    stations = []
    if args.stations:
        path = (args.stations if os.path.isabs(args.stations)
                else os.path.join(NAHA, args.stations))
        stations = parse_stations(path, lat_c, lon_c, m_lat, m_lon, half, RAIL_MARGIN)
        print(
            f"  {os.path.basename(path)}: 駅 {len(stations)} "
            f"({', '.join(s['name'] for s in stations) or 'なし'})",
            file=sys.stderr,
        )

    bus = []
    if args.bus:
        path = args.bus if os.path.isabs(args.bus) else os.path.join(NAHA, args.bus)
        bus = parse_bus(path, lat_c, lon_c, m_lat, m_lon, half, 0)
        names = sorted({b["name"] for b in bus if b["name"]})
        print(
            f"  {os.path.basename(path)}: バス停 {len(bus)} / 名称 {len(names)}種",
            file=sys.stderr,
        )

    bus_routes = []
    if args.bus_routes:
        path = (args.bus_routes if os.path.isabs(args.bus_routes)
                else os.path.join(NAHA, args.bus_routes))
        bus_routes = parse_bus_routes(path, lat_c, lon_c, m_lat, m_lon,
                                      half, args.size, args.max_routes)
        for r in bus_routes:
            print(f"  路線 {r['ref']:>4} {r['name'][:34]} ({len(r['f']) // 2}点)",
                  file=sys.stderr)

    signals = []
    if args.signals:
        path = (args.signals if os.path.isabs(args.signals)
                else os.path.join(NAHA, args.signals))
        signals = parse_signals(path, lat_c, lon_c, m_lat, m_lon, half, args.size)
        ng = len({s["g"] for s in signals})
        ncar = sum(1 for s in signals if s["k"] == "car")
        print(f"  {os.path.basename(path)}: 信号 {len(signals)}基 "
              f"(車両{ncar}/歩行者{len(signals)-ncar}) / 交差点 {ng}箇所", file=sys.stderr)

    footways = []
    if args.footways:
        path = (args.footways if os.path.isabs(args.footways)
                else os.path.join(NAHA, args.footways))
        footways = parse_footways(path, lat_c, lon_c, m_lat, m_lon, half, args.size)
        cnt = {}
        for f in footways:
            cnt[f["k"]] = cnt.get(f["k"], 0) + 1
        print(f"  {os.path.basename(path)}: 歩行者系 {len(footways)}本 {cnt}",
              file=sys.stderr)

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
        "roads": roads,
        "rail": rail,
        "stations": stations,
        "bus": bus,
        "busRoutes": bus_routes,
        "landmarks": landmarks,
        "signals": signals,
        "footways": footways,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(world, f, separators=(",", ":"))
    mb = os.path.getsize(args.out) / 1e6
    print(
        f"建物 {len(buildings):,} 棟 / 道路面 {len(roads):,} / 地形 {n}x{n} ({args.cell}m格子) "
        f"標高 {world['meta']['minZ']}〜{world['meta']['maxZ']}m\n"
        f"中心の地表 {world['meta']['groundAtCenter']}m\n"
        f"→ {args.out} ({mb:.1f}MB)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
