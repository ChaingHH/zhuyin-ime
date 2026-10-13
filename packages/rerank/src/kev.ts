/**
 * L6 決策模型重排：Kev（TypeSafe Jev 的開源復刻，Apache-2.0）走 System One API。
 *
 * - choice（預設）：top-N 個不同字串當選項，一個請求取機率分布。
 * - noul：每個候選句當 state，問「是否通順正確」取 P(yes)，N 個請求。
 * - 最終分數 = LM 分數 + weight·log P；只評 top-N，其餘排在後面。
 * - 題目文字須與微調資料（debug-kev-train.ts）一致，否則微調效果打折。
 * - 實測（eval，Kev-4B，N=16，口語/書面句準）：
 *   舊 lm.json（基線 59.0/70.2%）：零樣本 noul w=48 → 68.2/79.6%；choice 微調 w=2 → 71.9/85.0%。
 *   新 lm.tsv（基線 76.7/80.4%）：choice 微調 16k 句（runs/zy-choice16k）w=3 → 80.4/89.0%。
 * - 伺服器：data/raw/kev，`python -m kev.serve --run <ckpt> --port 8009`；也可指向 TypeSafe 官方 Jev。
 */
import type { DecodePath } from '@zhuyin/core';

const Q_CHOICE =
  '使用者用注音輸入法打了一句話，下列候選讀音相同。哪一句是使用者真正想打的、最通順自然的正體中文句子？';
const Q_NOUL = '這是一句通順自然、用字正確的正體中文句子嗎？';

export interface KevOptions {
  url?: string;
  mode?: 'choice' | 'noul';
  weight?: number;
  top?: number;
  /** 本機 Kev 用 kev-latest；官方 Jev 用 jev-latest */
  model?: string;
  /** 官方 Jev 需要；本機 Kev 不用 */
  apiKey?: string;
}

export class KevReranker {
  readonly opts: Required<KevOptions>;

  constructor(opts: KevOptions = {}) {
    this.opts = {
      url: opts.url ?? 'http://127.0.0.1:8009/v1/systemone',
      mode: opts.mode ?? 'choice',
      weight: opts.weight ?? 3,
      top: opts.top ?? 16,
      model: opts.model ?? 'kev-latest',
      apiKey: opts.apiKey ?? process.env['TYPESAFE_API_KEY'] ?? 'local',
    };
  }

  async rerank(paths: readonly DecodePath[]): Promise<{ paths: DecodePath[]; elapsedMs: number }> {
    const t0 = performance.now();
    // 同字串不同斷詞只留第一個（分數最高）
    const seen = new Set<string>();
    const judged: DecodePath[] = [];
    const rest: DecodePath[] = [];
    for (const p of paths) {
      const text = p.words.join('');
      if (!seen.has(text) && judged.length < this.opts.top) {
        seen.add(text);
        judged.push(p);
      } else rest.push(p);
    }
    if (judged.length < 2) return { paths: [...paths], elapsedMs: performance.now() - t0 };

    const texts = judged.map((p) => p.words.join(''));
    const probs =
      this.opts.mode === 'choice'
        ? await this.choice(texts)
        : await Promise.all(texts.map((t) => this.noul(t)));
    const scored = judged
      .map((p, i) => ({
        ...p,
        score: p.score + this.opts.weight * Math.log(Math.max(probs[i]!, 1e-9)),
      }))
      .sort((x, y) => y.score - x.score);
    return { paths: [...scored, ...rest], elapsedMs: performance.now() - t0 };
  }

  private async choice(texts: string[]): Promise<number[]> {
    const criteria = Object.fromEntries(texts.map((t) => [t, null]));
    const ans = await this.post('', { type: 'choice', instructions: Q_CHOICE, criteria });
    const p = ans.probabilities as Record<string, number>;
    return texts.map((t) => p[t] ?? 0);
  }

  private async noul(state: string): Promise<number> {
    return (await this.post(state, { type: 'noul', instructions: Q_NOUL })).noul as number;
  }

  private async post(state: string, question: object): Promise<Record<string, unknown>> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ state, model: this.opts.model, questions: { q: question } }),
    });
    if (!res.ok) throw new Error(`Kev ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { answers: { q: Record<string, unknown> } }).answers.q;
  }
}
