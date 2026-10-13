import {
  CompositionBuffer,
  DACHEN,
  Decoder,
  type DecodePath,
  type KeyEvent,
  type UserAdapter,
} from '@zhuyin/core';

const UNK = '\u25A1';

/** 測試台引擎：L0→L1→L2→（音節序列）→L4/L5，每次音節完成即全句重解碼。 */
export interface EngineState {
  /** 已完成音節的即時解碼預覽（top-1）＋未完成槽位顯示 */
  composition: string;
  candidates: DecodePath[];
  lastLegal: boolean;
}

/**
 * L6 非同步重排掛鉤（L7：先顯示 L5，重排完成再替換）。
 * 重排完成時若使用者已再打字／送出，結果視為過期丟棄；同時最多一個重排在跑。
 */
export interface RerankHooks {
  rerank: (paths: DecodePath[]) => Promise<DecodePath[]>;
  /** 重排完成、仍對應目前序列、且首選改變時呼叫 */
  onUpdate?: (state: EngineState) => void;
  /** 給重排用的 N-best 深度（L5 首選不受影響） */
  nBest?: number;
  /**
   * L7 防閃動：L6 改過的詞（與當時 L5 首選不同者）在本次組字的後續 L5 解碼中
   * 獲得此 log 加成，避免下一個音節又被 L5 改回去。軟性：新上下文證據夠強仍可推翻。0＝關閉。
   * 預設 4：評測子集上句準不變，L6→L5 回滾口語 −55%、書面 −34%（8 開始影響準確率）。
   */
  stickBonus?: number;
}

interface AlignedWord {
  word: string;
  seq: string[];
}

/** 依 breakdown.spanLen 把詞序對齊回音節序列。 */
export function alignWords(path: DecodePath, sequence: readonly string[]): AlignedWord[] {
  const out: AlignedWord[] = [];
  let i = 0;
  for (const b of path.breakdown) {
    out.push({ word: b.word, seq: sequence.slice(i, i + b.spanLen) });
    i += b.spanLen;
  }
  return out;
}

export class ImeEngine {
  private readonly comp: CompositionBuffer;
  private readonly decoder: Decoder;
  private adapter?: UserAdapter;
  private last: DecodePath[] = [];
  /** 每次序列改變（音節完成／送出）遞增；重排結果世代不符即過期 */
  private gen = 0;
  /** this.last 已是目前序列的重排結果 */
  private reranked = false;
  private inFlight = false;
  /** L6 改過的詞，鍵為 `起點:音節數:詞`（本次組字內有效） */
  private sticky = new Set<string>();
  /** 上次解碼時的已完成音節序列 */
  private seqKey = '';

  constructor(
    decoder: Decoder,
    legalSyllables: Iterable<string>,
    layout = DACHEN,
    adapter?: UserAdapter,
    private readonly hooks?: RerankHooks,
  ) {
    this.comp = new CompositionBuffer(layout, legalSyllables);
    this.decoder = decoder;
    this.adapter = adapter;
  }

  attachAdapter(a: UserAdapter): void {
    this.adapter = a;
  }

  get syllableSequence(): string[] {
    return this.comp.sequence;
  }

  private decodeWithAdapter(): DecodePath[] {
    const seq = this.comp.sequence;
    const adapt = this.adapter?.enabled ? this.adapter : undefined;
    const bonus = this.hooks?.stickBonus ?? 4;
    const sticky = bonus > 0 && this.sticky.size > 0 ? this.sticky : undefined;
    const modifier =
      adapt || sticky
        ? (w: string, pos: number, len: number) =>
            (adapt ? adapt.modifierFor(seq, w) : 0) +
            (sticky?.has(`${pos}:${len}:${w}`) ? bonus : 0)
        : undefined;
    return this.decoder.decode(seq, {
      modifier,
      nBest: this.hooks ? (this.hooks.nBest ?? 28) : undefined,
    });
  }

  /** 對最新的 L5 結果啟動重排；已有重排在跑則等它結束後再補跑最新的。 */
  private scheduleRerank(): void {
    const hooks = this.hooks;
    if (!hooks || this.inFlight || this.reranked || this.last.length < 2) return;
    const gen = this.gen;
    const shown = this.last[0]!;
    this.inFlight = true;
    hooks
      .rerank(this.unbiased(this.last))
      .then((out) => {
        if (gen !== this.gen || out.length === 0) return;
        this.last = out;
        this.reranked = true;
        // 記下 L6 改過的詞：同一起點、畫面上的 L5 首選放的是別的詞（或斷詞不同）
        const l5At = new Map<number, string>();
        let at = 0;
        for (const b of shown.breakdown) {
          l5At.set(at, b.word);
          at += b.spanLen;
        }
        at = 0;
        for (const b of out[0]!.breakdown) {
          if (b.word !== UNK && l5At.get(at) !== b.word)
            this.sticky.add(`${at}:${b.spanLen}:${b.word}`);
          at += b.spanLen;
        }
        if (out[0]!.words.join('') !== shown.words.join('')) hooks.onUpdate?.(this.state(true));
      })
      .catch(() => {
        /* L6 失敗不影響已顯示的 L5 結果 */
      })
      .finally(() => {
        this.inFlight = false;
        this.scheduleRerank();
      });
  }

  /**
   * 扣回防閃動加分、依原始分數重排：加分只穩定 L5 畫面，不能帶進 L6 的判斷
   * （否則早期上下文不足時的決定會一路偏差到最終結果）。
   */
  private unbiased(paths: DecodePath[]): DecodePath[] {
    const bonus = this.hooks?.stickBonus ?? 4;
    if (bonus <= 0 || this.sticky.size === 0) return paths;
    return paths
      .map((p) => {
        let score = p.score;
        let at = 0;
        for (const b of p.breakdown) {
          if (this.sticky.has(`${at}:${b.spanLen}:${b.word}`)) score -= bonus;
          at += b.spanLen;
        }
        return { ...p, score };
      })
      .sort((x, y) => y.score - x.score);
  }

  private state(lastLegal: boolean): EngineState {
    const top = this.last[0];
    return {
      composition: (top ? top.words.join('') : '') + this.comp.pendingDisplay,
      candidates: this.last,
      lastLegal,
    };
  }

  onKey(ev: KeyEvent): EngineState {
    const outcome = this.comp.onKeyEvent(ev);
    const seq = this.comp.sequence;
    const key = seq.join(' ');
    // candidates：本次按鍵有重解碼才回傳（replay 等呼叫端依此判斷），否則為空
    let candidates: DecodePath[] = [];
    // 已完成音節序列有變就重解碼：完成新音節，或 Backspace 退掉已完成音節
    if (key !== this.seqKey) {
      this.seqKey = key;
      this.gen++;
      this.reranked = false;
      // 序列縮短：超出新長度的防閃動記錄作廢
      for (const k of this.sticky) {
        const [pos, len] = k.split(':', 2).map(Number);
        if (pos! + len! > seq.length) this.sticky.delete(k);
      }
      candidates = seq.length > 0 ? this.decodeWithAdapter() : [];
      this.last = candidates;
      this.scheduleRerank();
    }
    // 畫面一律由最新解碼結果組成（未完成槽位的按鍵不應讓已解碼文字消失）
    return { ...this.state(outcome.legal), candidates };
  }

  /** 最近一次解碼的候選（供 `#n` 選字）。 */
  getCandidates(): DecodePath[] {
    return this.last;
  }

  /**
   * 送出：解碼（帶 U(w)）→ 學習 → 回傳文字並清空。
   * k>0 時改用第 k 候選（REPL `#n`），同樣納入學習訊號。
   *
   * 學習內容對應微軟注音「學習」分頁：
   * 1. 選字覆寫 → recordSelection（每次選字）
   * 2. 學習造詞 → 相鄰單字詞合併為新詞入格（每次送出）
   * （3. 使用者造詞詞典 → setUserPhrase，手動，見 CLI `phrase` 指令）
   */
  commit(k = 0): string {
    const seq = this.comp.sequence.slice();
    if (seq.length === 0) return '';
    // 已有目前序列的重排結果就用；否則同步取 L5（送出不等 BERT）
    const candidates = this.reranked ? this.last : this.decodeWithAdapter();
    const chosen = candidates[Math.min(k, candidates.length - 1)];
    let text = chosen ? chosen.words.join('') : '';
    text += this.comp.pendingDisplay;

    const adapter = this.adapter;
    if (adapter?.enabled && chosen) {
      const aligned = alignWords(chosen, seq);

      // 1) 選字覆寫學習（含非 top-1 的明示選擇——這是最強的使用者訊號）
      for (const w of aligned) {
        if (w.word !== UNK) adapter.recordSelection(w.seq, w.word);
      }

      // 2) 造詞挖掘：連續 ≥2 個單字詞且組合尚未存在 → 合併為新詞
      let bufChars = '';
      let bufSeq: string[] = [];
      const flush = (): void => {
        if ([...bufChars].length >= 2 && !this.decoder.hasEntry(bufSeq, bufChars)) {
          adapter.mineWord(bufChars, bufSeq);
          for (const e of adapter.drainPendingEntries()) {
            this.decoder.addEntry(e);
          }
        }
        bufChars = '';
        bufSeq = [];
      };
      for (const w of aligned) {
        if (w.word === UNK || [...w.word].length !== 1) {
          flush();
        } else {
          bufChars += w.word;
          bufSeq.push(...w.seq);
        }
      }
      flush();
    }

    this.comp.reset();
    this.gen++;
    this.last = [];
    this.reranked = false;
    this.sticky.clear();
    this.seqKey = '';
    return text.split(UNK).join('');
  }
}
