// Client IP for the public CSP report sink's per-IP rate limit (INNOBOX_SPEC.md §2.4): the
// X-Forwarded-For entry selected by TRUST_PROXY, with the worker's semantics (Express `trust
// proxy`, packages/worker/src/ratelimit.ts parseTrustProxy). Pure and dependency-free.
//
// Express walks [socket, XFF right-to-left], skipping trusted addresses, and keys the first
// untrusted one. A Next route handler never sees the socket address (the standalone server adds
// it to X-Forwarded-For only when the proxy sent none, so it is indistinguishable from a
// client-supplied header), so the socket — the bundled proxy — is taken as the first trusted hop:
//   - a hop count n ≥ 1 → the n-th entry from the right (the leftmost when there are fewer);
//   - true              → the leftmost entry;
//   - a preset/subnet list → the rightmost entry outside the trusted ranges (the leftmost when
//     all are trusted);
//   - false / 0 / unset → no address: the worker would key the proxy itself, i.e. one shared
//     bucket for every caller — which is what null means to the caller.
// An entry that is not a literal IP address is never used as a key (null instead), so a forged
// header cannot mint arbitrary bucket keys beyond what TRUST_PROXY already lets it choose.

export type TrustProxy = boolean | number | string;

/** Parses the TRUST_PROXY env exactly as the worker does: a hop count, true/false, a preset such
 *  as "loopback", or a comma-separated subnet list. Unset → X-Forwarded-For is not trusted. */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  if (raw === undefined || raw.trim() === "") return false;
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

type Ip = { v: 4 | 6; bytes: number[] };

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

function parseIPv6(s: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(s)) return null;
  let tail: number[] = [];
  let text = s;
  if (text.includes(".")) {
    // An embedded dotted IPv4 tail (e.g. ::ffff:192.0.2.1) is the last two groups.
    const lastColon = text.lastIndexOf(":");
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    const prefix = text.slice(0, lastColon + 1);
    text = prefix.endsWith("::") ? prefix : prefix.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  const total = head.length + rest.length + tail.length;
  let groups: number[];
  if (halves.length === 2) {
    if (total > 7) return null;
    groups = [...head, ...new Array<number>(8 - total).fill(0), ...rest, ...tail];
  } else {
    if (total !== 8) return null;
    groups = [...head, ...tail];
  }
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

/** A literal IPv4 or IPv6 address (IPv6 optionally bracketed), else null. */
export function parseIp(raw: string): Ip | null {
  const s = raw.trim().replace(/^\[(.*)\]$/, "$1");
  const v4 = parseIPv4(s);
  if (v4) return { v: 4, bytes: v4 };
  if (!s.includes(":")) return null;
  const v6 = parseIPv6(s);
  return v6 ? { v: 6, bytes: v6 } : null;
}

const PRESETS: Record<string, string[]> = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

type Range = { ip: Ip; prefix: number };

function parseRange(entry: string): Range | null {
  const [addr, len] = entry.split("/");
  const ip = parseIp(addr ?? "");
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  if (len === undefined) return { ip, prefix: max };
  if (!/^\d{1,3}$/.test(len)) return null;
  const prefix = Number(len);
  return prefix <= max ? { ip, prefix } : null;
}

/** The trusted ranges of a preset/subnet TRUST_PROXY value. Unparseable entries match nothing
 *  (so the rightmost hop is keyed — the most conservative choice). */
export function trustedRanges(value: string): Range[] {
  const out: Range[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    for (const r of PRESETS[entry] ?? [entry]) {
      const range = parseRange(r);
      if (range) out.push(range);
    }
  }
  return out;
}

const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

function inRange(ip: Ip, range: Range): boolean {
  let bytes = ip.bytes;
  if (ip.v !== range.ip.v) {
    if (range.ip.v === 4) {
      // An IPv4-mapped IPv6 address matches an IPv4 range; any other IPv6 address does not.
      if (!MAPPED_PREFIX.every((b, i) => ip.bytes[i] === b)) return false;
      bytes = ip.bytes.slice(12);
    } else {
      bytes = [...MAPPED_PREFIX, ...ip.bytes];
    }
  }
  let bits = range.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (range.ip.bytes[i]! & mask)) return false;
  }
  return true;
}

/** The client address to key the per-IP limit on, or null when none can be determined (every
 *  such request then shares one bucket — which can only under-count). */
export function clientIpFromForwardedFor(xff: string | null, trust: TrustProxy): string | null {
  if (trust === false || trust === 0 || !xff) return null;
  const entries = xff.split(",").map((e) => e.trim()).filter((e) => e !== "");
  if (entries.length === 0) return null;

  let selected: string;
  if (trust === true) {
    selected = entries[0]!;
  } else if (typeof trust === "number") {
    selected = entries[Math.max(0, entries.length - trust)]!;
  } else {
    const ranges = trustedRanges(trust);
    selected = entries[0]!;
    for (let i = entries.length - 1; i >= 0; i--) {
      const ip = parseIp(entries[i]!);
      if (!ip || !ranges.some((r) => inRange(ip, r))) {
        selected = entries[i]!;
        break;
      }
    }
  }
  const ip = parseIp(selected);
  if (!ip) return null;
  return ip.v === 4 ? ip.bytes.join(".") : ipv6Key(ip.bytes);
}

/** A canonical key for an IPv6 address (uncompressed lower-case hex groups). */
function ipv6Key(bytes: number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(":");
}
