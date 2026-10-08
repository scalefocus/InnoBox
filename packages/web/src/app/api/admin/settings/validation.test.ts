import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImpactAreaCreate, parseImpactAreaPatch, parseSettingsPatch } from "./validation.js";

test("parseSettingsPatch: accepts dateFormat only", () => {
  const parsed = parseSettingsPatch({ dateFormat: "us" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { dateFormat: "us" });
});

test("parseSettingsPatch: accepts attachmentLimits only", () => {
  const parsed = parseSettingsPatch({ attachmentLimits: { maxPerItem: 3, maxUploadSizeMb: 10, chunkSizeMb: 5 } });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { attachmentLimits: { maxPerItem: 3, maxUploadSizeMb: 10, chunkSizeMb: 5 } });
});

test("parseSettingsPatch: rejects an invalid dateFormat", () => {
  assert.equal(parseSettingsPatch({ dateFormat: "iso" }).ok, false);
});

test("parseSettingsPatch: rejects out-of-range or non-integer attachment limits", () => {
  assert.equal(parseSettingsPatch({ attachmentLimits: { maxPerItem: 0, maxUploadSizeMb: 10, chunkSizeMb: 5 } }).ok, false);
  assert.equal(parseSettingsPatch({ attachmentLimits: { maxPerItem: 5, maxUploadSizeMb: 1000, chunkSizeMb: 5 } }).ok, false);
  assert.equal(parseSettingsPatch({ attachmentLimits: { maxPerItem: 1.5, maxUploadSizeMb: 10, chunkSizeMb: 5 } }).ok, false);
});

test("parseSettingsPatch: enforces the §11 max-upload floor of 5 MB", () => {
  // The floor was raised from 1 to 5 so chunk size (≥5, ≤max) stays jointly satisfiable.
  assert.equal(parseSettingsPatch({ attachmentLimits: { maxPerItem: 5, maxUploadSizeMb: 4, chunkSizeMb: 5 } }).ok, false);
  assert.equal(parseSettingsPatch({ attachmentLimits: { maxPerItem: 5, maxUploadSizeMb: 5, chunkSizeMb: 5 } }).ok, true);
});

test("parseSettingsPatch: chunkSizeMb must be an integer in [5, maxUploadSizeMb]", () => {
  const mk = (chunkSizeMb: unknown) => parseSettingsPatch({ attachmentLimits: { maxPerItem: 5, maxUploadSizeMb: 10, chunkSizeMb } });
  assert.equal(mk(4).ok, false, "below the 5 MB S3 part floor");
  assert.equal(mk(11).ok, false, "larger than the max upload size");
  assert.equal(mk(7.5).ok, false, "non-integer");
  assert.equal(mk("5").ok, false, "non-number");
  assert.equal(mk(undefined).ok, false, "required");
  assert.equal(mk(5).ok, true, "at the floor");
  assert.equal(mk(10).ok, true, "equal to the max upload size");
});

test("parseSettingsPatch: rejects an empty patch", () => {
  assert.equal(parseSettingsPatch({}).ok, false);
});

test("parseImpactAreaCreate: trims name, rejects blank or over-length", () => {
  const parsed = parseImpactAreaCreate({ name: "  Sales  " });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.name, "Sales");
  assert.equal(parseImpactAreaCreate({ name: "  " }).ok, false);
  assert.equal(parseImpactAreaCreate({ name: "x".repeat(61) }).ok, false);
});

test("parseImpactAreaPatch: accepts name and/or active, rejects an empty patch", () => {
  assert.equal(parseImpactAreaPatch({ active: false }).ok, true);
  assert.equal(parseImpactAreaPatch({ name: "Renamed" }).ok, true);
  assert.equal(parseImpactAreaPatch({}).ok, false);
  assert.equal(parseImpactAreaPatch({ active: "no" }).ok, false);
});
