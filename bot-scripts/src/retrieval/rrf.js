// @ts-check

/**
 * Reciprocal rank fusion over ranked id lists.
 * @param {{ weight: number, ids: (number|bigint)[] }[]} lists
 * @param {{ k?: number }} [options]
 * @returns {Map<number, number>}
 */
export function fuse(lists, { k = 60 } = {}) {
  const scores = new Map();
  for (const { weight, ids } of lists) {
    ids.forEach((raw, rank) => {
      const id = Number(raw);
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1));
    });
  }
  return scores;
}
