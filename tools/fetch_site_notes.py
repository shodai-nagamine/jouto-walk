#!/usr/bin/env python3
"""史跡の説明を「出典のある文」だけ集める。

**自分で説明を書かない。** 289 件の史跡に機械が解説を書くと、史実でないことを
史実として公開物に載せることになる。議事の要約を言い換えなかったのと同じ理由。
集めるのは次の 2 つだけで、どちらも出典を必ず一緒に持つ:

  1. OSM の `inscription` / `description`（碑文そのもの、現地案内板の写し）
  2. Wikipedia 日本語版の冒頭文（CC BY-SA 4.0。出典表示が要る）

出典が無いものは説明を持たない。それでよい（名前と種別は出る）。

  ~/dev/tools/blender-mcp/.venv/bin/python tools/fetch_site_notes.py

出力は public/data/site_notes.json（史跡名 -> {text, src, url}）。
"""
import argparse
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

NAHA = pathlib.Path.home() / "dev/tools/blender-mcp/data/naha"
UA = "jouto-walk/1.0 (https://github.com/shodai-nagamine/jouto-walk)"
API = "https://ja.wikipedia.org/api/rest_v1/page/summary/"


def wiki_summary(title):
    """日本語版 Wikipedia の冒頭（extract）と記事 URL。"""
    url = API + urllib.parse.quote(title.replace(" ", "_"))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode("utf-8"))
    ex = (d.get("extract") or "").strip()
    page = (d.get("content_urls", {}).get("desktop", {}) or {}).get("page", "")
    return ex, page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm", default=str(NAHA / "naha_historic_osm.json"))
    ap.add_argument("--out", default="public/data/site_notes.json")
    ap.add_argument("--max-chars", type=int, default=320)
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    els = json.loads(pathlib.Path(args.osm).read_text())["elements"]

    notes = {}
    n_osm = n_wp = 0
    for e in els:
        t = e.get("tags") or {}
        name = t.get("name") or t.get("name:ja")
        if not name:
            continue
        # 1) OSM の碑文・説明。現地の案内板や碑そのものの文なので出典が明快
        body = t.get("inscription") or t.get("description")
        if body:
            notes[name] = {
                "text": body.strip()[:args.max_chars],
                "src": "OpenStreetMap",
                "url": "https://www.openstreetmap.org/copyright",
            }
            n_osm += 1

        # 2) 日本語版 Wikipedia の冒頭。OSM の説明より詳しいので上書きしてよい
        wp = t.get("wikipedia") or ""
        if wp.startswith("ja:"):
            title = wp[3:]
            try:
                ex, page = wiki_summary(title)
            except Exception as err:
                print(f"  {name}: Wikipedia 失敗 ({err})")
                continue
            if ex:
                # 冒頭の 2 文まで。丸ごと載せない
                sents = re.split(r"(?<=。)", ex)
                text = "".join(sents[:2]).strip()[:args.max_chars]
                notes[name] = {"text": text, "src": "Wikipedia 日本語版",
                               "url": page or f"https://ja.wikipedia.org/wiki/{title}"}
                n_wp += 1
            time.sleep(0.4)          # Wikipedia に連続で投げない

    outp = root / args.out
    outp.write_text(json.dumps(notes, ensure_ascii=False,
                               separators=(",", ":")) + "\n")
    print(f"説明 {len(notes)} 件（OSM {n_osm} / Wikipedia {n_wp}）"
          f" → {outp} ({outp.stat().st_size / 1024:.0f}KB)")


if __name__ == "__main__":
    main()
