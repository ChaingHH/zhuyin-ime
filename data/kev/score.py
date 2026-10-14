"""以 Kev（Jev 開源復刻）為 N-best 打分。
用法：python score.py <nbest.jsonl> <out.jsonl> [--mode choice|noul] [--top N] [--url URL]
輸出每行 {"logp": [...]}，對應 nbest 前 N 個候選（不足 N 則較短）。
"""
import argparse, json, math, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser()
ap.add_argument("inp"); ap.add_argument("out")
ap.add_argument("--mode", default="choice")
ap.add_argument("--top", type=int, default=16)
ap.add_argument("--url", default="http://127.0.0.1:8009/v1/systemone")
ap.add_argument("--q", default="")
a = ap.parse_args()

Q_CHOICE = a.q or "使用者用注音輸入法打了一句話，下列候選讀音相同。哪一句是使用者真正想打的、最通順自然的正體中文句子？"
Q_NOUL = a.q or "這是一句通順自然、用字正確的正體中文句子嗎？"


def post(body, tries=3):
    try:
        return _post(body)
    except Exception as e:
        if tries <= 1:
            raise
        print("retry:", e, file=sys.stderr, flush=True)
        return post(body, tries - 1)


def _post(body):
    req = urllib.request.Request(a.url, json.dumps(body).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["answers"]


def score(line):
    cands = [c["text"] for c in json.loads(line)["cands"][: a.top]]
    if len(cands) == 1:
        return [0.0]
    if a.mode == "choice":
        ans = post({"state": "", "model": "kev-latest", "questions": {
            "pick": {"type": "choice", "instructions": Q_CHOICE, "criteria": {c: None for c in cands}}}})
        p = ans["pick"]["probabilities"]
        return [math.log(max(p[c], 1e-9)) for c in cands]
    # noul：每個候選一個請求（state 不同）
    out = []
    for c in cands:
        p = post({"state": c, "model": "kev-latest", "questions": {
            "ok": {"type": "noul", "instructions": Q_NOUL}}})["ok"]["noul"]
        out.append(math.log(max(p, 1e-9)))
    return out


lines = [l for l in open(a.inp, encoding="utf-8") if l.strip()]
# 一次一個請求：並行送反而較慢
with ThreadPoolExecutor(1) as ex, open(a.out, "w", encoding="utf-8") as f:
    for i, lp in enumerate(ex.map(score, lines)):
        f.write(json.dumps({"logp": lp}) + "\n")
        if i % 100 == 0:
            print(i, file=sys.stderr, flush=True)
