"""多項合併網格：LM + Σ w_i·feat_i。用法：python combinen.py <domain> <feat1> <feat2> ...（feat 檔名需有 -col/-wri 兩版，傳前綴）
在兩個集合都報告，挑兩集合平均最高者，避免對單一集合過擬合。"""
import itertools, json, sys
ld = lambda p: [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
feats = sys.argv[1:]
sets = {d: (ld(f"nbest-{n}.jsonl"), [ld(f"{f}-{d}.jsonl") for f in feats]) for d, n in [("col", "colloquial"), ("wri", "written")]}
GRID = {"ftc-choice": [0, 1, 2, 3], "ft-noul": [0, 1, 2, 4], "causal": [0, 0.25, 0.5, 0.75], "k4-noul": [0, 8, 16, 32]}

def acc(d, ws):
    nb, F = sets[d]; ok = 0
    for i, s in enumerate(nb):
        n = min(len(f[i]["logp"]) for f in F); c = s["cands"][:n]
        sc = [c[j]["score"] + sum(w * f[i]["logp"][j] for w, f in zip(ws, F)) for j in range(n)]
        ok += c[max(range(n), key=sc.__getitem__)]["text"] == s["ref"]
    return ok / len(nb)

res = sorted(((acc("col", ws) + acc("wri", ws)) / 2, ws) for ws in itertools.product(*(GRID[f] for f in feats)))
for avg, ws in res[-5:]:
    print(dict(zip(feats, ws)), f"col={acc('col', ws):.3f} wri={acc('wri', ws):.3f} avg={avg:.3f}")
