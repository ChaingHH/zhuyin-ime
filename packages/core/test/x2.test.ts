import { describe, it, expect } from 'vitest';
import { UserAdapter, X2_LIMITS, type UserAdapterData } from '../src/index.js';

const T0 = 1_700_000_000_000;

describe('X2 UserAdapter', () => {
  it('kill-switch：關閉時恆回 0，開啟但無記錄也回 0', () => {
    const a = new UserAdapter();
    expect(a.modifierFor(['ㄅㄚ'], '巴', T0)).toBe(0);
    a.recordSelection(['ㄅㄚ'], '巴', T0);
    expect(a.modifierFor(['ㄅㄚ'], '巴', T0)).toBeGreaterThan(0);
    a.setEnabled(false);
    expect(a.modifierFor(['ㄅㄚ'], '巴', T0)).toBe(0);
    // 重新開啟後記錄仍在
    a.setEnabled(true);
    expect(a.modifierFor(['ㄅㄚ'], '巴', T0)).toBeGreaterThan(0);
  });

  it('加成有界：seq 封頂於 maxSeqBoost，加全域弱訊號後仍有上界', () => {
    const a = new UserAdapter({ maxSeqBoost: 2.2 });
    const seq = ['ㄍㄠˇ'];
    for (let i = 0; i < 100; i++) {
      a.recordSelection(seq, '搞', T0);
    }
    const u = a.modifierFor(seq, '搞', T0);
    // seq 部分封頂 2.2；全域部分 ≤ (maxSeqBoost/2)·globalFactor
    expect(u).toBeGreaterThanOrEqual(2.2 - 1e-9);
    expect(u).toBeLessThan(2.2 + (2.2 / 2) * 0.35 + 1e-9);
  });

  it('時間衰減：14 天半衰期', () => {
    const a = new UserAdapter();
    const seq = ['ㄇㄚ˙'];
    a.recordSelection(seq, '嗎', T0);
    const uNow = a.modifierFor(seq, '嗎', T0);
    const u14d = a.modifierFor(seq, '嗎', T0 + 14 * 86_400_000);
    expect(u14d).toBeCloseTo(uNow / 2, 5);
  });

  it('上下文專屬性：A 上下文的選字不直接加成 B 上下文（僅全域弱訊號）', () => {
    const a = new UserAdapter();
    a.recordSelection(['ㄐㄧㄣ'], '金', T0);
    const uSame = a.modifierFor(['ㄐㄧㄣ'], '金', T0);
    const uOther = a.modifierFor(['ㄊㄧㄢ'], '金', T0);
    expect(uOther).toBeLessThan(uSame);
    expect(uOther).toBeGreaterThan(0); // 全域弱訊號存在
  });

  it('非台灣繁體字的使用者詞不入格（舊 adapter.json）', () => {
    const a = new UserAdapter();
    a.setUserPhrase('顔色', ['ㄧㄢˊ', 'ㄙㄜˋ']);
    a.setUserPhrase('顏色', ['ㄧㄢˊ', 'ㄙㄜˋ']);
    expect(a.drainPendingEntries().map((e) => e.word)).toEqual(['顏色']);
  });

  it('手動造詞加成強於一般選字且有別於挖詞', () => {
    const a = new UserAdapter();
    a.setUserPhrase('屑屑', ['ㄒㄧㄝˋ', '˙ㄒㄧㄝ']);
    expect(a.phrases.get('屑屑')?.manual).toBe(true);
    expect(a.modifierFor(['ㄒㄧㄝˋ', '˙ㄒㄧㄝ'], '屑屑', T0)).toBe(8.0);

    a.mineWord('聯準會', ['ㄌㄧㄢˊ', 'ㄓㄨㄣˇ', 'ㄏㄨㄟˋ'], T0);
    expect(a.modifierFor(['ㄌㄧㄢˊ', 'ㄓㄨㄣˇ', 'ㄏㄨㄟˋ'], '聯準會', T0)).toBe(0);
  });

  it('重複挖同一詞只計頻不重建', () => {
    const a = new UserAdapter();
    expect(a.mineWord('降息', ['ㄐㄧㄤˋ', 'ㄒㄧˊ'], T0)).toBe(true);
    expect(a.mineWord('降息', ['ㄐㄧㄤˋ', 'ㄒㄧˊ'], T0)).toBe(false);
    expect(a.phrases.get('降息')?.freq).toBe(2);
  });

  it('JSON 往返保存記錄與詞條', () => {
    const a = new UserAdapter();
    a.recordSelection(['ㄉㄜ˙'], '的', T0);
    a.setUserPhrase('本機', ['ㄅㄣˇ', 'ㄐㄧ']);
    const b = UserAdapter.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), undefined, T0);
    expect(b.modifierFor(['ㄉㄜ˙'], '的', T0)).toBe(a.modifierFor(['ㄉㄜ˙'], '的', T0));
    expect(b.phrases.get('本機')?.manual).toBe(true);
  });

  it('有上限：衰減完的刪掉、超過上限刪最弱的、手動造詞不因衰減消失', () => {
    const a = new UserAdapter();
    const day = 86_400_000;
    a.recordSelection(['ㄅㄚ'], '巴', T0);
    for (let i = 0; i < 5; i++) a.recordSelection(['ㄇㄚ'], '媽', T0 + 90 * day);
    a.setUserPhrase('本機', ['ㄅㄣˇ', 'ㄐㄧ']);
    a.mineWord('降息', ['ㄐㄧㄤˋ', 'ㄒㄧˊ'], T0);
    a.compact(T0 + 100 * day);
    // 巴：次數 1、100 天 → 衰減到 0.007，刪；媽：5 次、10 天前 → 留；挖詞 100 天前 1 次 → 刪
    expect(a.modifierFor(['ㄅㄚ'], '巴', T0 + 100 * day)).toBe(0);
    expect(a.modifierFor(['ㄇㄚ'], '媽', T0 + 100 * day)).toBeGreaterThan(0);
    expect(a.phrases.has('降息')).toBe(false);
    expect(a.phrases.get('本機')?.manual).toBe(true);
    // 超過上限：只留最強的 maxSeq 筆
    const b = new UserAdapter();
    for (let i = 0; i <= X2_LIMITS.maxSeq; i++) b.recordSelection([`k${i}`], 'w', T0 + i);
    b.compact(T0 + X2_LIMITS.maxSeq);
    const seqs = Object.keys(b.toJSON().bySeq);
    expect(seqs.length).toBe(X2_LIMITS.maxSeq);
    expect(seqs[0]).toBe('k1');
  });

  it('舊記錄再選一次：次數先衰減再 +1', () => {
    const a = new UserAdapter();
    for (let i = 0; i < 100; i++) a.recordSelection(['ㄍㄠˇ'], '搞', T0);
    const later = T0 + 140 * 86_400_000; // 10 個半衰期
    a.recordSelection(['ㄍㄠˇ'], '搞', later);
    const c = a.toJSON().bySeq['ㄍㄠˇ']!['搞']!.count;
    expect(c).toBeCloseTo(100 / 1024 + 1, 9);
  });

  it('載入：時鐘跳到一年後不整理；壞欄位的記錄丟掉', () => {
    const rec = { count: 1, lastAt: T0 };
    const data = {
      bySeq: { k: { 好: rec, 壞: { count: 'x', lastAt: T0 } } },
      global: { 好: rec, 缺: { count: 1 } },
      phrases: [{ readings: [] }],
    } as unknown as UserAdapterData;
    const jumped = UserAdapter.fromJSON(structuredClone(data), {}, T0 + 400 * 86_400_000);
    expect(jumped.toJSON().bySeq).toEqual({ k: { 好: rec } });
    expect(jumped.toJSON().global).toEqual({ 好: rec });
    expect(jumped.phrases.size).toBe(0);
    // 不到一年：照常整理，衰減完的刪掉
    const normal = UserAdapter.fromJSON(structuredClone(data), {}, T0 + 300 * 86_400_000);
    expect(normal.toJSON().global).toEqual({});
  });
});
