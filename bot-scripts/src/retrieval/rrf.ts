export interface RankedList {
  weight: number;
  ids: (number | bigint)[];
  /** Optional score per id, in the list's own order; equal consecutive scores share a rank. */
  scores?: number[];
}

/** Competition ranks (1, 1, 3) for a list: ties share the rank of their first member. */
function ranks(list: RankedList): number[] {
  const out: number[] = [];
  list.ids.forEach((_, index) => {
    const tied = index > 0 && list.scores !== undefined && list.scores[index] === list.scores[index - 1];
    out.push(tied ? out[index - 1] : index + 1);
  });
  return out;
}

/** Reciprocal rank fusion over ranked id lists. */
export function fuse(lists: RankedList[], { k = 60 }: { k?: number } = {}): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    const rank = ranks(list);
    list.ids.forEach((raw, index) => {
      const id = Number(raw);
      scores.set(id, (scores.get(id) ?? 0) + list.weight / (k + rank[index]));
    });
  }
  return scores;
}
