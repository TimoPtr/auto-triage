import type { RawRecord, RawStore } from '../../src/store/raw.ts';

const keyOf = (r: Pick<RawRecord, 'provider' | 'origin' | 'kind' | 'id'>) => `${r.provider}/${r.origin}/${r.kind}/${r.id}`;

/** An in-memory raw store for tests. */
export function fakeRaw(records: RawRecord[] = []): RawStore {
  const map = new Map(records.map((r) => [keyOf(r), r]));
  return {
    get<T>(provider: string, origin: string, kind: string, id: string) { return (map.get(keyOf({ provider, origin, kind, id })) as RawRecord<T> | undefined) ?? null; },
    put(record: RawRecord) { map.set(keyOf(record), record); },
    *each<T>(provider: string, origin: string, kind: string) { for (const r of map.values()) if (r.provider === provider && r.origin === origin && r.kind === kind) yield r as RawRecord<T>; },
    count() { return map.size; },
    close() {},
  };
}
