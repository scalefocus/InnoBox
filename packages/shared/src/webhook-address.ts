// The §12.4 SSRF guard's address classifier (INNOBOX_SPEC.md §12.4, §2.4 *Outbound requests*).
// Pure (no node:net), so it is unit-testable byte for byte: an address is "public" only when it
// parses and falls in none of the refused ranges. Anything unparsable is NOT public.
//
// Refused:
//   IPv4  0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
//         192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
//         203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4
//   IPv6  ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32
//   IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) are judged by the embedded IPv4.
// Conservative addition (the spec is silent): the deprecated IPv4-compatible block ::/96 is
// refused outright — it contains ::/128 and ::1/128 and is never a legitimate receiver.

type Cidr = readonly [bytes: readonly number[], prefixBits: number];

const IPV4_REFUSED: readonly Cidr[] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

const V6 = (...head: number[]): number[] => [...head, ...new Array<number>(16 - head.length).fill(0)];

const IPV6_REFUSED: readonly Cidr[] = [
  [V6(), 96], // ::/96 — covers ::/128, ::1/128 and the deprecated IPv4-compatible block
  [V6(0xfc), 7],
  [V6(0xfe, 0x80), 10],
  [V6(0xff), 8],
  [V6(0x20, 0x01, 0x0d, 0xb8), 32],
];

/** IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 — both carry an IPv4 in the low 32 bits. */
const IPV6_EMBEDS_IPV4: readonly Cidr[] = [
  [V6(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff), 96],
  [V6(0x00, 0x64, 0xff, 0x9b), 96],
];

function inCidr(bytes: readonly number[], [net, bits]: Cidr): boolean {
  let remaining = bits;
  for (let i = 0; i < net.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((bytes[i]! & mask) !== (net[i]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** Strict dotted-quad: four decimal octets 0–255, no leading zeros (an octal-looking "010" is
 *  ambiguous across resolvers, so it is not accepted as an address at all). */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** RFC 4291 text form → 16 bytes: `::` compression, an optional dotted-quad tail, and an
 *  optional `%zone` suffix (stripped — the zone does not change the range). */
export function parseIPv6(text: string): number[] | null {
  let s = text;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s === "" || !/^[0-9a-fA-F:.]+$/.test(s)) return null;

  let tail: number[] = [];
  if (s.includes(".")) {
    // A dotted-quad tail stands for the last two groups: parse it, then keep the head — with
    // its `::` when the tail follows one, without the single separating colon otherwise.
    const lastColon = s.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }

  const groupsWanted = 8 - tail.length / 2;
  const doubleAt = s.indexOf("::");
  if (doubleAt !== s.lastIndexOf("::")) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  let groups: number[];
  if (doubleAt >= 0) {
    const head = parseGroups(s.slice(0, doubleAt));
    const rest = parseGroups(s.slice(doubleAt + 2));
    if (!head || !rest) return null;
    const fill = groupsWanted - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    const all = parseGroups(s);
    if (!all || all.length !== groupsWanted) return null;
    groups = all;
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  return [...bytes, ...tail];
}

/** `4` / `6` for a syntactically valid literal, else `0` (a host name). */
export function ipLiteralFamily(text: string): 0 | 4 | 6 {
  if (parseIPv4(text)) return 4;
  if (text.includes(":") && parseIPv6(text)) return 6;
  return 0;
}

/** True only for a parsable address outside every refused range. */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return !IPV4_REFUSED.some((c) => inCidr(v4, c));
  const v6 = address.includes(":") ? parseIPv6(address) : null;
  if (!v6) return false;
  for (const c of IPV6_EMBEDS_IPV4) {
    if (inCidr(v6, c)) return !IPV4_REFUSED.some((r) => inCidr(v6.slice(12), r));
  }
  return !IPV6_REFUSED.some((c) => inCidr(v6, c));
}
