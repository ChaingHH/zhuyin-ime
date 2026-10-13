import { type KeyEvent, type Syllable, type Tone, isFinal, isInitial, isMedial } from './index.js';
import { mapKey, type KeyboardLayout, type MappedKey } from './keymap.js';

/**
 * L2 槽位組字區：注音符號流 → 音節序列。
 *
 * 四槽互斥、依符號類別填入——槽位法**免費吸收音節內的按鍵順序顛倒**
 * （錄製資料 25.5%），L3 不得重做此類容錯。
 * 顯示一律以 C-M-F-T 正規順序輸出。
 */
export interface FeedOutcome {
  accepted: boolean;
  /** 該次輸入完成了一個音節時提供 */
  completed?: Syllable;
  /** 完成的音節是否在合法音節表內 */
  legal: boolean;
}

interface PartialSlots {
  initial?: string;
  medial?: string;
  final?: string;
}

export class CompositionBuffer {
  private readonly layout: KeyboardLayout;
  private readonly legalSyllables: ReadonlySet<string>;
  /** 已完成的音節（正規形） */
  private readonly done: Syllable[] = [];
  private partial: PartialSlots = {};
  /** 部分槽位的插入歷史，供 Backspace 回退 */
  private history: Array<'initial' | 'medial' | 'final'> = [];

  constructor(layout: KeyboardLayout, legalSyllables: Iterable<string>) {
    this.layout = layout;
    this.legalSyllables = new Set(legalSyllables);
  }

  get completedCount(): number {
    return this.done.length;
  }

  /** 已完成音節的正規形序列。 */
  get sequence(): string[] {
    return this.done.map(canonical);
  }

  /** 未完成部分的顯示字串（C-M-F 順序）。 */
  get pendingDisplay(): string {
    const p = this.partial;
    return `${p.initial ?? ''}${p.medial ?? ''}${p.final ?? ''}`;
  }

  get isEmpty(): boolean {
    return this.done.length === 0 && this.history.length === 0;
  }

  onKeyEvent(ev: KeyEvent): FeedOutcome {
    if (ev.code === 'Backspace') {
      this.backspace();
      return { accepted: true, legal: true };
    }
    for (const mapped of mapKey(this.layout, ev.code)) {
      const out = this.feed(mapped, ev.timestampMs);
      if (out) return out;
    }
    return { accepted: false, legal: true };
  }

  private feed(mapped: MappedKey, _t: number): FeedOutcome | null {
    if (mapped.kind === 'tone') {
      if (this.history.length === 0 && this.done.length > 0) {
        // 空白連按＝重複前一音節？大千慣例不支援；視為未接受
        return null;
      }
      if (this.history.length === 0) return null;
      const syl: Syllable = { ...this.partial, tone: mapped.tone };
      const canonicalForm = canonical(syl);
      this.done.push(syl);
      this.partial = {};
      this.history = [];
      return {
        accepted: true,
        completed: syl,
        legal: this.legalSyllables.has(canonicalForm),
      };
    }
    if (mapped.kind !== 'symbol') return null;

    const s = mapped.symbol;
    // 槽位法核心：各符號按類別填自己的槽，**與到達順序無關**（音節內顛倒在此免費吸收）。
    const slot = isInitial(s) ? 'initial' : isMedial(s) ? 'medial' : isFinal(s) ? 'final' : null;
    if (slot === null) return null;
    // 同槽再按＝覆蓋（後按的取代先按的，與微軟注音一致）。
    // 該槽移到退格歷史最後：接著 Backspace 刪的是剛按的符號，不還原被覆蓋者。
    // 「覆蓋前那個才是對的」這類機率判斷留給 L3。
    if (this.partial[slot] !== undefined) this.history = this.history.filter((h) => h !== slot);
    this.partial[slot] = s;
    this.history.push(slot);
    return { accepted: true, legal: true };
  }

  /** Backspace：先退部分槽位，再退已完成音節。回傳是否有變動。 */
  backspace(): boolean {
    const last = this.history.pop();
    if (last) {
      delete this.partial[last];
      return true;
    }
    if (this.done.length > 0) {
      this.done.pop();
      return true;
    }
    return false;
  }

  /** 清空組字區（送出後呼叫）。 */
  reset(): void {
    this.done.length = 0;
    this.partial = {};
    this.history = [];
  }
}

export function canonical(s: Syllable): string {
  const marks: Record<Tone, string> = { 1: '', 2: 'ˊ', 3: 'ˇ', 4: 'ˋ', 5: '˙' };
  return `${s.initial ?? ''}${s.medial ?? ''}${s.final ?? ''}${marks[s.tone]}`;
}
