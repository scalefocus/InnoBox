// Unit tests for the profile-photo content-type sniffer (INNOBOX_SPEC.md §3.1 — JPEG/PNG stored
// as Graph returns it, served with the matching type).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ifNoneMatchHits, photoContentType, photoEtag } from "./photo-type";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

test("photoContentType: the PNG signature → image/png", () => {
  assert.equal(photoContentType(png), "image/png");
  assert.equal(photoContentType(Buffer.from(png)), "image/png", "a pg bytea Buffer works too");
});

test("photoContentType: the JPEG SOI marker → image/jpeg", () => {
  assert.equal(photoContentType(jpeg), "image/jpeg");
});

test("photoContentType: unrecognized, truncated or empty bytes fall back to image/jpeg", () => {
  assert.equal(photoContentType(Uint8Array.from([0x47, 0x49, 0x46, 0x38])), "image/jpeg");
  assert.equal(photoContentType(png.subarray(0, 7)), "image/jpeg", "a truncated PNG signature is not PNG");
  assert.equal(photoContentType(new Uint8Array(0)), "image/jpeg");
});

test("photoEtag: an unquoted Graph etag is wrapped in quotes", () => {
  assert.equal(photoEtag("abc123"), '"abc123"');
  assert.equal(photoEtag("  abc123 "), '"abc123"', "surrounding whitespace is trimmed");
});

test("photoEtag: an already-quoted strong etag passes through unchanged", () => {
  assert.equal(photoEtag('"abc123"'), '"abc123"');
});

test("photoEtag: a weak W/\"…\" etag passes through unchanged", () => {
  assert.equal(photoEtag('W/"abc123"'), 'W/"abc123"');
});

test("photoEtag: a malformed value with stray quotes is normalized to one well-formed tag", () => {
  assert.equal(photoEtag('abc"123'), '"abc123"');
  assert.equal(photoEtag('"abc'), '"abc"');
});

test("photoEtag: null, empty or blank → no etag", () => {
  assert.equal(photoEtag(null), undefined);
  assert.equal(photoEtag(undefined), undefined);
  assert.equal(photoEtag(""), undefined);
  assert.equal(photoEtag("   "), undefined);
});

test("ifNoneMatchHits: compares against the same form photoEtag sends", () => {
  assert.equal(ifNoneMatchHits('"abc"', '"abc"'), true);
  assert.equal(ifNoneMatchHits('W/"abc"', 'W/"abc"'), true);
  assert.equal(ifNoneMatchHits('""abc""', '"abc"'), false, "the old double-quoted form no longer matches");
  assert.equal(ifNoneMatchHits('"other", "abc"', '"abc"'), true, "a list matches any member");
  assert.equal(ifNoneMatchHits("*", '"abc"'), true);
  assert.equal(ifNoneMatchHits('"other"', '"abc"'), false);
  assert.equal(ifNoneMatchHits(null, '"abc"'), false);
});
