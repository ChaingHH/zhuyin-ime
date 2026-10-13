"""三項合併網格：LM + w1·A + w2·B。用法：python combine3.py <nbest> <A.jsonl> <B.jsonl>"""
import json, sys
ld = lambda p: [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
nb, A, B = ld(sys.argv[1]), ld(sys.argv[2]), ld(sys.argv[3])

def acc(w1, w2):
    ok = 0
    for s, a, b in zip(nb, A, B):
        c = s["cands"][: len(a["logp"])]
        sc = [x["score"] + w1 * p + w2 * q for x, p, q in zip(c, a["logp"], b["logp"])]
        ok += c[max(range(len(c)), key=sc.__getitem__)]["text"] == s["ref"]
    return ok / len(nb)

W1 = [0, 1, 2, 4, 8]; W2 = [0, 0.25, 0.5, 0.75, 1]
print("w1/w2 " + " ".join(f"{w:>6}" for w in W2))
for w1 in W1:
    print(f"{w1:>5} " + " ".join(f"{acc(w1, w2):6.3f}" for w2 in W2))
