#!/usr/bin/env python3
"""災害リスク CityGML を、タイルの 5m 格子へ焼き落とす。

元データは大きい（津波 129MB・高潮 209MB・洪水 157MB）ので、公開物には
**格子に焼いたものだけ**を置く。出来上がりは 1 種別あたり数百 KB。

## なぜ格子か

この街の地形は 5m 格子（`terrain[ix * n + iz]`、n=201）で、標高を引く関数が
それを読む。ハザードも同じ格子に載せれば、**引き方が地面とまったく同じ**になり、
地面テクスチャを焼くループからも 1 回の添字で読める。ポリゴンのまま持って
実行時に内外判定をするより、桁で軽い。

## データの形（実物を見て決めた）

津波・高潮・洪水はどれも `wtr:WaterBody` で、`gml:posList` は
**緯度 経度 標高** の三つ組。標高は地面ではなく**浸水位**（実測で津波は
-2.30〜16.53m）。三角形の集まりなので、頂点の高さがそのまま水面になる。
浸水深のランクは `uro:rankOrg`（1〜5）。土砂災害(lsld)だけは高さを持たない
警戒区域なので、ランクだけを焼く。

## 深さは自分で計算した値を正としない

PLATEAU 自身が「地盤高は独自のものを使っているため、見た目の浸水深と
想定図が示す想定浸水深が一致しない場合がある」と断っている。手元の DEM も
別物なので、`水位 - 地形` は**目安**にしかならない。だから
**公式の rankOrg を正として持ち**、水位は描画のためだけに持つ。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_hazard.py tnm
  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_hazard.py          # 全部

出力: public/data/hazard/<種別>.json
"""
import argparse
import json
import math
import pathlib
import re
import sys
import time

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = pathlib.Path.home() / "dev/tools/blender-mcp/data/naha/hazard"
OUT = ROOT / "public/data/hazard"
M_LAT = 111320.0
TILE, HALF, CELL = 1000.0, 500.0, 5
N = int(TILE // CELL) + 1          # 201。build_world.py の n と同じ

# 描画側に出す見出しと出典。**ここを唯一の正にする。**
META = {
    "tnm": {
        "label": "津波", "unit": "浸水深",
        "source": "沖縄県 津波浸水想定図（2015年3月公表）",
        "law": "津波防災地域づくりに関する法律 第8条第1項",
        "ranks": ["0.01〜0.3m未満", "0.3〜1.0m未満", "1.0〜2.0m未満",
                  "2.0〜5.0m未満", "5.0m以上"],
    },
    "htd": {
        "label": "高潮", "unit": "浸水深",
        "source": "沖縄県 高潮浸水予測図（2007年3月）",
        "law": "水防法 第14条第3項",
        "ranks": ["0.01〜0.3m未満", "0.3〜1.0m未満", "1.0〜2.0m未満",
                  "2.0〜5.0m未満", "5.0m以上"],
    },
    "fld": {
        "label": "洪水", "unit": "浸水深",
        "source": "沖縄県 国場川水系・安里川水系 洪水浸水想定区域図"
                  "（2018年12月11日指定・想定最大規模）",
        "law": "水防法 第14条第1項",
        "note": "前提となる降雨は流域全体の24時間総雨量1,100mm",
        "ranks": ["0.01〜0.3m未満", "0.3〜1.0m未満", "1.0〜2.0m未満",
                  "2.0〜5.0m未満", "5.0m以上"],
    },
    "lsld": {
        "label": "土砂災害", "unit": "区域",
        "source": "沖縄県 土砂災害警戒区域等（2014年3月4日〜2017年3月28日告示）",
        "law": "土砂災害警戒区域等における土砂災害防止対策の推進に関する法律 "
               "第7条第1項・第9条第1項",
        "ranks": ["警戒区域", "特別警戒区域"],
    },
}

# posList を拾う。名前空間ごと正規表現で舐める。CityGML は入れ子が深く、
# 129MB を DOM に載せると重い。iterparse でもよいが、要るのは
# 「WaterBody ごとの rankOrg と posList」だけなので、これで足りる
RE_MEMBER = re.compile(r"<core:cityObjectMember>(.*?)</core:cityObjectMember>", re.S)
RE_POSLIST = re.compile(r"<gml:posList>([^<]+)</gml:posList>")
RE_RANK = re.compile(r"<uro:rank(?:Org)?[^>]*>(\d+)</uro:rank(?:Org)?>")


def world_of(lat, lon, olat, olon, m_lon):
    """緯度経度 -> 世界座標。**z は南向き**（この街の約束）。"""
    return (lon - olon) * m_lon, -(lat - olat) * M_LAT


def raster_tri(grid_h, grid_r, tri, rank, offX, offZ):
    """三角形1枚をタイルの格子へ塗る。走査は外接矩形だけ。

    格子は **行が x・列が z**（`terrain[ix * n + iz]` と同じ向き）。
    ここを取り違えると、ハザードの形の転置を塗ることになる
    （水域を掘るときに一度踏んだ罠）。
    """
    (x0, z0, y0), (x1, z1, y1), (x2, z2, y2) = tri
    # 格子座標へ
    gx = [(x - (offX - HALF)) / CELL for x in (x0, x1, x2)]
    gz = [(z - (offZ - HALF)) / CELL for z in (z0, z1, z2)]
    lo_x = max(0, int(math.floor(min(gx))))
    hi_x = min(N - 1, int(math.ceil(max(gx))))
    lo_z = max(0, int(math.floor(min(gz))))
    hi_z = min(N - 1, int(math.ceil(max(gz))))
    if lo_x > hi_x or lo_z > hi_z:
        return 0
    # 面積が潰れた三角形は飛ばす
    d = (gz[1] - gz[2]) * (gx[0] - gx[2]) + (gx[2] - gx[1]) * (gz[0] - gz[2])
    if abs(d) < 1e-12:
        return 0
    n_hit = 0
    for ix in range(lo_x, hi_x + 1):
        for iz in range(lo_z, hi_z + 1):
            # 重心座標で内外判定。縁は少し甘く見る（格子と三角形が同程度の
            # 大きさなので、厳密にすると穴が空く）
            a = ((gz[1] - gz[2]) * (ix - gx[2]) + (gx[2] - gx[1]) * (iz - gz[2])) / d
            b = ((gz[2] - gz[0]) * (ix - gx[2]) + (gx[0] - gx[2]) * (iz - gz[2])) / d
            c = 1.0 - a - b
            if a < -0.05 or b < -0.05 or c < -0.05:
                continue
            y = a * y0 + b * y1 + c * y2
            k = ix * N + iz
            if y > grid_h[k]:
                grid_h[k] = y
            if rank > grid_r[k]:
                grid_r[k] = rank
            n_hit += 1
    return n_hit


# 64進の桁。JSON にそのまま入れられる文字だけを使う（" と \ を避ける）
B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"
LVL_OFFSET = 100          # 0.1m 刻みで -10.0m を 0 に寄せる


def rle(arr):
    """0〜5 の格子をランレングスにする。`値×長さ` を並べた文字列。

    例: "0x1000,3x4,0x39397" のような形にはせず、`値` と `長さの64進` を
    交互に置く（読む側が1文字ずつ進めばよい形にする）。
    """
    out = []
    run_v = int(arr[0])
    run_n = 0
    for v in arr:
        v = int(v)
        if v == run_v:
            run_n += 1
            continue
        out.append(f"{run_v}{run_n}.")
        run_v, run_n = v, 1
    out.append(f"{run_v}{run_n}.")
    return "".join(out)


def pack_levels(gh, gr):
    """浸水した格子の水位だけを 64進2文字で並べる。並びは格子の走査順。"""
    out = []
    for k in range(gh.shape[0]):
        if gr[k] == 0:
            continue
        v = int(round(float(gh[k]) * 10)) + LVL_OFFSET
        v = max(0, min(4095, v))
        out.append(B64[v >> 6])
        out.append(B64[v & 63])
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kinds", nargs="*", default=[])
    ap.add_argument("--out-dir", default=str(OUT))
    args = ap.parse_args()

    kinds = args.kinds or list(META)
    bad = [k for k in kinds if k not in META]
    if bad:
        sys.exit(f"知らない種別: {', '.join(bad)}")

    corridor = json.load(open(ROOT / "public/data/corridor.json"))
    olat = corridor["meta"]["originLat"]
    olon = corridor["meta"]["originLon"]
    m_lon = M_LAT * math.cos(math.radians(olat))

    index = json.load(open(ROOT / "public/data/tiles/index.json"))
    tiles = [(t[0], t[1]) for t in index["tiles"]]
    print(f"タイル {len(tiles)} 枚 / 格子 {N}×{N} ({CELL}m)", file=sys.stderr)

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    for kind in kinds:
        t0 = time.time()
        files = sorted((SRC / kind).glob("*.gml"))
        if not files:
            print(f"  {kind}: 素材が無い（先に fetch_hazard.py）", file=sys.stderr)
            continue

        # タイルごとの格子。水位は -9999 を「無し」とする
        grids = {}
        for tx, tz in tiles:
            grids[(tx, tz)] = [np.full(N * N, -9999.0, dtype=np.float32),
                               np.zeros(N * N, dtype=np.uint8)]
        # タイルの世界座標での中心
        offs = {(tx, tz): (tx * TILE, tz * TILE) for tx, tz in tiles}

        n_body = n_tri = n_hit = 0
        for path in files:
            src = path.read_text(encoding="utf-8", errors="replace")
            for m in RE_MEMBER.finditer(src):
                body = m.group(1)
                rm = RE_RANK.search(body)
                rank = int(rm.group(1)) if rm else 1
                n_body += 1
                for pm in RE_POSLIST.finditer(body):
                    v = pm.group(1).split()
                    if len(v) < 9:
                        continue
                    pts = []
                    for i in range(0, len(v) - 2, 3):
                        lat, lon, y = float(v[i]), float(v[i + 1]), float(v[i + 2])
                        x, z = world_of(lat, lon, olat, olon, m_lon)
                        pts.append((x, z, y))
                    if pts and pts[0] == pts[-1]:
                        pts.pop()
                    if len(pts) < 3:
                        continue
                    # 扇状に三角形へ割る（PLATEAU の面はほぼ三角形そのもの）
                    for i in range(1, len(pts) - 1):
                        tri = (pts[0], pts[i], pts[i + 1])
                        n_tri += 1
                        xs = [p[0] for p in tri]
                        zs = [p[1] for p in tri]
                        for key, (ox, oz) in offs.items():
                            if (max(xs) < ox - HALF or min(xs) > ox + HALF
                                    or max(zs) < oz - HALF or min(zs) > oz + HALF):
                                continue
                            gh, gr = grids[key]
                            n_hit += raster_tri(gh, gr, tri, rank, ox, oz)
            del src

        # 焼き上がりを書き出す。**空のタイルは入れない**
        #
        # 素直に配列で出すと 5.5MB になった（201×201×34枚、しかも大半が「無し」）。
        # 2つの工夫で詰める:
        #   rank  ランレングス。ほとんどが 0 の連なりなので効く
        #   level 浸水した格子のぶんだけ、0.1m 刻みを 64 進 2 文字で並べる
        #         （-10.0〜+399.5m を 4096 段で表せる。実測の幅は -2.3〜16.5m）
        out = {"kind": kind, "cell": CELL, "n": N, "meta": META[kind], "tiles": {}}
        n_tile = 0
        for (tx, tz), (gh, gr) in grids.items():
            if not (gr > 0).any():
                continue
            n_tile += 1
            out["tiles"][f"{tx},{tz}"] = {
                "rank": rle(gr),
                **({} if kind == "lsld" else {"level": pack_levels(gh, gr)}),
            }
        path = out_dir / f"{kind}.json"
        with open(path, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        mb = path.stat().st_size / 1e6
        print(f"  {kind}: 区域{n_body:,} 三角形{n_tri:,} 塗った格子{n_hit:,} "
              f"/ タイル{n_tile}枚 / {mb:.2f}MB ({time.time() - t0:.0f}秒)",
              file=sys.stderr)


if __name__ == "__main__":
    main()
