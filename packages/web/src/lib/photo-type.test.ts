// Unit tests for the profile-photo content-type sniffer (INNOBOX_SPEC.md §3.1 — JPEG/PNG stored
// as Graph returns it, served with the matching type).
import { test } from "node:test";
import assert from "node:assert/strict";
import { photoContentType } from "./photo-type";

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
