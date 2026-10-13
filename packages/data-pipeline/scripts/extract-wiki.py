"""維基 parquet → jsonl 原文抽取（每 shard 取前 CAP 篇）。

用法：python extract-wiki.py [CAP] [OUT]；CAP=0 表示全量（大語料用 data/raw/wiki/wiki_full.jsonl）。
"""
import glob
import json
import sys

import pyarrow.parquet as pq

CAP = int(sys.argv[1]) if len(sys.argv) > 1 else 25000
out_path = sys.argv[2] if len(sys.argv) > 2 else r"data\raw\wiki\wiki_dump.jsonl"
total = 0
with open(out_path, "w", encoding="utf-8") as out:
    for f in sorted(glob.glob(r"data\raw\wiki\train-*.parquet")):
        t = pq.read_table(f, columns=["title", "text"])
        n = t.num_rows if CAP == 0 else min(CAP, t.num_rows)
        for row in t.slice(0, n).to_pylist():
            text = (row.get("text") or "").strip()
            if len(text) < 40:
                continue
            out.write(json.dumps({"title": row.get("title"), "text": text}, ensure_ascii=False) + "\n")
            total += 1
        print(f"{f}: {n} rows", flush=True)
print(f"total {total} -> {out_path}")
sys.exit(0)
