// The §24.4 proof-of-work, ALTCHA style (INNOBOX_SPEC.md §24.4): the server issues a random salt
// that carries its own expiry, the SHA-256 of salt ‖ n for a secret random n ≤ maxNumber, and an
// HMAC-SHA-256 signature of that hash under PUBLIC_INTAKE_KEY. The browser searches for n and sends
// it back with the submission; the server recomputes the hash from the salt and the number,
// checks the signature over it and the expiry. Nothing is stored at issue time: the signature is
// what proves the challenge is ours, and `public_submissions.pow_salt` (unique) is what makes a
// solved challenge spendable once. Server-only (node:crypto). The key signs this and nothing else.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { parseEmailTokenKey } from "./email-crypto.js";
import { POW_MAX_NUMBER, POW_TTL_MS, type PowSolution } from "./public-intake.js";

export const PUBLIC_INTAKE_KEY_ENV = "PUBLIC_INTAKE_KEY";
export const POW_ALGORITHM = "SHA-256";

/** PUBLIC_INTAKE_KEY (32 bytes, base64). null when unset/invalid — the switch then cannot be
 *  turned on, and the public routes answer 404 (§2.3, §24.2). */
export function parsePublicIntakeKey(keyB64: string | undefined): Buffer | null {
  return parseEmailTokenKey(keyB64);
}

export interface PowChallenge {
  algorithm: typeof POW_ALGORITHM;
  salt: string;
  challenge: string;
  maxNumber: number;
  signature: string;
}

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");
const hmacHex = (key: Buffer, input: string): string => createHmac("sha256", key).update(input, "utf8").digest("hex");

/** salt = 24 hex characters, then `?expires=<epoch ms>`. */
const SALT_RE = /^[0-9a-f]{24}\?expires=(\d{13})$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

/** A fresh challenge, valid for 10 minutes. */
export function issuePowChallenge(key: Buffer, now: number = Date.now(), maxNumber: number = POW_MAX_NUMBER): PowChallenge {
  const salt = `${randomBytes(12).toString("hex")}?expires=${now + POW_TTL_MS}`;
  const secret = randomInt(0, maxNumber + 1);
  const challenge = sha256Hex(`${salt}${secret}`);
  return { algorithm: POW_ALGORITHM, salt, challenge, maxNumber, signature: hmacHex(key, challenge) };
}

export type PowVerdict = { ok: true; issuedAtMs: number } | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Checks the signature, then the expiry. Whether the salt is still unspent is the database's
 *  answer (the unique `pow_salt`), so a `true` here is necessary, not sufficient. */
export function verifyPowSolution(key: Buffer, solution: PowSolution, now: number = Date.now(), maxNumber: number = POW_MAX_NUMBER): PowVerdict {
  const m = SALT_RE.exec(solution.salt);
  if (!m || !SIGNATURE_RE.test(solution.signature)) return { ok: false, reason: "malformed" };
  if (!Number.isSafeInteger(solution.number) || solution.number < 0 || solution.number > maxNumber) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(hmacHex(key, sha256Hex(`${solution.salt}${solution.number}`)), "hex");
  const presented = Buffer.from(solution.signature, "hex");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return { ok: false, reason: "signature" };

  const expiresAt = Number(m[1]);
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, issuedAtMs: expiresAt - POW_TTL_MS };
}

// ── The confirmation token (§24.5) ───────────────────────────────────────────────────────────

/** 32 random bytes, base64url: the link's fragment. Only its SHA-256 is stored. */
export function generateConfirmToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The stored form of a token (hex SHA-256). */
export function hashConfirmToken(token: string): string {
  return sha256Hex(token);
}

/** A token as the confirm route accepts it: exactly the 43 base64url characters we issue. */
export function isConfirmTokenShape(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw);
}
