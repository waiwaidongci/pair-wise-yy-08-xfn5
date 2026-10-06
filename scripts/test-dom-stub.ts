// Node 下运行 store 测试用的最小 localStorage / window 打桩
const memory = new Map<string, string>();

const storage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, String(value));
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};

Object.assign(globalThis, {
  localStorage: storage,
  window: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {} },
});

export {};
