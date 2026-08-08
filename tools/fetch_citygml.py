#!/usr/bin/env python3
"""不足している PLATEAU の CityGML（建物・交通）を落とす。

corridor.json の線路から 1km 格子のタイルを起こし、そのタイルが乗る 3 次メッシュを
求めて、手元に無いものだけを取る。

URL は PLATEAU の配信 CDN の規則的な並びで、MCP の `plateau_get_citygml_files` が
返すものと同じ（`m:39272551` で照合ずみ）。海域などで元々存在しないメッシュは
404 を返すので、それは飛ばす。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_citygml.py          # 実際に取る
  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_citygml.py --dry-run # 一覧と容量だけ

保存名は build_world.py が受け取る形に合わせる（`39272568.gml` / `39272568_tran.gml`）。
"""
import argparse
import concurrent.futures as cf
import json
import math
import pathlib
import urllib.error
import urllib.request

BASE = ("https://assets.cms.plateau.reearth.io/assets/48/"
        "f6c0d0-5506-47ea-8807-12c098c4579b/"
        "47201_naha-shi_city_2020_citygml_7_op/udx")
DATA = pathlib.Path.home() / "dev/tools/blender-mcp/data/naha"
M_LAT = 111320.0
TILE, HALF = 1000.0, 500.0


def mesh3(lat, lon):
    """緯度経度 -> 3 次メッシュコード（JIS 標準地域メッシュ）。"""
    p = int(lat * 1.5)
    q = int(lon) - 100
    rl = lat * 1.5 - p
    rr = lon - 100 - q
    r, s = int(rl * 8), int(rr * 8)
    return f"{p}{q}{r}{s}{int((rl * 8 - r) * 10)}{int((rr * 8 - s) * 10)}"


def corridor_tiles(corridor, buf):
    """線路から buf(m) 以内を覆う 1km タイルの (tx, tz) 一覧。"""
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
    return out


def tile_meshes(tx, tz, olat, olon, m_lon):
    """タイル(tx,tz)の四角を格子で覆い、乗っている 3 次メッシュを集める。"""
    ms = set()
    for fx in range(9):
        for fz in range(9):
            x = tx * TILE - HALF + TILE * fx / 8
            z = tz * TILE - HALF + TILE * fz / 8
            # z は南向き（-Z が北）
            ms.add(mesh3(olat - z / M_LAT, olon + x / m_lon))
    return ms


def head(kind, m):
    """(在るか, 圧縮後のバイト数)。無ければ (False, 0)。"""
    url = f"{BASE}/{kind}/{m}_{kind}_6697_op.gml"
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            v = (r.headers.get("x-goog-stored-content-length")
                 or r.headers.get("content-length") or 0)
            return True, int(v)
    except Exception:
        return False, 0


def grab(kind, m, out):
    url = f"{BASE}/{kind}/{m}_{kind}_6697_op.gml"
    tmp = out.with_suffix(".part")
    with urllib.request.urlopen(url, timeout=300) as r, tmp.open("wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(out)
    return out.stat().st_size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corridor", default="public/data/corridor.json")
    ap.add_argument("--buffer", type=float, default=600.0,
                    help="線路からこの距離までを覆う(m)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--jobs", type=int, default=6)
    args = ap.parse_args()

    corridor = json.loads(pathlib.Path(args.corridor).read_text())
    olat = corridor["meta"]["originLat"]
    olon = corridor["meta"]["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))

    tiles = corridor_tiles(corridor, args.buffer)
    need = set()
    for tx, tz in tiles:
        need |= tile_meshes(tx, tz, olat, olon, m_lon)
    need = sorted(need)
    print(f"タイル {len(tiles)} 枚 / 3 次メッシュ {len(need)} 枚")

    plan = []
    for kind, suffix in (("bldg", ".gml"), ("tran", "_tran.gml")):
        for m in need:
            out = DATA / f"{m}{suffix}"
            if out.exists():
                continue
            plan.append((kind, m, out))

    print(f"手元に無いもの {len(plan)} 件。存在と容量を確かめる…")
    with cf.ThreadPoolExecutor(args.jobs) as ex:
        checked = list(ex.map(lambda p: (p, head(p[0], p[1])), plan))
    live = [(p, sz) for p, (ok, sz) in checked if ok]
    dead = [p for p, (ok, _) in checked if not ok]
    total = sum(sz for _, sz in live)
    print(f"  実在 {len(live)} 件 / 圧縮合計 {total / 1e6:.0f}MB")
    print(f"  不在 {len(dead)} 件（海域など。元々作られていない）")

    if args.dry_run:
        for (kind, m, out), sz in sorted(live, key=lambda x: -x[1])[:10]:
            print(f"    {kind} {m}: {sz / 1e6:.1f}MB")
        return

    done = 0
    got = 0
    with cf.ThreadPoolExecutor(args.jobs) as ex:
        futs = {ex.submit(grab, k, m, o): (k, m) for (k, m, o), _ in live}
        for fut in cf.as_completed(futs):
            k, m = futs[fut]
            try:
                got += fut.result()
                done += 1
                if done % 10 == 0 or done == len(live):
                    print(f"  {done}/{len(live)} 件 / 展開後 {got / 1e6:.0f}MB")
            except Exception as e:
                print(f"  失敗 {k} {m}: {e}")
    print(f"完了: {done} 件 / 展開後 {got / 1e6:.0f}MB -> {DATA}")


if __name__ == "__main__":
    main()
