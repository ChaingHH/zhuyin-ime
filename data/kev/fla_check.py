"""檢查 fla 的 chunk_gated_delta_rule 在本機 GPU 能編譯、前向反向可跑，且與 transformers 參考實作一致。"""
import torch, time
from fla.ops.gated_delta_rule import chunk_gated_delta_rule
from transformers.models.qwen3_5 import modeling_qwen3_5 as m
torch.manual_seed(0)
B, T, H, D = 1, 256, 4, 64
q, k, v = (torch.randn(B, T, H, D, device="cuda", dtype=torch.bfloat16, requires_grad=True) for _ in range(3))
g = (-torch.rand(B, T, H, device="cuda")).requires_grad_()
beta = torch.rand(B, T, H, device="cuda").sigmoid().requires_grad_()
o, _ = chunk_gated_delta_rule(q, k, v, g, beta, use_qk_l2norm_in_kernel=True)
o.float().sum().backward()
ref = getattr(m.torch_chunk_gated_delta_rule, "__wrapped__", m.torch_chunk_gated_delta_rule)
with torch.no_grad():
    r, _ = ref(q, k, v, g, beta, use_qk_l2norm_in_kernel=True)
print("ok, grad finite:", torch.isfinite(q.grad).all().item(), "max|fla-ref|:", (o.float() - r.float()).abs().max().item())
