#!/usr/bin/env python3
"""git の履歴から開発ログ(changelog.json)を作る。

タイトル画面の「開発ログ」から読む。手書きの記録ではなく実際のコミットなので、
書き忘れも盛りもない。GitHub Actions では push のたびに作り直す
(そのため checkout は fetch-depth: 0 が要る)。

実行例:
  python3 tools/build_changelog.py --out public/data/changelog.json
"""
import argparse
import json
import os
import re
import subprocess
import sys

SEP = "\x1e"          # レコード区切り
FLD = "\x1f"          # フィールド区切り

# Conventional Commits の type を日本語の見出しに
KIND = {
    "feat": ("機能", "feat"),
    "fix": ("修正", "fix"),
    "docs": ("記録", "docs"),
    "refactor": ("整理", "refactor"),
    "perf": ("高速化", "perf"),
    "chore": ("雑務", "chore"),
    "test": ("テスト", "test"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--repo", default="https://github.com/shodai-nagamine/jouto-walk")
    args = ap.parse_args()

    fmt = FLD.join(["%H", "%h", "%ad", "%s", "%b"]) + SEP
    try:
        raw = subprocess.run(
            ["git", "log", f"-{args.limit}", "--date=format:%Y-%m-%d %H:%M", f"--pretty={fmt}"],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"git log に失敗: {e}", file=sys.stderr)
        raise SystemExit(1)

    items = []
    for rec in raw.split(SEP):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        full, short, date, subject, body = (rec.split(FLD) + ["", "", "", "", ""])[:5]
        # Co-Authored-By などのトレーラは表示しない
        lines = [
            l.rstrip() for l in body.splitlines()
            if l.strip() and not re.match(r"^(Co-Authored-By|Signed-off-by):", l.strip())
        ]
        m = re.match(r"^(\w+)(?:\([^)]*\))?:\s*(.+)$", subject)
        kind, tag = KIND.get(m.group(1), ("", "")) if m else ("", "")
        title = m.group(2) if m else subject
        items.append({
            "sha": short,
            "date": date,
            "kind": kind,
            "tag": tag,
            "title": title,
            "body": lines,
            "url": f"{args.repo}/commit/{full}",
        })

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump({"repo": args.repo, "items": items},
              open(args.out, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print(f"コミット {len(items)}件 → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
