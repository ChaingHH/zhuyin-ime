/** 防洩漏的窗長：語料片段只要和任一評測句共用一段 8 字，就算近似重複。 */
export const LEAK_WINDOW = 8;

/**
 * 評測句 → 判斷語料片段是否洩漏的函式。
 * 索引評測句的每個 8 字窗；不足 8 字的評測句整句當一個窗（只擋完全包含）。
 * 只擋整句完全包含的話，同一段落換個標點、多一兩個字的近似重複會漏進訓練。
 */
export function leakChecker(evalTexts: Iterable<string>): (run: string) => boolean {
  const windows = new Set<string>();
  const lens = new Set<number>();
  for (const t of evalTexts) {
    if (t.length < LEAK_WINDOW) {
      windows.add(t);
      lens.add(t.length);
    } else {
      for (let i = 0; i + LEAK_WINDOW <= t.length; i++) windows.add(t.slice(i, i + LEAK_WINDOW));
      lens.add(LEAK_WINDOW);
    }
  }
  return (run) => {
    for (const n of lens)
      for (let i = 0; i + n <= run.length; i++) if (windows.has(run.slice(i, i + n))) return true;
    return false;
  };
}
