#!/usr/bin/env python3
"""e-Stat の地域メッシュ統計（国勢調査・人口）を落として、この世界の座標に直す。

**小地域（町丁字）ではなくメッシュを使う。** この world は 3 次メッシュ由来の
1km タイルでできているので、メッシュ統計はそのまま座標に乗る。町丁字だと
境界ポリゴンを別途落として名前で突き合わせる工程が要るが、メッシュは
コードから緯度経度が計算できるので照合が要らない。

落とすのは統計 GIS の T001102（令和2年国勢調査・人口・**250m メッシュ**）。
沖縄県ぶんで 8,693 セル、うち那覇まわり（3927…）が 5,409 セル。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_estat_mesh.py

出力は public/data/mesh_pop.json。KEY_CODE ではなくワールド座標で持つ。
"""
import argparse
import csv
import io
import json
import math
import pathlib
import urllib.request
import zipfile

URL = ("https://www.e-stat.go.jp/gis/statmap-search/data"
       "?statsId=T001102&code=47&downloadType=2&datum=2000")
M_LAT = 111320.0


def mesh_center(code):
    """メッシュコード（8/9/10 桁）の中心の緯度経度。

    8 桁 = 3 次メッシュ（約 1km）、9 桁 = 4 次（500m）、10 桁 = 5 次（250m）。
    4 次以降は 1〜4 の象限番号で、1=南西 2=南東 3=北西 4=北東。
    """
    p, q = int(code[0:2]), int(code[2:4])
    lat = p / 1.5
    lon = q + 100.0
    dlat, dlon = 2.0 / 3.0, 1.0            # 1 次メッシュ
    lat += int(code[4]) * dlat / 8
    lon += int(code[5]) * dlon / 8
    dlat, dlon = dlat / 8, dlon / 8        # 2 次
    lat += int(code[6]) * dlat / 10
    lon += int(code[7]) * dlon / 10
    dlat, dlon = dlat / 10, dlon / 10      # 3 次
    for ch in code[8:]:
        k = int(ch) - 1
        dlat, dlon = dlat / 2, dlon / 2
        lat += (k // 2) * dlat
        lon += (k % 2) * dlon
    return lat + dlat / 2, lon + dlon / 2, dlat, dlon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corridor", default="public/data/corridor.json")
    ap.add_argument("--index", default="public/data/tiles/index.json")
    ap.add_argument("--out", default="public/data/mesh_pop.json")
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    meta = json.loads((root / args.corridor).read_text())["meta"]
    olat, olon = meta["originLat"], meta["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))

    tiles = json.loads((root / args.index).read_text())["tiles"]
    keys = {(t[0], t[1]) for t in tiles}

    print(f"e-Stat から落とす: {URL}")
    with urllib.request.urlopen(URL, timeout=180) as r:
        blob = r.read()
    zf = zipfile.ZipFile(io.BytesIO(blob))
    name = [n for n in zf.namelist() if n.endswith((".txt", ".csv"))][0]
    txt = zf.read(name).decode("cp932")
    rows = list(csv.reader(io.StringIO(txt)))
    hdr = rows[0]
    col = {k: i for i, k in enumerate(hdr)}
    print(f"  {name}: {len(rows) - 2:,} セル")

    def num(v):
        v = (v or "").strip()
        return int(v) if v.lstrip("-").isdigit() else 0

    out = []
    for r in rows[2:]:
        if not r or not r[0]:
            continue
        lat, lon, dlat, dlon = mesh_center(r[0])
        x = (lon - olon) * m_lon
        z = -(lat - olat) * M_LAT
        # 世界のタイルに乗るものだけ
        if (round(x / 1000), round(z / 1000)) not in keys:
            continue
        pop = num(r[col["T001102001"]])
        if pop <= 0:
            continue
        out.append({
            "x": round(x, 1), "z": round(z, 1),
            "w": round(dlon * m_lon, 1), "d": round(dlat * M_LAT, 1),
            "p": pop,
            "c": num(r[col["T001102004"]]),          # 0〜14歳
            "o": num(r[col["T001102019"]]),          # 65歳以上
        })

    outp = root / args.out
    outp.write_text(json.dumps(
        {"source": "令和2年国勢調査 地域メッシュ統計（e-Stat 統計GIS T001102）",
         "url": "https://www.e-stat.go.jp/gis/statmap-search?type=1",
         "note": "250m メッシュ。x,z はこの world のワールド座標（m）",
         "cells": out},
        ensure_ascii=False, separators=(",", ":")) + "\n")
    tot = sum(c["p"] for c in out)
    print(f"世界のタイルに乗るセル {len(out):,} / 人口 {tot:,} 人 "
          f"→ {outp} ({outp.stat().st_size / 1024:.0f}KB)")


if __name__ == "__main__":
    main()
