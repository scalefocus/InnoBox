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

test("parseSettingsPatch: featuredLimit is an integer 1–6 and may be sent alone (§14.3)", () => {
  const parsed = parseSettingsPatch({ featuredLimit: 4 });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { featuredLimit: 4 });
  for (const bad of [0, 7, 2.5, "3", null]) assert.equal(parseSettingsPatch({ featuredLimit: bad }).ok, false, String(bad));
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

test("parseSettingsPatch: surveyEnabled is a boolean and may be sent alone (§14.11)", () => {
  const parsed = parseSettingsPatch({ surveyEnabled: false });
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.value, { surveyEnabled: false });
  for (const bad of ["false", 0, null]) assert.equal(parseSettingsPatch({ surveyEnabled: bad }).ok, false, String(bad));
});

test("parseSettingsPatch: gamificationEnabled is a boolean and may be sent alone (§23.10)", () => {
  const parsed = parseSettingsPatch({ gamificationEnabled: true });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { gamificationEnabled: true });
  for (const bad of ["true", 1, null]) assert.equal(parseSettingsPatch({ gamificationEnabled: bad }).ok, false, String(bad));
});

test("parseSettingsPatch: publicSubmissions takes the switch and/or a notice of at most 4 000 characters (§24.2)", () => {
  const both = parseSettingsPatch({ publicSubmissions: { enabled: true, privacyNotice: "  We keep it.  " } });
  assert.deepEqual(both, { ok: true, value: { publicSubmissions: { enabled: true, privacyNotice: "We keep it." } } });
  assert.deepEqual(parseSettingsPatch({ publicSubmissions: { enabled: false } }), { ok: true, value: { publicSubmissions: { enabled: false } } });
  assert.deepEqual(parseSettingsPatch({ publicSubmissions: { privacyNotice: "" } }), { ok: true, value: { publicSubmissions: { privacyNotice: "" } } });
  assert.equal(parseSettingsPatch({ publicSubmissions: {} }).ok, false);
  assert.equal(parseSettingsPatch({ publicSubmissions: { enabled: "yes" } }).ok, false);
  assert.equal(parseSettingsPatch({ publicSubmissions: { privacyNotice: "x".repeat(4_001) } }).ok, false);
  assert.equal(parseSettingsPatch({ publicSubmissions: true }).ok, false);
});

test("parseSettingsPatch: bugReportsEnabled is a boolean and may be sent alone (§13.10)", () => {
  const parsed = parseSettingsPatch({ bugReportsEnabled: false });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { bugReportsEnabled: false });
  for (const bad of ["false", 0, null]) assert.equal(parseSettingsPatch({ bugReportsEnabled: bad }).ok, false, String(bad));
});
