// Unit tests for the §11 upload-control rules (INNOBOX_SPEC.md §11 "UI").
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentPhaseClass, attachmentPhaseLabel, blocksSubmit, formatBytes, needsScanPoll, uploadMode } from "./attachment-control";

test("phase labels: Scanning… → Ready / Failed scan / Couldn't be scanned", () => {
  assert.equal(attachmentPhaseLabel("pending"), "Scanning…");
  assert.equal(attachmentPhaseLabel("clean"), "Ready");
  assert.equal(attachmentPhaseLabel("infected"), "Failed scan");
  assert.equal(attachmentPhaseLabel("unscannable"), "Couldn't be scanned");
});

test("phase classes: neutral scanning, ok ready, danger for both failures", () => {
  assert.equal(attachmentPhaseClass("pending"), "chip");
  assert.equal(attachmentPhaseClass("clean"), "pill pill-ok");
  assert.equal(attachmentPhaseClass("infected"), "pill pill-danger");
  assert.equal(attachmentPhaseClass("unscannable"), "pill pill-danger");
});

test("uploadMode: chunked only when larger than one chunk", () => {
  assert.equal(uploadMode(5, 5), "single");
  assert.equal(uploadMode(6, 5), "chunked");
  assert.equal(uploadMode(0, 5), "single");
});

test("blocksSubmit: an in-flight upload always blocks", () => {
  assert.equal(blocksSubmit({ uploading: true, scanEnforced: false, statuses: [] }), true);
  assert.equal(blocksSubmit({ uploading: true, scanEnforced: true, statuses: ["clean"] }), true);
});

test("blocksSubmit: with the scanner enforced, anything but Ready blocks", () => {
  assert.equal(blocksSubmit({ uploading: false, scanEnforced: true, statuses: ["clean", "clean"] }), false);
  for (const s of ["pending", "infected", "unscannable"] as const) {
    assert.equal(blocksSubmit({ uploading: false, scanEnforced: true, statuses: ["clean", s] }), true, s);
  }
});

test("blocksSubmit: no scanner → the gate lifts (pending files may be submitted)", () => {
  assert.equal(blocksSubmit({ uploading: false, scanEnforced: false, statuses: ["pending", "unscannable"] }), false);
});

test("needsScanPoll: only while something is scanning", () => {
  assert.equal(needsScanPoll(["clean", "pending"]), true);
  assert.equal(needsScanPoll(["clean", "infected", "unscannable"]), false);
  assert.equal(needsScanPoll([]), false);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
