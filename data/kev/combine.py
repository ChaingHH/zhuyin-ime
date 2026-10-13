"""離線掃描 LM + w·log P_kev 的句準。
用法：python combine.py <nbest.jsonl> <kev.jsonl> [--gate G]
gate：LM top1−top2 差距大於 G 時不翻（模仿 reranker 的 LM 信心門檻）。
"""
import json, os, sys

nb = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
kv = [json.loads(l) for l in open(sys.argv[2], encoding="utf-8") if l.strip()]
gates = [float(x) for x in sys.argv[3:]] or [1e9]
assert len(nb) == len(kv)
N = len(kv[0]["logp"]) if kv else 0


def acc(w, gate):
    ok = 0
    for s, k in zip(nb, kv):
        c = s["cands"][: len(k["logp"])]
        if not c:
            continue
        sc = [x["score"] + w * lp for x, lp in zip(c, k["logp"])]
        best = max(range(len(c)), key=lambda i: sc[i])
        if len(c) > 1 and c[0]["score"] - c[1]["score"] > gate:
            best = 0
        ok += c[best]["text"] == s["ref"]
    return ok / len(nb)


oracle = sum(any(x["text"] == s["ref"] for x in s["cands"][: len(k["logp"])]) for s, k in zip(nb, kv)) / len(nb)
print(f"n={len(nb)} oracle@top={oracle:.3f}")
for g in gates:
    row = [f"gate={g:g}"]
    for w in [float(x) for x in os.environ.get("W", "0 8 16 32 48 64 96 128 1000").split()]:
        row.append(f"w={w}:{acc(w, g):.3f}")
    print("  ".join(row))
