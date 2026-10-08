// Pins the CSP report sink's client-IP selection (INNOBOX_SPEC.md §2.4): the X-Forwarded-For
// entry chosen by TRUST_PROXY with the worker's (Express `trust proxy`) semantics, the proxy
// itself counted as the first trusted hop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIpFromForwardedFor, parseIp, parseTrustProxy } from "./client-ip";

test("parseTrustProxy matches the worker's parser", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("  "), false);
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy(" 2 "), 2);
  assert.equal(parseTrustProxy("loopback"), "loopback");
  assert.equal(parseTrustProxy("10.0.0.0/8, 192.168.0.0/16"), "10.0.0.0/8, 192.168.0.0/16");
});

test("untrusted (unset/false/0) or no header → no address (the shared bucket)", () => {
  assert.equal(clientIpFromForwardedFor("203.0.113.7", false), null);
  assert.equal(clientIpFromForwardedFor("203.0.113.7", 0), null);
  assert.equal(clientIpFromForwardedFor(null, 1), null);
  assert.equal(clientIpFromForwardedFor("", 1), null);
  assert.equal(clientIpFromForwardedFor(" , ", 1), null);
});

test("hop count n → the n-th entry from the right; the leftmost when there are fewer", () => {
  const xff = "198.51.100.1, 203.0.113.7, 10.0.0.2";
  assert.equal(clientIpFromForwardedFor(xff, 1), "10.0.0.2");
  assert.equal(clientIpFromForwardedFor(xff, 2), "203.0.113.7");
  assert.equal(clientIpFromForwardedFor(xff, 3), "198.51.100.1");
  assert.equal(clientIpFromForwardedFor(xff, 9), "198.51.100.1");
});

test("a client-prepended entry cannot displace the proxy-appended one under TRUST_PROXY=1", () => {
  assert.equal(clientIpFromForwardedFor("1.2.3.4, 203.0.113.7", 1), "203.0.113.7");
});

test("true → the leftmost entry", () => {
  assert.equal(clientIpFromForwardedFor("198.51.100.1, 203.0.113.7", true), "198.51.100.1");
});

test("subnet list / presets → the rightmost entry outside the trusted ranges", () => {
  const xff = "198.51.100.1, 203.0.113.7, 10.1.2.3, 127.0.0.1";
  assert.equal(clientIpFromForwardedFor(xff, "loopback, 10.0.0.0/8"), "203.0.113.7");
  assert.equal(clientIpFromForwardedFor(xff, "loopback,uniquelocal"), "203.0.113.7");
  assert.equal(clientIpFromForwardedFor(xff, "loopback"), "10.1.2.3");
  assert.equal(clientIpFromForwardedFor(xff, "203.0.113.0/24, 10.0.0.0/8, loopback"), "198.51.100.1");
  // Everything trusted → the leftmost.
  assert.equal(clientIpFromForwardedFor("10.0.0.1, 10.0.0.2", "10.0.0.0/8"), "10.0.0.1");
  // Unparseable trust entries match nothing → the rightmost entry.
  assert.equal(clientIpFromForwardedFor(xff, "not-a-subnet"), "127.0.0.1");
});

test("IPv6 entries: ranges, IPv4-mapped addresses, and a canonical key", () => {
  assert.equal(clientIpFromForwardedFor("2001:db8::1, ::1", "loopback"), "2001:db8:0:0:0:0:0:1");
  assert.equal(clientIpFromForwardedFor("2001:db8::1, fd00::5", "uniquelocal"), "2001:db8:0:0:0:0:0:1");
  // An IPv4-mapped IPv6 hop matches an IPv4 range.
  assert.equal(clientIpFromForwardedFor("203.0.113.7, ::ffff:10.0.0.9", "10.0.0.0/8"), "203.0.113.7");
  // Different spellings of one address share one key.
  assert.equal(clientIpFromForwardedFor("2001:DB8:0::1", 1), clientIpFromForwardedFor("[2001:db8::1]", 1));
});

test("a selected entry that is not a literal IP is never used as a key", () => {
  assert.equal(clientIpFromForwardedFor("evil-key-12345", 1), null);
  assert.equal(clientIpFromForwardedFor("unknown, 203.0.113.7", true), null);
  assert.equal(clientIpFromForwardedFor("999.1.1.1", 1), null);
});

test("parseIp: IPv4, IPv6 (compressed, embedded IPv4, bracketed), and rejects", () => {
  assert.deepEqual(parseIp("192.0.2.1"), { v: 4, bytes: [192, 0, 2, 1] });
  assert.deepEqual(parseIp("::")?.bytes, new Array(16).fill(0));
  assert.deepEqual(parseIp("::1")?.bytes, [...new Array(15).fill(0), 1]);
  assert.deepEqual(parseIp("::ffff:192.0.2.1")?.bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 0, 2, 1]);
  assert.deepEqual(parseIp("::192.0.2.1")?.bytes, [...new Array(12).fill(0), 192, 0, 2, 1]);
  assert.equal(parseIp("[fe80::1]")?.v, 6);
  assert.equal(parseIp("1:2:3:4:5:6:7:8")?.v, 6);
  for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.0.0.1", "1::2::3", "1:2:3:4:5:6:7:8:9", "gggg::1", ":1", "fe80::1%eth0", "host"]) {
    assert.equal(parseIp(bad), null, bad);
  }
});
