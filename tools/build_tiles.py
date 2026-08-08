#!/usr/bin/env python3
"""corridor 全体を 1km タイルに切って build_world.py を回す。

各タイルに渡す CityGML は、そのタイルの四角が乗る 3 次メッシュ（少し余白をとる）
のうち手元にあるものだけ。**広く渡すぶんには害がない**（パーサが bbox で切る）が、
足りないと建物が欠ける。3 次メッシュ 1 枚は約 1.15km × 0.93km なので、
1km 四方のタイルはたいてい 4 枚にまたがる。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_tiles.py
  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_tiles.py --only=-1,1 --force
      ※ tx が負のタイルは **--only=-1,1 の = 形式**で渡すこと。
        --only -1,1 と書くと argparse がフラグと解釈して落ちる。
  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_tiles.py --dry-run

素材が足りないものは tools/fetch_citygml.py で取る。
生成後は tools/build_tile_index.py を流して index.json を作り直すこと。
"""
import argparse
import json
import math
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = pathlib.Path.home() / "dev/tools/blender-mcp/data/naha"
PY = str(pathlib.Path.home() / "dev/tools/blender-mcp/.venv/bin/python")
M_LAT = 111320.0
TILE, HALF = 1000.0, 500.0
MESH_PAD = 150.0        # メッシュを拾うときの余白(m)。多めに渡して取りこぼさない

# 那覇市域を覆う外接矩形(lat0, lon0, lat1, lon1)。海と隣接市町村も入るが、
# **建物 GML が手元に1枚も無いタイルは飛ばす**ので勝手に落ちる
# （PLATEAU は海域のメッシュを作っていない）。
CITY_BBOX = (26.176, 127.646, 26.268, 127.760)

# 全タイル共通で渡すもの（corridor 全体を 1 回のクエリで取ってある）
OSM = {
    "--rail": "naha_railway.geojson",
    "--stations": "naha_station.czml",
    "--bus": "naha_bus_osm.json",
    "--osm-named": "naha_named_osm.json",
    "--bus-routes": "naha_busroutes_osm.json",
    "--signals": "naha_signals_osm.json",
    "--footways": "naha_footways_osm.json",
    "--parks": "naha_parks_osm.json",
    "--walls": "naha_shurijo_osm.json",
    "--historic": "naha_historic_osm.json",
}
# 2 次メッシュ 392725 の地形は 4 分割で配られている。**4 枚とも渡すこと**。
# _50/_55 だけだと那覇空港・小禄の側で「範囲内に点なし」となり、
# 標高 0.0〜0.0m の平らなタイルが 7 枚できた（隣と数十mの崖になる）。
DEMS = ["392725_dem_00.gml", "392725_dem_05.gml",
        "392725_dem_50.gml", "392725_dem_55.gml"]


def mesh3(lat, lon):
    p = int(lat * 1.5)
    q = int(lon) - 100
    rl = lat * 1.5 - p
    rr = lon - 100 - q
    r, s = int(rl * 8), int(rr * 8)
    return f"{p}{q}{r}{s}{int((rl * 8 - r) * 10)}{int((rr * 8 - s) * 10)}"


def corridor_tiles(corridor, buf):
    rail = corridor["rail"][0]
    pts = [(rail[i], rail[i + 1]) for i in range(0, len(rail), 2)]
    dense = []
    for a, b in zip(pts, pts[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(d / 40))
        for k in range(n):
            t = k / n
            dense.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    dense.append(pts[-1])

    def dist(tx, tz, x, z):
        return math.hypot(max(abs(x - tx * TILE) - HALF, 0.0),
                          max(abs(z - tz * TILE) - HALF, 0.0))

    xs = [p[0] for p in dense]
    zs = [p[1] for p in dense]
    out = []
    for tx in range(int((min(xs) - buf) // TILE) - 1, int((max(xs) + buf) // TILE) + 2):
        for tz in range(int((min(zs) - buf) // TILE) - 1, int((max(zs) + buf) // TILE) + 2):
            if any(dist(tx, tz, x, z) <= buf for x, z in dense):
                out.append((tx, tz))
    # 原点から近い順に作る（途中で止めても中心部から揃う）
    return sorted(out, key=lambda t: t[0] ** 2 + t[1] ** 2)


def city_tiles(olat, olon, m_lon):
    """那覇市域の外接矩形を覆う 1km タイル。"""
    lat0, lon0, lat1, lon1 = CITY_BBOX
    tx0 = int(round((lon0 - olon) * m_lon / TILE))
    tx1 = int(round((lon1 - olon) * m_lon / TILE))
    tz0 = int(round(-(lat1 - olat) * M_LAT / TILE))
    tz1 = int(round(-(lat0 - olat) * M_LAT / TILE))
    out = [(tx, tz) for tx in range(tx0, tx1 + 1) for tz in range(tz0, tz1 + 1)]
    return sorted(out, key=lambda t: t[0] ** 2 + t[1] ** 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("corridor", "city"), default="corridor",
                    help="corridor=ゆいレール沿い / city=那覇市域ぜんぶ")
    ap.add_argument("--corridor", default="public/data/corridor.json")
    ap.add_argument("--out-dir", default="public/data/tiles")
    ap.add_argument("--buffer", type=float, default=600.0)
    ap.add_argument("--only", nargs="*", default=None, help='例: 0,0 -1,0')
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="既にあるものも作り直す")
    args = ap.parse_args()

    corridor = json.loads((ROOT / args.corridor).read_text())
    olat = corridor["meta"]["originLat"]
    olon = corridor["meta"]["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))
    out_dir = ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    tiles = (city_tiles(olat, olon, m_lon) if args.mode == "city"
             else corridor_tiles(corridor, args.buffer))
    if args.only:
        want = {tuple(int(v) for v in s.split(",")) for s in args.only}
        tiles = [t for t in tiles if t in want]

    ok, skipped, failed, skipped_sea = 0, 0, [], 0
    t_start = time.time()
    for i, (tx, tz) in enumerate(tiles, 1):
        out = out_dir / f"t_{tx}_{tz}.json"
        if out.exists() and not args.force:
            skipped += 1
            continue
        # タイルの中心（z は南向き。-Z が北）
        lat_c = olat - (tz * TILE) / M_LAT
        lon_c = olon + (tx * TILE) / m_lon

        ms = set()
        for fx in range(9):
            for fz in range(9):
                x = tx * TILE - HALF - MESH_PAD + (TILE + 2 * MESH_PAD) * fx / 8
                z = tz * TILE - HALF - MESH_PAD + (TILE + 2 * MESH_PAD) * fz / 8
                ms.add(mesh3(olat - z / M_LAT, olon + x / m_lon))
        gml = sorted(f"{m}.gml" for m in ms if (DATA / f"{m}.gml").exists())
        tran = sorted(f"{m}_tran.gml" for m in ms if (DATA / f"{m}_tran.gml").exists())
        if not gml:
            # 海域など。PLATEAU がメッシュを作っていないので、ここは世界に含めない
            if args.mode != "city":
                print(f"[{tx},{tz}] 建物 GML が 1 枚も無い（メッシュ {sorted(ms)}）— 飛ばす")
                failed.append((tx, tz, "建物GMLなし"))
            skipped_sea += 1
            continue

        cmd = [PY, str(HERE / "build_world.py"),
               "--center", f"{lat_c:.6f}", f"{lon_c:.6f}",
               "--origin", f"{olat}", f"{olon}",
               "--size", "1000",
               "--gml", *gml,
               "--dem", *[d for d in DEMS if (DATA / d).exists()],
               "--out", str(out)]
        if tran:
            cmd += ["--tran", *tran]
        for flag, name in OSM.items():
            if (DATA / name).exists():
                cmd += [flag, name]

        head = f"[{i}/{len(tiles)}] t_{tx}_{tz}"
        if args.dry_run:
            print(f"{head}: 建物{len(gml)}枚 / tran {len(tran)}枚 / メッシュ {sorted(ms)}")
            continue
        a = time.time()
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"{head}: 失敗\n{r.stderr[-800:]}")
            failed.append((tx, tz, "build_world 失敗"))
            continue
        # build_world の最後の 2 行（棟数と出力先）だけ拾う
        tail = [l for l in r.stderr.strip().splitlines() if l.startswith("建物")]
        size = out.stat().st_size / 1e6
        print(f"{head}: {tail[-1] if tail else ''} / {size:.1f}MB / {time.time()-a:.1f}s")
        ok += 1

    if args.dry_run:
        return
    total = sum(p.stat().st_size for p in out_dir.glob("t_*.json")) / 1e6
    print(f"\n生成 {ok} / 既存 {skipped} / 海など {skipped_sea} / 失敗 {len(failed)} "
          f"（{time.time()-t_start:.0f}s）")
    print(f"tiles 合計 {total:.0f}MB")
    for tx, tz, why in failed:
        print(f"  失敗 t_{tx}_{tz}: {why}")
    print("次: tools/build_tile_index.py を流して index.json を作り直す")


if __name__ == "__main__":
    main()
