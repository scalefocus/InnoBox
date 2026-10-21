// A memo whose lifetime is ONE request (INNOBOX_SPEC.md §4.2 *Resolution*: "at most once per
// request"). Keyed on a per-request scope object — in production the request's headers object,
// which Next hands out once per request — and held in a WeakMap, so the entry dies with the
// request and nothing is ever reused across requests. A rejected computation is evicted, so a
// transient failure is not pinned for the rest of the request.

export function requestMemo<T>(): (scope: object | null, compute: () => Promise<T>) => Promise<T> {
  const entries = new WeakMap<object, Promise<T>>();
  return (scope, compute) => {
    if (scope === null) return compute(); // no request scope (build, tests): never memoize
    const hit = entries.get(scope);
    if (hit) return hit;
    const pending = compute();
    entries.set(scope, pending);
    pending.catch(() => {
      if (entries.get(scope) === pending) entries.delete(scope);
    });
    return pending;
  };
}
