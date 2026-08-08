#!/usr/bin/env python3
"""public/data/tiles/index.json を作る。

描画側は「この世界にどのタイルがあるか」を最初に知る必要がある:

- 歩ける範囲(BOUNDS)とミニマップの縮尺を、いま読み込んでいるタイルではなく
  **世界ぜんぶ**で決める。読み込みに合わせて動かすと、歩くたびに地図の縮尺が
  変わって現在地が掴めなくなる
- シーサーの体数を最初から確定させる。タイルを読むたびに増えると
  「ぜんぶ保護する」の分母が動いてしまう

タイルの JSON が実際に置いてあるものだけを載せる(404 を踏ませない)。
タイルを増やしたら、このスクリプトを流し直すこと。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/build_tile_index.py
"""
import argparse
import json
import pathlib
import re


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="public/data/tiles", help="タイルの置き場")
    ap.add_argument("--out", default="", help="既定は <dir>/index.json")
    args = ap.parse_args()

    d = pathlib.Path(args.dir)
    out = pathlib.Path(args.out) if args.out else d / "index.json"

    # t_<tx>_<tz>.json。tx/tz は負になるので符号を許す
    pat = re.compile(r"^t_(-?\d+)_(-?\d+)\.json$")
    found = set()
    for p in sorted(d.glob("t_*.json")):
        m = pat.match(p.name)
        if m:
            found.add((int(m.group(1)), int(m.group(2))))

    # タイル(0,0)は world.json を使う(tiles/t_0_0.json は --parks 以前の生成物)。
    # ファイルが無くても必ず載せる。
    found.add((0, 0))

    tiles = sorted(found, key=lambda t: (t[1], t[0]))
    out.write_text(json.dumps({"tiles": [list(t) for t in tiles]},
                              ensure_ascii=False) + "\n")
    txs = [t[0] for t in tiles]
    tzs = [t[1] for t in tiles]
    print(f"{out}: {len(tiles)} タイル "
          f"(tx {min(txs)}..{max(txs)} / tz {min(tzs)}..{max(tzs)})")
    print("  " + " ".join(f"{a},{b}" for a, b in tiles))


if __name__ == "__main__":
    main()
