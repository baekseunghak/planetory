// Only numeric positions are retained. Reads and writes both refresh recency.
export function createScrollPositions(limit = 50) {
  const values = new Map<string, number>();
  const set = (key: string, value: number) => {
    values.delete(key);
    values.set(key, value);
    if (values.size > limit) values.delete(values.keys().next().value!);
  };
  return {
    set,
    get(key: string) {
      const value = values.get(key);
      if (value !== undefined) set(key, value);
      return value;
    },
  };
}
