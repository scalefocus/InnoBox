// INNOBOX_SPEC.md §24.2, §24.4, §24.9: the public routes' decision tree, without a database —
// every route 404s while the form is off; the per-IP limits; the body rules; the proof-of-work
// (missing, forged, expired, spent); the silent drops (honeypot, too fast, address cap) answer the
// normal 202 and store nothing; the platform ceiling is a 429; confirm answers one 410 for
// everything invalid; the counter records each outcome; the dev token only behind the seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MIN_SUBMIT_DELAY_MS, issuePowChallenge, type PublicSubmissionFields } from "@innobox/shared";
import { resetRateLimits } from "../../../lib/rate-limit";
import { publicSubmissionCounts, resetPublicSubmissionCounts } from "../../../lib/public-intake";
import type { ConfirmResult, ReceiveResult } from "./store";
import {
  LINK_INVALID,
  VERIFICATION_FAILED,
  handlePublicConfirm,
  handlePublicMethodNotAllowed,
  handlePublicPow,
  handlePublicSettings,
  handlePublicSubmission,
  type PublicRouteDeps,
} from "./handlers";

const KEY = Buffer.alloc(32, 5);
const T0 = Date.UTC(2026, 9, 13, 9, 0, 0);
let ipSeq = 0;

function deps(over: Partial<PublicRouteDeps> & { received?: PublicSubmissionFields[] } = {}): PublicRouteDeps & { received: PublicSubmissionFields[] } {
  const received: PublicSubmissionFields[] = over.received ?? [];
  return {
    state: async () => ({ live: true, privacyNotice: "We keep your data for review only." }),
    key: () => KEY,
    clientIp: `203.0.113.${++ipSeq % 250}`,
    now: () => T0 + 10_000,
    receive: async (fields): Promise<ReceiveResult> => {
      received.push(fields);
      return { status: "received", id: "id-1", token: "T".repeat(43) };
    },
    confirm: async (): Promise<ConfirmResult> => ({ status: "confirmed", id: "id-1" }),
    received,
    ...over,
  };
}

const off = (): Partial<PublicRouteDeps> => ({ state: async () => ({ live: false, privacyNotice: "" }) });

function solve(salt: string, challenge: string, max: number): number {
  for (let n = 0; n <= max; n++) if (createHash("sha256").update(`${salt}${n}`).digest("hex") === challenge) return n;
  throw new Error("unsolvable");
}

/** A valid answer to a challenge issued at T0 (so "now" = T0 + 10 s is past the 3-second floor). */
function solvedPow(issuedAt = T0): { salt: string; number: number; signature: string } {
  const c = issuePowChallenge(KEY, issuedAt, 200);
  return { salt: c.salt, number: solve(c.salt, c.challenge, 200), signature: c.signature };
}

function post(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request("http://localhost/api/public/submissions", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

const FORM = { title: "Our idea", description: "Details", name: "Ann", email: "ann@example.org", company: "Acme", consent: true, website: "" };

const count = (outcome: string) => publicSubmissionCounts().find((c) => c.outcome === outcome)?.count ?? 0;

test.beforeEach(() => {
  resetRateLimits();
  resetPublicSubmissionCounts();
});

test("every public route answers 404 while the form is off — any method", async () => {
  assert.equal((await handlePublicSettings(deps(off()))).status, 404);
  assert.equal((await handlePublicPow(deps(off()))).status, 404);
  assert.equal((await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), deps(off()))).status, 404);
  assert.equal((await handlePublicConfirm(post({ token: "x" }), deps(off()))).status, 404);
  assert.equal((await handlePublicMethodNotAllowed(deps(off()), "GET")).status, 404);
  const live = await handlePublicMethodNotAllowed(deps(), "GET");
  assert.equal(live.status, 405);
  assert.equal(live.headers.get("allow"), "GET");
});

test("settings returns the privacy notice alone", async () => {
  const res = await handlePublicSettings(deps());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { privacyNotice: "We keep your data for review only." });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("pow issues a signed challenge; a missing key is a 404", async () => {
  const res = await handlePublicPow(deps());
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["algorithm", "challenge", "maxNumber", "salt", "signature"]);
  assert.equal((await handlePublicPow(deps({ key: () => null }))).status, 404);
});

test("GET routes allow 30 per minute per IP, then 429 with Retry-After", async () => {
  const d = deps();
  for (let i = 0; i < 30; i++) assert.equal((await handlePublicSettings(d)).status, 200);
  const res = await handlePublicSettings(d);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal(count("ip_limited"), 1);
});

test("a valid submission is received: 202, stored once, counted", async () => {
  const d = deps();
  const res = await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), d);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(d.received.length, 1);
  assert.equal(d.received[0]!.company, "Acme");
  assert.equal(count("received"), 1);
});

test("field errors are 422; non-JSON is 415; over 64 KB is 413", async () => {
  assert.equal((await handlePublicSubmission(post({ ...FORM, title: "", pow: solvedPow() }), deps())).status, 422);
  assert.equal((await handlePublicSubmission(post({ ...FORM, consent: false, pow: solvedPow() }), deps())).status, 422);
  assert.equal((await handlePublicSubmission(post({ ...FORM, email: "nope", pow: solvedPow() }), deps())).status, 422);
  assert.equal((await handlePublicSubmission(post("{}", { "content-type": "text/plain" }), deps())).status, 415);
  assert.equal((await handlePublicSubmission(post({ ...FORM, description: "x".repeat(70_000) }), deps())).status, 413);
});

test("a missing, forged, expired or spent proof-of-work is 403", async () => {
  const d = deps();
  const missing = await handlePublicSubmission(post(FORM), d);
  assert.equal(missing.status, 403);
  assert.equal(((await missing.json()) as { error: string }).error, VERIFICATION_FAILED);
  const pow = solvedPow();
  assert.equal((await handlePublicSubmission(post({ ...FORM, pow: { ...pow, number: pow.number + 1 } }), deps())).status, 403);
  const expired = deps({ now: () => T0 + 11 * 60_000 });
  assert.equal((await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), expired)).status, 403);
  const spent = deps({ receive: async () => ({ status: "spent" }) });
  assert.equal((await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), spent)).status, 403);
  assert.equal(d.received.length, 0);
  assert.equal(count("pow_failed"), 4);
});

test("the honeypot and a too-fast answer are dropped silently: 202, nothing stored", async () => {
  const d = deps();
  const honey = await handlePublicSubmission(post({ ...FORM, website: "https://spam.example", pow: solvedPow() }), d);
  assert.equal(honey.status, 202);
  const fast = deps({ now: () => T0 + MIN_SUBMIT_DELAY_MS - 1, received: d.received });
  assert.equal((await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), fast)).status, 202);
  assert.equal(d.received.length, 0);
  assert.equal(count("honeypot"), 1);
  assert.equal(count("too_fast"), 1);
});

test("the per-address cap is a silent 202; the platform ceiling a 429", async () => {
  const capped = await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), deps({ receive: async () => ({ status: "address_capped" }) }));
  assert.equal(capped.status, 202);
  assert.deepEqual(await capped.json(), { ok: true });
  const ceiling = await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), deps({ receive: async () => ({ status: "ceiling" }) }));
  assert.equal(ceiling.status, 429);
  assert.equal(count("address_capped"), 1);
  assert.equal(count("ceiling"), 1);
});

test("submissions allow 5 per hour per IP", async () => {
  const d = deps();
  for (let i = 0; i < 5; i++) assert.equal((await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), d)).status, 202);
  assert.equal((await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), d)).status, 429);
});

test("the confirmation token reaches the response only behind the dev seam", async () => {
  const plain = await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), deps());
  assert.deepEqual(await plain.json(), { ok: true });
  const seam = await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), deps({ exposeDevToken: true }));
  assert.deepEqual(await seam.json(), { ok: true, devConfirmToken: "T".repeat(43) });
});

test("confirm: 200 once; malformed, unknown, expired and used are one 410", async () => {
  const token = "A".repeat(43);
  const ok = await handlePublicConfirm(post({ token }), deps());
  assert.equal(ok.status, 200);
  assert.equal(count("confirmed"), 1);
  for (const bad of ["short", 42, null]) {
    const res = await handlePublicConfirm(post({ token: bad }), deps());
    assert.equal(res.status, 410);
    assert.equal(((await res.json()) as { error: string }).error, LINK_INVALID);
  }
  const invalid = await handlePublicConfirm(post({ token }), deps({ confirm: async () => ({ status: "invalid" }) }));
  assert.equal(invalid.status, 410);
});

test("a failing store is a fixed 500, never a throw", async () => {
  const res = await handlePublicSubmission(post({ ...FORM, pow: solvedPow() }), deps({ receive: async () => Promise.reject(new Error("db down")) }));
  assert.equal(res.status, 500);
});
