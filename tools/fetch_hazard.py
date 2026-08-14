#!/usr/bin/env python3
"""PLATEAU の災害リスク CityGML（津波・高潮・洪水・土砂）を落とす。

**出典と時点をここに書き残す。** 描画側でこれを添えるので、増やすときは必ず更新する。

  津波 tnm  沖縄県津波浸水想定図（2015年3月公表 / 津波防災地域づくりに関する法律 第8条第1項）
  高潮 htd  沖縄県高潮浸水予測図（2007年3月 / 水防法 第14条第3項）
  洪水 fld  国場川水系国場川・安里川水系（安里川・真嘉比川・久茂地川）
            沖縄県 2018-12-11 指定 / 水防法 第14条第1項 / 想定最大規模（24時間総雨量1,100mm）
  土砂 lsld 沖縄県 土砂災害警戒区域・特別警戒区域（2014-03-04〜2017-03-28 告示）

いずれも PLATEAU（PDL1.0 / CC BY 4.0 互換）なので、建物・地形と同じ出典表示で足りる。

**これは避難の判断材料ではない。** 想定は前提（何年確率の降雨か・どの地震モデルか）
の上に立っていて、時点も古いものがある（高潮は2007年）。描画側では必ず
「実際の避難は那覇市の最新情報に従う」を添えること。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_hazard.py            # 全部
  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_hazard.py tnm        # 指定したものだけ
  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_hazard.py --dry-run  # 一覧だけ

保存先は ~/dev/tools/blender-mcp/data/naha/hazard/<種別>/ 。
**公開物には入れない**（tnm だけで 129MB ある）。build_hazard.py が
タイルの格子へ焼き落としたものだけを public/data へ置く。
"""
import argparse
import concurrent.futures as cf
import pathlib
import sys
import urllib.error
import urllib.request

BASE = ("https://assets.cms.plateau.reearth.io/assets/48/"
        "f6c0d0-5506-47ea-8807-12c098c4579b/"
        "47201_naha-shi_city_2020_citygml_7_op/udx")
OUT = pathlib.Path.home() / "dev/tools/blender-mcp/data/naha/hazard"

# 洪水だけ 3 次メッシュごとに分かれていて、しかも水系ごとに別ディレクトリ。
# MCP の plateau_get_citygml_files が返した並びをそのまま写してある。
FLD_KOKUBA = ["39272524", "39272526", "39272533", "39272534", "39272535",
              "39272536", "39272537", "39272543", "39272544"]
FLD_ASATO = ["39272547", "39272554", "39272555", "39272556", "39272557",
             "39272563", "39272564", "39272565", "39272566", "39272574"]

SOURCES = {
    "tnm": [f"{BASE}/tnm/47_1/392725_tnm_6697_op.gml"],
    "htd": [f"{BASE}/htd/47_1/392725_htd_6697_op.gml"],
    "lsld": [f"{BASE}/lsld/392725_lsld_6697_op.gml"],
    "fld": (
        [f"{BASE}/fld/pref/kokubagawa_kokubagawa/{m}_fld_6697_l2_op.gml"
         for m in FLD_KOKUBA]
        + [f"{BASE}/fld/pref/asatogawa_asatogawa-makabigawa-etc/{m}_fld_6697_l2_op.gml"
           for m in FLD_ASATO]
    ),
}


def grab(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return dest, dest.stat().st_size, "既存"
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(
        url, headers={"User-Agent": "jouto-walk/1.0 (PLATEAU world builder)"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
            n = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                n += len(chunk)
        return dest, n, "取得"
    except urllib.error.HTTPError as e:
        # 海域など元々無いメッシュは 404。飛ばしてよい（建物と同じ）
        dest.unlink(missing_ok=True)
        return dest, 0, f"HTTP {e.code}"
    except (urllib.error.URLError, TimeoutError) as e:
        dest.unlink(missing_ok=True)
        return dest, 0, f"失敗 {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kinds", nargs="*", default=[],
                    help=f"既定は全部: {', '.join(SOURCES)}")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    kinds = args.kinds or list(SOURCES)
    bad = [k for k in kinds if k not in SOURCES]
    if bad:
        sys.exit(f"知らない種別: {', '.join(bad)}")

    jobs = []
    for k in kinds:
        for url in SOURCES[k]:
            jobs.append((k, url, OUT / k / url.rsplit("/", 1)[1]))

    if args.dry_run:
        for k, url, dest in jobs:
            print(f"  {k}: {url.rsplit('/', 1)[1]}")
        print(f"{len(jobs)} ファイル")
        return

    total = 0
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(grab, url, dest): (k, dest) for k, url, dest in jobs}
        for fut in cf.as_completed(futs):
            k, dest = futs[fut]
            _, n, how = fut.result()
            total += n
            print(f"  {k}/{dest.name}: {how} {n / 1e6:.1f}MB", file=sys.stderr)
    print(f"合計 {total / 1e6:.0f}MB → {OUT}", file=sys.stderr)
    print("次: tools/build_hazard.py でタイルの格子へ焼き落とす", file=sys.stderr)


if __name__ == "__main__":
    main()
