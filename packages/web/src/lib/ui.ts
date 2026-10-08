// Client-side GET cache. `cachedGet` dedupes concurrent requests for the same URL and
// caches the parsed JSON until `invalidateApi` clears it — DateFormatProvider uses it so
// every mounted formatter shares one /api/me fetch, and a just-saved settings change can
// force a refetch (components/DateFormat.tsx). Failed fetches are evicted immediately so
// a transient error doesn't poison the cache.

const cache = new Map<string, Promise<unknown>>();

export function cachedGet<T>(url: string): Promise<T> {
  let hit = cache.get(url);
  if (!hit) {
    hit = fetch(url, { headers: { accept: "application/json" } }).then((res) => {
      if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
      return res.json() as Promise<unknown>;
    });
    hit.catch(() => cache.delete(url));
    cache.set(url, hit);
  }
  return hit as Promise<T>;
}

/** Evict `url` and everything under it (prefix match) from the shared GET cache. */
export function invalidateApi(url: string): void {
  for (const key of cache.keys()) {
    if (key === url || key.startsWith(url)) cache.delete(key);
  }
}
