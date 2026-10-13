import { loadRuntime } from './packages/cli/src/runtime.js';
for (const gamma of [0.3, 0.2, 0.15, 0.1]) {
  const { decoder } = await loadRuntime({ a: 1.2, gamma });
  const paths = decoder.decode(['ㄒㄧㄥˋ','ㄗˇ','ㄎㄨㄞˋ','ㄙˇ','ㄉㄧㄠˋ','ㄌㄜ˙'], { nBest: 5 });
  const top = paths[0]?.words.join('|') ?? '';
  const ok = top.includes('快') ? '✓' : '✗';
  console.log(`γ=${gamma} top=${top} ${ok}  #2=${paths[1]?.words.join('|') ?? ''}`);
}
