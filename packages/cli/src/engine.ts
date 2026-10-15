import {
  CompositionBuffer,
  DACHEN,
  Decoder,
  type DecodePath,
  type FixedSpan,
  type KeyEvent,
  type Channel,
  type UserAdapter,
  isLiteralToken,
} from '@zhuyin/core';

const UNK = '\u25A1';

/** 測試台引擎：L0→L1→L2→（音節序列）→L4/L5，每次音節完成即全句重解碼。 */
export interface EngineState {
  /** 已完成音節的即時解碼預覽（top-1）＋未完成槽位顯示 */
  composition: string;
  candidates: DecodePath[];
  lastLegal: boolean;
  /** 英文模式下這次按鍵直接輸出的字元 */
  text?: string;
  /** 游標位置（第幾個字之前；0..字數）。選字視窗列的是從游標開始的詞（游標在最後時＝最後一個字） */
  cursor: number;
  /** 打到一半的注音（顯示在游標處；composition 裡也已插在游標處） */
  pending?: string;
  /** 選字視窗（開著時才有） */
  menu?: MenuView;
}

export interface MenuView {
  /** 本頁候選（最多 MENU_PAGE 個，按數字鍵 1–9 選） */
  items: string[];
  page: number;
  pages: number;
}

/** 選字視窗每頁幾個（數字鍵 1–9） */
const MENU_PAGE = 9;

/**
 * 注音模式的全形標點，鍵為 KeyboardEvent.key（美式鍵盤）。只收不跟大千注音鍵衝突的：
 * 大千佔掉 , . / ; - 與數字，所以這些要按 Shift。
 */
const PUNCT: Record<string, string> = {
  '<': '，',
  '>': '。',
  '?': '？',
  ':': '：',
  '"': '；',
  '!': '！',
  '[': '「',
  ']': '」',
  '{': '『',
  '}': '』',
  '(': '（',
  ')': '）',
  '\\': '、',
  '~': '～',
};

export type InputMode = 'zhuyin' | 'english';

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
   * 預設 4：全評測集（1500 句）L6→L5 回滾口語 0.82→0.50、書面 1.11→0.70（約 −40%），
   * 口語句準不變、書面 dev −0.8（6 起口語句準下降）。見 debug-lock.ts。
   */
  stickBonus?: number;
}

interface AlignedWord {
  word: string;
  seq: string[];
}

/**
 * 詞序對齊到讀音。用 breakdown.reading（L3 更正後的意圖音節）而非觀察音節：
 * 否則 X2 會把「打錯的讀音 → 詞」當成使用者習慣學起來。
 */
export function alignWords(path: DecodePath): AlignedWord[] {
  return path.breakdown.map((b) => ({ word: b.word, seq: [...b.reading] }));
}

/**
 * 序列從 a 改成 b：前後相同的部分不動，中間被換掉。回傳「a 裡的詞段 [pos, pos+len) 在 b 的起點」，
 * 詞段碰到被換掉的範圍就回 null。
 */
function remapper(a: readonly string[], b: readonly string[]) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return (pos: number, len: number): number | null =>
    pos + len <= p ? pos : pos >= a.length - s ? pos + b.length - a.length : null;
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
  private lastSeq: string[] = [];
  /** L3 通道模型；設定後解碼會考慮打錯／模糊音的更正 */
  channel?: Channel;
  /** 英文模式：按鍵不進 L1/L2，直接輸出字元 */
  mode: InputMode = 'zhuyin';
  /** 使用者選字固定的詞段（本次組字內有效；解碼硬性遵守） */
  private fixed: FixedSpan[] = [];
  /** 選字視窗：候選與目前頁 */
  private menu: { items: FixedSpan[]; page: number } | null = null;

  constructor(
    decoder: Decoder,
    legalSyllables: Iterable<string>,
    layout = DACHEN,
    adapter?: UserAdapter,
    private hooks?: RerankHooks,
  ) {
    this.comp = new CompositionBuffer(layout, legalSyllables);
    this.decoder = decoder;
    this.adapter = adapter;
  }

  attachAdapter(a: UserAdapter): void {
    this.adapter = a;
  }

  /**
   * 換掉 L6（undefined＝關閉）。進行中的重排結果作廢，防閃動記錄清空：
   * 舊重排器的判斷不該延續到新重排器。下一次按鍵才用新設定重解碼。
   */
  setRerankHooks(h?: RerankHooks): void {
    this.hooks = h;
    this.gen++;
    this.reranked = false;
    this.sticky.clear();
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
    const paths = this.decoder.decode(seq, {
      modifier,
      nBest: this.hooks ? (this.hooks.nBest ?? 28) : undefined,
      alternatives: this.alternatives(seq),
      fixed: this.fixed,
    });
    // 同樣的字、不同斷詞（我|應該 vs 我應|該）在 N-best 裡是不同路徑：
    // 候選清單只留分數最高的那條（paths 已依分數排序）。L6 也只看得到不重複的文字。
    const seen = new Set<string>();
    return paths.filter((p) => {
      const text = p.words.join('');
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  private alternatives(seq: readonly string[]) {
    return this.channel ? seq.map((s) => this.channel!.expand(s)) : undefined;
  }

  private get cursor(): number {
    return this.comp.cursor;
  }

  /** 選字視窗的起點：游標後面那個字；游標在最後時取最後一個字（同微軟注音） */
  private get menuStart(): number {
    return Math.min(this.cursor, this.comp.sequence.length - 1);
  }

  /**
   * 從游標開始的所有候選詞（微軟注音的選字視窗）。
   */
  private menuItems(): FixedSpan[] {
    const seq = this.comp.sequence;
    const start = this.menuStart;
    const alts = this.alternatives(seq);
    const exact: FixedSpan[] = [];
    const corrected: Array<FixedSpan & { cost: number }> = [];
    for (let len = seq.length - start; len >= 1; len--) {
      for (const c of this.decoder.spanCands(seq, start, len, alts, Infinity)) {
        const f = { pos: start, len, word: c.word };
        if (c.cost === 0) exact.push(f);
        else corrected.push({ ...f, cost: c.cost });
      }
    }
    // 照打讀音的詞先列（長詞在前、同長度依詞頻）；L3 更正讀音的詞依代價排在最後
    corrected.sort((x, y) => x.cost - y.cost);
    return [...exact, ...corrected.map(({ pos, len, word }) => ({ pos, len, word }))];
  }

  /** 選定候選：固定該詞段（擠掉與它重疊的舊選擇），重解碼 */
  private select(f: FixedSpan): void {
    this.fixed = this.fixed.filter((x) => x.pos + x.len <= f.pos || f.pos + f.len <= x.pos);
    this.fixed.push(f);
    this.menu = null;
    this.redecode();
  }

  private redecode(): void {
    this.gen++;
    this.reranked = false;
    this.last = this.comp.sequence.length > 0 ? this.decodeWithAdapter() : [];
    this.scheduleRerank();
  }

  /** 選字視窗開著時的按鍵：數字選字、↓／空白下一頁、↑上一頁、Enter 選第一個、Esc 關閉 */
  private onMenuKey(code: string): EngineState {
    const m = this.menu!;
    const pages = Math.ceil(m.items.length / MENU_PAGE);
    const pageItems = m.items.slice(m.page * MENU_PAGE, (m.page + 1) * MENU_PAGE);
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit && pageItems[Number(digit[1]) - 1]) this.select(pageItems[Number(digit[1]) - 1]!);
    else if (code === 'Enter' && pageItems[0]) this.select(pageItems[0]);
    else if (code === 'ArrowDown' || code === 'Space') m.page = (m.page + 1) % pages;
    else if (code === 'ArrowUp') m.page = (m.page + pages - 1) % pages;
    else if (code === 'Escape' || code === 'Backspace') this.menu = null;
    return this.state(true);
  }

  /** 游標與開視窗：←→ Home End 移游標（以字為單位）、↓ 開選字視窗（從游標後面那個字開始的詞） */
  private onNavKey(code: string): EngineState | null {
    const n = this.comp.sequence.length;
    if (n === 0 || this.comp.pendingDisplay !== '') return null;
    if (code === 'ArrowLeft') this.comp.setCursor(Math.max(0, this.cursor - 1));
    else if (code === 'ArrowRight') this.comp.setCursor(this.cursor + 1);
    else if (code === 'Home') this.comp.setCursor(0);
    else if (code === 'End') this.comp.setCursor(n);
    else if (code === 'ArrowDown') {
      const items = this.menuItems();
      if (items.length > 0) this.menu = { items, page: 0 };
    } else return null;
    return this.state(true);
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
    const m = this.menu;
    const pending = this.comp.pendingDisplay;
    return {
      composition: this.withPending(this.last[0]),
      candidates: this.last,
      lastLegal,
      cursor: this.cursor,
      pending: pending || undefined,
      menu: m
        ? {
            items: m.items.slice(m.page * MENU_PAGE, (m.page + 1) * MENU_PAGE).map((f) => f.word),
            page: m.page,
            pages: Math.ceil(m.items.length / MENU_PAGE),
          }
        : undefined,
    };
  }

  /** 首選文字，打到一半的注音插在游標處（每個音節一個字，所以字的索引＝音節索引） */
  private withPending(path: DecodePath | undefined): string {
    const chars = [...(path ? path.words.join('') : '')];
    chars.splice(this.cursor, 0, this.comp.pendingDisplay);
    return chars.join('');
  }

  /**
   * 切換注音／英文。「單按 Shift」要看放開事件，由前端偵測後呼叫這裡。
   * 組字區未送出的內容先送出（回傳送出的文字），避免切到英文後留著半句注音。
   */
  toggleMode(): string {
    const text = this.commit();
    this.mode = this.mode === 'zhuyin' ? 'english' : 'zhuyin';
    return text;
  }

  onKey(ev: KeyEvent): EngineState {
    if (this.mode === 'english') {
      const ch = ev.key !== undefined && [...ev.key].length === 1 ? ev.key : undefined;
      return { composition: '', candidates: [], lastLegal: true, text: ch, cursor: 0 };
    }
    if (this.menu) return this.onMenuKey(ev.code);
    // Esc（選字視窗沒開）：放棄整段組字，同微軟注音
    if (ev.code === 'Escape') {
      this.clear();
      return this.state(true);
    }
    // 標點、空白鍵（沒有未完成注音時）：組字區空的就直接輸出；
    // 有字就當原樣字元插在游標處，跟著一起送出（還沒確定就能加，游標在中間也行）。
    // 打到一半的注音時：空白是一聲，標點不收（先把注音打完或退掉）
    const punct = ev.key !== undefined ? PUNCT[ev.key] : undefined;
    const literal = punct ?? (ev.code === 'Space' ? ' ' : undefined);
    let inserted = false;
    if (literal !== undefined && this.comp.pendingDisplay === '') {
      if (this.comp.isEmpty)
        return { composition: '', candidates: [], lastLegal: true, text: literal, cursor: 0 };
      inserted = this.comp.pushLiteral(literal);
    } else if (punct) return this.state(true);
    const nav = this.onNavKey(ev.code);
    if (nav) return nav;
    const outcome = inserted ? { accepted: true, legal: true } : this.comp.onKeyEvent(ev);
    const seq = this.comp.sequence;
    // candidates：本次按鍵有重解碼才回傳（replay 等呼叫端依此判斷），否則為空
    let candidates: DecodePath[] = [];
    // 已完成音節序列有變就重解碼：完成新音節、插入空格標點、Backspace／Delete 刪掉音節
    if (seq.length !== this.lastSeq.length || seq.some((x, i) => x !== this.lastSeq[i])) {
      // 選字與防閃動記錄跟著平移；落在被改動範圍內的作廢
      const map = remapper(this.lastSeq, seq);
      this.fixed = this.fixed.flatMap((f) => {
        const pos = map(f.pos, f.len);
        return pos === null ? [] : [{ ...f, pos }];
      });
      this.sticky = new Set(
        [...this.sticky].flatMap((k) => {
          const [p, l, w] = k.split(':', 3);
          const pos = map(Number(p), Number(l));
          return pos === null ? [] : [`${pos}:${l}:${w}`];
        }),
      );
      this.lastSeq = seq;
      this.gen++;
      this.reranked = false;
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
   * 3. 使用者造詞詞典 → setUserPhrase：選字視窗選過的詞、或含選過的字的那串單字，
   *    存成使用者詞（加成壓過 LM 差距）。改過一次，下次同讀音就是它。
   *    （手動造詞另見 CLI `phrase` 指令）
   */
  commit(k = 0): string {
    const seq = this.comp.sequence.slice();
    if (seq.length === 0) return '';
    // 已有目前序列的重排結果就用；否則同步取 L5（送出不等 BERT）
    const candidates = this.reranked ? this.last : this.decodeWithAdapter();
    const chosen = candidates[Math.min(k, candidates.length - 1)];
    const text = this.withPending(chosen);

    const adapter = this.adapter;
    if (adapter?.enabled && chosen) {
      const aligned = alignWords(chosen);

      // 1) 選字覆寫學習（含非 top-1 的明示選擇——這是最強的使用者訊號）
      for (const w of aligned) {
        if (w.word !== UNK && !isLiteralToken(w.seq[0]!)) adapter.recordSelection(w.seq, w.word);
      }

      // 2) 造詞挖掘：連續 ≥2 個單字詞且組合尚未存在 → 合併為新詞
      // 3) 這串字裡有使用者選過的字、或選過的多字詞 → 使用者詞
      // ponytail: 長度取「連續單字」整串，「他坐沒坐相」會整串存；要精確長度再加手動造詞鍵
      const picked = new Set(this.fixed.map((f) => `${f.pos}:${f.word}`));
      const addUser = (word: string, reading: string[]): void => {
        adapter.setUserPhrase(word, reading);
        if (!this.decoder.hasEntry(reading, word))
          this.decoder.addEntry({ word, readings: [reading], provenance: ['user'] });
      };
      let bufChars = '';
      let bufSeq: string[] = [];
      let bufPicked = false;
      const flush = (): void => {
        if ([...bufChars].length >= 2 && bufPicked) addUser(bufChars, bufSeq);
        else if ([...bufChars].length >= 2 && !this.decoder.hasEntry(bufSeq, bufChars)) {
          adapter.mineWord(bufChars, bufSeq);
          for (const e of adapter.drainPendingEntries()) {
            this.decoder.addEntry(e);
          }
        }
        bufChars = '';
        bufSeq = [];
        bufPicked = false;
      };
      let at = 0;
      for (const w of aligned) {
        const isPicked = picked.has(`${at}:${w.word}`);
        // 空格等原樣字元是詞界：不併進造詞
        if (w.word === UNK || [...w.word].length !== 1 || isLiteralToken(w.seq[0]!)) {
          flush();
          if (isPicked && [...w.word].length > 1) addUser(w.word, w.seq);
        } else {
          bufChars += w.word;
          bufSeq.push(...w.seq);
          bufPicked ||= isPicked;
        }
        at += w.seq.length;
      }
      flush();
    }

    this.clear();
    return text.split(UNK).join('');
  }

  /** 清空組字區，不送出、不學習（Esc；送出後也走這裡） */
  clear(): void {
    this.comp.reset();
    this.gen++;
    this.last = [];
    this.reranked = false;
    this.sticky.clear();
    this.lastSeq = [];
    this.fixed = [];
    this.menu = null;
  }
}
