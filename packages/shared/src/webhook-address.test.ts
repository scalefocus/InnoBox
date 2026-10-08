// Unit tests for the §12.4 SSRF address classifier: every refused IPv4/IPv6 range, IPv4-mapped
// and NAT64 addresses judged by their embedded IPv4, and parser strictness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ipLiteralFamily, isPublicAddress, parseIPv4, parseIPv6 } from "./webhook-address.js";

test("parseIPv4 is strict dotted-quad", () => {
  assert.deepEqual(parseIPv4("192.168.1.10"), [192, 168, 1, 10]);
  assert.equal(parseIPv4("256.0.0.1"), null);
  assert.equal(parseIPv4("1.2.3"), null);
  assert.equal(parseIPv4("010.0.0.1"), null, "leading zeros are ambiguous (octal) — refused as an address");
  assert.equal(parseIPv4("1.2.3.4.5"), null);
  assert.equal(parseIPv4("example.com"), null);
});

test("parseIPv6 handles compression, dotted tails and zones", () => {
  assert.deepEqual(parseIPv6("::1"), [...new Array(15).fill(0), 1]);
  assert.deepEqual(parseIPv6("::"), new Array(16).fill(0));
  assert.deepEqual(parseIPv6("::ffff:127.0.0.1")?.slice(10), [0xff, 0xff, 127, 0, 0, 1]);
  assert.deepEqual(parseIPv6("64:ff9b::10.0.0.1")?.slice(0, 4), [0, 0x64, 0xff, 0x9b]);
  assert.deepEqual(parseIPv6("64:ff9b::10.0.0.1")?.slice(12), [10, 0, 0, 1]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8")?.slice(14), [0, 8]);
  assert.deepEqual(parseIPv6("fe80::1%eth0")?.slice(0, 2), [0xfe, 0x80]);
  assert.deepEqual(parseIPv6("[2606:4700::1]")?.slice(0, 2), [0x26, 0x06]);
  assert.equal(parseIPv6("1::2::3"), null);
  assert.equal(parseIPv6("1:2:3:4:5:6:7:8:9"), null);
  assert.equal(parseIPv6("12345::"), null);
  assert.equal(parseIPv6("::ffff:1.2.3"), null);
  assert.equal(parseIPv6("gggg::"), null);
});

test("ipLiteralFamily tells literals from host names", () => {
  assert.equal(ipLiteralFamily("8.8.8.8"), 4);
  assert.equal(ipLiteralFamily("2606:4700::1111"), 6);
  assert.equal(ipLiteralFamily("prod-12.westeurope.logic.azure.com"), 0);
  assert.equal(ipLiteralFamily("postgres"), 0);
});

test("IPv4: every refused range is refused, public addresses pass", () => {
  for (const ip of [
    "0.0.0.0",
    "0.255.1.1",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.0.1.1", "198.17.255.255", "198.20.0.0", "20.50.2.3", "223.255.255.255"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("IPv6: refused ranges, public addresses pass", () => {
  for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "2001:db8::1", "2001:0db8:ffff::1", "::7f00:1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a01:111:f400::1", "fec0::1"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("IPv4-mapped and NAT64 addresses are judged by the embedded IPv4", () => {
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:7f00:1"), false, "hex form of the mapped loopback");
  assert.equal(isPublicAddress("::ffff:10.1.2.3"), false);
  assert.equal(isPublicAddress("::ffff:169.254.169.254"), false);
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
  assert.equal(isPublicAddress("64:ff9b::192.168.1.1"), false);
  assert.equal(isPublicAddress("64:ff9b::c0a8:101"), false);
  assert.equal(isPublicAddress("64:ff9b::8.8.8.8"), true);
});

test("anything unparsable is not public", () => {
  assert.equal(isPublicAddress(""), false);
  assert.equal(isPublicAddress("localhost"), false);
  assert.equal(isPublicAddress("1.2.3.4.5"), false);
  assert.equal(isPublicAddress("::g"), false);
});
