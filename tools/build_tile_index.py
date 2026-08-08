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
    ap.add_argument("--min-buildings", type=int, default=1,
                    help="建物がこれ未満のタイルは世界に含めない(既定 1)")
    ap.add_argument("--delete", action="store_true",
                    help="除いたタイルの JSON も消す(作り直せるので既定で消してよい)")
    args = ap.parse_args()

    d = pathlib.Path(args.dir)
    out = pathlib.Path(args.out) if args.out else d / "index.json"

    # t_<tx>_<tz>.json。tx/tz は負になるので符号を許す
    pat = re.compile(r"^t_(-?\d+)_(-?\d+)\.json$")
    found = {}
    for p in sorted(d.glob("t_*.json")):
        m = pat.match(p.name)
        if not m:
            continue
        # 建物の数も載せる。シーサーをタイルに均等に配ると、市域ぜんぶ(84タイル)では
        # 6割以上のタイルが空になり、歩いても何分も出会わない。
        # 建物の数で重み付けして、人が歩く所へ寄せる。
        try:
            n = len(json.loads(p.read_text()).get("buildings", []))
        except Exception:
            n = 0
        found[(int(m.group(1)), int(m.group(2)))] = n

    # 建物の無いタイルは世界に含めない。道路や歩道だけが草原に走るのは
    # 街として壊れて見えるうえ、7 枚は道路すら無い純粋な空(海や隣接市町村で
    # PLATEAU の建物メッシュが無い範囲)。
    thin = [k for k, n in found.items() if n < args.min_buildings]
    for k in thin:
        del found[k]
        f = d / f"t_{k[0]}_{k[1]}.json"
        if args.delete and f.exists():
            f.unlink()
    if thin:
        print(f"  建物 {args.min_buildings} 未満のタイルを除外: {len(thin)} 枚"
              + ("（ファイルも削除）" if args.delete else "（ファイルは残す）"))

    tiles = sorted(found, key=lambda t: (t[1], t[0]))
    out.write_text(json.dumps(
        {"tiles": [[a, b, found[(a, b)]] for a, b in tiles]},
        ensure_ascii=False) + "\n")
    txs = [t[0] for t in tiles]
    tzs = [t[1] for t in tiles]
    tot = sum(found.values())
    print(f"{out}: {len(tiles)} タイル / 建物 {tot:,} 棟 "
          f"(tx {min(txs)}..{max(txs)} / tz {min(tzs)}..{max(tzs)})")
    top = sorted(found.items(), key=lambda kv: -kv[1])[:5]
    print("  建物が多いタイル: "
          + "、".join(f"{a},{b}={n:,}" for (a, b), n in top))


if __name__ == "__main__":
    main()
