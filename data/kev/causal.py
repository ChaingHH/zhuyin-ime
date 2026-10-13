"""對照組：用因果 LM（預設 Qwen3.5-4B-Base）算候選句的 log P(句子)，輸出格式同 score.py。
用法：python causal.py <nbest.jsonl> <out.jsonl> [--model ID] [--top N]
"""
import argparse, json, sys
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ap = argparse.ArgumentParser()
ap.add_argument("inp"); ap.add_argument("out")
ap.add_argument("--model", default="Qwen/Qwen3.5-4B-Base")
ap.add_argument("--top", type=int, default=16)
a = ap.parse_args()

tok = AutoTokenizer.from_pretrained(a.model)
model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16).cuda().eval()
bos = tok.bos_token_id if tok.bos_token_id is not None else tok.eos_token_id


@torch.no_grad()
def logp(texts):
    enc = [[bos] + tok(t, add_special_tokens=False)["input_ids"] for t in texts]
    L = max(map(len, enc))
    ids = torch.full((len(enc), L), tok.pad_token_id or 0)
    mask = torch.zeros((len(enc), L), dtype=torch.long)
    for i, e in enumerate(enc):
        ids[i, : len(e)] = torch.tensor(e); mask[i, : len(e)] = 1
    ids, mask = ids.cuda(), mask.cuda()
    lg = model(input_ids=ids, attention_mask=mask).logits.float().log_softmax(-1)
    tgt = lg[:, :-1].gather(-1, ids[:, 1:, None])[..., 0] * mask[:, 1:]
    return tgt.sum(-1).tolist()


with open(a.out, "w", encoding="utf-8") as f:
    for i, line in enumerate(open(a.inp, encoding="utf-8")):
        if not line.strip():
            continue
        cands = [c["text"] for c in json.loads(line)["cands"][: a.top]]
        f.write(json.dumps({"logp": logp(cands)}) + "\n")
        if i % 100 == 0:
            print(i, file=sys.stderr, flush=True)
