// Unit tests for the §11 "Drop and paste" intake rules (INNOBOX_SPEC.md §11 "UI").
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_ATTACHMENT_EXTENSIONS } from "@innobox/shared";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  dragCarriesFiles,
  intakeAnnouncement,
  PASTE_AMBIGUOUS_MESSAGE,
  pasteAttaches,
  pastedFileName,
  precheckFiles,
  routePaste,
  skippedMessage,
} from "./attachment-intake";

const MB = 1024 * 1024;
const limits = { maxUploadSizeMb: 10, maxPerItem: 5, taken: 0 };

test("the browser's allowlist mirrors the server's exactly", () => {
  assert.deepEqual([...ATTACHMENT_EXTENSIONS].sort(), [...ALLOWED_ATTACHMENT_EXTENSIONS].sort());
  assert.equal(ATTACHMENT_ACCEPT.split(",").length, ATTACHMENT_EXTENSIONS.length);
  assert.ok(ATTACHMENT_ACCEPT.split(",").every((e) => e.startsWith(".")));
});

test("precheck: valid files pass in order; extension match ignores case", () => {
  const files = [{ name: "a.PDF", size: 1 }, { name: "b.png", size: 2 }];
  const out = precheckFiles(files, limits);
  assert.deepEqual(out.accepted, files);
  assert.deepEqual(out.skipped, []);
});

test("precheck: type, size and folders are skipped with a reason; the rest still pass", () => {
  const out = precheckFiles(
    [
      { name: "setup.exe", size: 1 },
      { name: "big.zip", size: 11 * MB },
      { name: "photos", size: 0, isDirectory: true },
      { name: "README", size: 1 },
      { name: "ok.txt", size: 1 },
    ],
    limits,
  );
  assert.deepEqual(out.accepted.map((f) => f.name), ["ok.txt"]);
  assert.deepEqual(out.skipped, [
    { name: "setup.exe", reason: "file type not allowed" },
    { name: "big.zip", reason: "over 10 MB" },
    { name: "photos", reason: "folders can't be attached" },
    { name: "README", reason: "file type not allowed" },
  ]);
});

test("precheck: exactly at the size limit passes", () => {
  assert.equal(precheckFiles([{ name: "x.pdf", size: 10 * MB }], limits).accepted.length, 1);
});

test("precheck: the cap counts what is already taken and keeps the first files that fit", () => {
  const files = ["1.pdf", "2.pdf", "3.pdf", "4.pdf"].map((name) => ({ name, size: 1 }));
  const out = precheckFiles(files, { ...limits, taken: 3 });
  assert.deepEqual(out.accepted.map((f) => f.name), ["1.pdf", "2.pdf"]);
  assert.deepEqual(out.skipped, [
    { name: "3.pdf", reason: "only 5 files can be attached" },
    { name: "4.pdf", reason: "only 5 files can be attached" },
  ]);
});

test("precheck: a rejected file does not use up a slot", () => {
  const out = precheckFiles([{ name: "bad.exe", size: 1 }, { name: "good.pdf", size: 1 }], { ...limits, taken: 4 });
  assert.deepEqual(out.accepted.map((f) => f.name), ["good.pdf"]);
});

test("precheck: an over-full control (taken > cap) accepts nothing", () => {
  assert.equal(precheckFiles([{ name: "a.pdf", size: 1 }], { ...limits, taken: 7 }).accepted.length, 0);
});

test("precheck: unknown limits (config still loading) leave size and count to the server", () => {
  const files = Array.from({ length: 9 }, (_, i) => ({ name: `${i}.pdf`, size: 500 * MB }));
  const out = precheckFiles(files, { maxUploadSizeMb: null, maxPerItem: null, taken: 0 });
  assert.equal(out.accepted.length, 9);
});

test("skippedMessage: one combined message, or none", () => {
  assert.equal(skippedMessage([]), null);
  assert.equal(
    skippedMessage([
      { name: "setup.exe", reason: "file type not allowed" },
      { name: "big.zip", reason: "over 10 MB" },
    ]),
    "Skipped: setup.exe (file type not allowed), big.zip (over 10 MB)",
  );
});

test("intakeAnnouncement: added and skipped counts", () => {
  assert.equal(intakeAnnouncement(1, 0), "1 file added");
  assert.equal(intakeAnnouncement(2, 1), "2 files added, 1 skipped");
  assert.equal(intakeAnnouncement(0, 3), "3 skipped");
});

test("dragCarriesFiles: only file drags raise the overlay", () => {
  assert.equal(dragCarriesFiles(["Files"]), true);
  assert.equal(dragCarriesFiles(["text/plain", "Files"]), true);
  assert.equal(dragCarriesFiles(["text/plain", "text/html"]), false);
  assert.equal(dragCarriesFiles(["text/uri-list"]), false);
  assert.equal(dragCarriesFiles(undefined), false);
});

test("pasteAttaches: files without text attach; any text keeps it a text paste", () => {
  assert.equal(pasteAttaches(["Files"], 1), true); // a screenshot / a file copied in Explorer
  assert.equal(pasteAttaches(["text/plain", "text/html", "Files"], 1), false); // Word/Excel/Outlook
  assert.equal(pasteAttaches(["text/html", "Files"], 1), false);
  assert.equal(pasteAttaches(["text/plain"], 0), false);
  assert.equal(pasteAttaches(["Files"], 0), false);
});

test("routePaste: focus wins, else the only control, else ambiguous", () => {
  assert.deepEqual(routePaste("b", ["a", "b"]), { kind: "target", id: "b" });
  assert.deepEqual(routePaste(null, ["a"]), { kind: "target", id: "a" });
  assert.deepEqual(routePaste("gone", ["a"]), { kind: "target", id: "a" });
  assert.deepEqual(routePaste(null, ["a", "b"]), { kind: "ambiguous" });
  assert.deepEqual(routePaste("gone", ["a", "b"]), { kind: "ambiguous" });
  assert.deepEqual(routePaste(null, []), { kind: "none" });
  assert.ok(!PASTE_AMBIGUOUS_MESSAGE.includes("§"));
});

test("pastedFileName: generic clipboard names get a local-time stamp; real names are kept", () => {
  const now = new Date(2026, 9, 4, 9, 3, 7); // local time
  assert.equal(pastedFileName("image.png", "image/png", now), "pasted-image-2026-10-04-090307.png");
  assert.equal(pastedFileName("image.JPG", "image/jpeg", now), "pasted-image-2026-10-04-090307.jpg");
  assert.equal(pastedFileName("", "image/webp", now), "pasted-image-2026-10-04-090307.webp");
  assert.equal(pastedFileName("blob", "image/gif", now), "pasted-image-2026-10-04-090307.gif");
  assert.equal(pastedFileName("image", "application/octet-stream", now), "pasted-image-2026-10-04-090307.png");
  assert.equal(pastedFileName("roadmap.pdf", "application/pdf", now), "roadmap.pdf");
  assert.equal(pastedFileName("image-of-the-bug.png", "image/png", now), "image-of-the-bug.png");
});
