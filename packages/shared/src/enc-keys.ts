// The §2.3 at-rest encryption keys and their startup validation (INNOBOX_SPEC.md §2.3 "Key
// validation"): EMAIL_TOKEN_ENC_KEY, WEBHOOK_ENC_KEY, AI_TOKEN_ENC_KEY and PUBLIC_INTAKE_KEY are
// each 32 bytes, base64. A set value must be STRICT base64 — the standard alphabet, correct
// padding, no whitespace, canonical trailing bits — so a value with stray characters is refused
// instead of silently decoded to fewer bytes (Buffer.from drops what it cannot read), and the set
// values must be pairwise distinct: the four rotate independently and a shared key defeats that.
// Pure and dependency-free (Buffer only), so the web instrumentation hook (edge-compiled file,
// node-only dynamic import), the worker entry and the unit tests share one rule. Nothing here
// ever echoes a key's value — a message names the variable only.

/** Standard-alphabet base64 with correct `=` padding and a length that is a multiple of four. */
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode strict base64, or null. Strict means: non-empty, the standard alphabet only (no URL-safe
 *  variant, no whitespace, nothing after the padding), correct padding, and canonical — the value
 *  re-encodes to itself, so leftover bits in the last character are refused too. Unlike
 *  `Buffer.from(v, "base64")`, which skips characters it does not understand, a value that is not
 *  exactly base64 is a null here rather than a shorter buffer. */
export function decodeStrictBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0 || !STRICT_BASE64_RE.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

/** The byte length every §2.3 encryption key must decode to (AES-256 / HMAC-SHA-256). */
export const ENC_KEY_BYTES = 32;

/** Parse one §2.3 key: strict base64 decoding to exactly 32 bytes, else null (unset or invalid —
 *  the feature behind the key stays off). The single parser behind parseEmailTokenKey,
 *  parseWebhookKey, parseAiKey and parsePublicIntakeKey. */
export function parseEncryptionKey(keyB64: string | undefined | null): Buffer | null {
  if (!keyB64) return null;
  const bytes = decodeStrictBase64(keyB64);
  return bytes !== null && bytes.length === ENC_KEY_BYTES ? bytes : null;
}

/** The four §2.3 key variables, in the order the messages list them. */
export const ENCRYPTION_KEY_VARIABLES = ["EMAIL_TOKEN_ENC_KEY", "WEBHOOK_ENC_KEY", "AI_TOKEN_ENC_KEY", "PUBLIC_INTAKE_KEY"] as const;
export type EncryptionKeyVariable = (typeof ENCRYPTION_KEY_VARIABLES)[number];

export interface EncryptionKeysEnv {
  NODE_ENV?: string;
  EMAIL_TOKEN_ENC_KEY?: string;
  WEBHOOK_ENC_KEY?: string;
  AI_TOKEN_ENC_KEY?: string;
  PUBLIC_INTAKE_KEY?: string;
}

export interface EncryptionKeysStartupCheck {
  /** Fatal structured log line (production only): the process must refuse to start. */
  fatal: string | null;
  /** Structured warning lines to log once at startup (outside production) — one per problem. */
  warnings: string[];
}

interface KeyProblem {
  variables: EncryptionKeyVariable[];
  reason: "not_base64" | "wrong_length" | "duplicate";
  msg: string;
}

/** The problems with the set keys, in variable order, duplicates last. Pure; never echoes a value. */
export function encryptionKeyProblems(env: EncryptionKeysEnv): KeyProblem[] {
  const problems: KeyProblem[] = [];
  const setVariables = ENCRYPTION_KEY_VARIABLES.filter((v) => Boolean(env[v]));
  for (const variable of setVariables) {
    const value = env[variable] as string;
    const bytes = decodeStrictBase64(value);
    if (bytes === null) {
      problems.push({
        variables: [variable],
        reason: "not_base64",
        msg: `${variable} is not strict base64 (standard alphabet, correct padding, no whitespace). Generate it with \`openssl rand -base64 32\`.`,
      });
    } else if (bytes.length !== ENC_KEY_BYTES) {
      problems.push({
        variables: [variable],
        reason: "wrong_length",
        msg: `${variable} does not decode to exactly ${ENC_KEY_BYTES} bytes. Generate it with \`openssl rand -base64 32\`.`,
      });
    }
  }
  // Pairwise distinct — compared as the raw strings (two strict-base64 values are equal exactly
  // when their bytes are). Each pair is reported once, in variable order.
  for (let i = 0; i < setVariables.length; i++) {
    for (let j = i + 1; j < setVariables.length; j++) {
      const a = setVariables[i]!;
      const b = setVariables[j]!;
      if (env[a] === env[b]) {
        problems.push({
          variables: [a, b],
          reason: "duplicate",
          msg: `${a} and ${b} hold the same key; the keys rotate independently and must be distinct.`,
        });
      }
    }
  }
  return problems;
}

/** §2.3 fail-loud startup check, the same pattern as INNOBOX_DEV_AUTH and CSP_MODE: in a
 *  production build any invalid or shared key refuses to start — one fatal line naming the
 *  variable(s), never a value. Outside production each problem is a warn line and the feature
 *  behind an invalid key stays off, as for an unset key (parseEncryptionKey returns null for it).
 *  Pass only the variables the process has: the worker has no PUBLIC_INTAKE_KEY. */
export function encryptionKeysStartupCheck(env: EncryptionKeysEnv): EncryptionKeysStartupCheck {
  const problems = encryptionKeyProblems(env);
  if (problems.length === 0) return { fatal: null, warnings: [] };
  const variables = [...new Set(problems.flatMap((p) => p.variables))];
  if (env.NODE_ENV === "production") {
    return {
      fatal: JSON.stringify({
        level: "fatal",
        msg: `Encryption key check failed in a production build — refusing to start. ${problems.map((p) => p.msg).join(" ")}`,
        variables,
      }),
      warnings: [],
    };
  }
  return {
    fatal: null,
    warnings: problems.map((p) =>
      JSON.stringify({
        level: "warn",
        msg: `${p.msg}${p.reason === "duplicate" ? "" : " The feature behind it stays off until the key is fixed."}`,
        variables: p.variables,
      }),
    ),
  };
}
