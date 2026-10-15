export interface RankedList {
  weight: number;
  ids: (number | bigint)[];
}

/** Reciprocal rank fusion over ranked id lists. */
export function fuse(lists: RankedList[], { k = 60 }: { k?: number } = {}): Map<number, number> {
  const scores = new Map<number, number>();
  for (const { weight, ids } of lists) {
    ids.forEach((raw, rank) => {
      const id = Number(raw);
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1));
    });
  }
  return scores;
}
