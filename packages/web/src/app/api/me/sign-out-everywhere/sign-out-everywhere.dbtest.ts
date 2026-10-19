// Live-DB integration test (gated) for "Sign out everywhere" (INNOBOX_SPEC.md §3, §15): the
// store stamps `users.sessions_valid_from = now()` and audits `user.signed_out_everywhere` with
// the user as actor and target; a DB round trip of the timestamptz column through the pure
// getSessionUser() comparison refuses a token issued before the stamp and accepts one issued
// after it; a never-stamped row accepts every token; a second stamp moves the line forward.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

test("§3 signOutEverywhere stamps the column, audits actor = target, and the stamp refuses older tokens", { skip }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { signOutEverywhere } = await import("./store");
  const { isSessionRevoked, nowInSeconds } = await import("../../../../lib/session-revocation");

  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, true) returning id`,
      [`dbtest-soe-${stamp}`, `dbtest-soe-${stamp}@example.test`, `Dbtest SignOutEverywhere ${stamp}`, `soe-${stamp}@example.test`],
    );
    const userId = rows[0]!.id;
    const readStamp = async () => {
      const { rows: r } = await pool.query<{ sessions_valid_from: Date | null }>(`select sessions_valid_from from users where id = $1`, [userId]);
      return r[0]!.sessions_valid_from;
    };

    // Never stamped: every token is accepted, with or without the issuedAt claim.
    assert.equal(await readStamp(), null);
    const olderToken = nowInSeconds() - 3600; // minted an hour ago on another device
    assert.equal(isSessionRevoked({ issuedAt: olderToken, sessionsValidFrom: await readStamp() }), false);
    assert.equal(isSessionRevoked({ issuedAt: undefined, sessionsValidFrom: await readStamp() }), false);

    const first = await signOutEverywhere(pool, userId);
    assert.ok(first instanceof Date, "returns the stamp as stored");
    const stored = await readStamp();
    assert.ok(stored instanceof Date, "timestamptz round-trips as a Date");
    assert.equal(stored.getTime(), first.getTime());
    assert.ok(Math.abs(stored.getTime() - Date.now()) < 60_000, "stamped at now()");

    assert.equal(isSessionRevoked({ issuedAt: olderToken, sessionsValidFrom: stored }), true, "the other device's token is no session");
    assert.equal(isSessionRevoked({ issuedAt: undefined, sessionsValidFrom: stored }), true, "a token without the claim is refused too");
    const newerToken = nowInSeconds() + 1; // a fresh sign-in after the stamp
    assert.equal(isSessionRevoked({ issuedAt: newerToken, sessionsValidFrom: stored }), false, "a sign-in after the stamp is accepted");

    const { rows: audit } = await pool.query<{ actor_user_id: string | null; target_type: string; target_id: string | null; after: { sessionsValidFrom?: string } | null }>(
      `select actor_user_id, target_type, target_id, after from audit_log where action = 'user.signed_out_everywhere' and target_id = $1`,
      [userId],
    );
    assert.equal(audit.length, 1, "audited exactly once");
    assert.equal(audit[0]!.actor_user_id, userId, "actor = target");
    assert.equal(audit[0]!.target_type, "user");
    assert.equal(audit[0]!.after?.sessionsValidFrom, first.toISOString());

    // A second stamp moves the line forward: the sign-in that was fine a moment ago is now out.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await signOutEverywhere(pool, userId);
    assert.ok(second && second.getTime() > first.getTime(), "a later stamp is strictly later");
    assert.equal(isSessionRevoked({ issuedAt: newerToken, sessionsValidFrom: await readStamp() }), true);

    // An unknown user: nothing stamped, nothing audited.
    assert.equal(await signOutEverywhere(pool, randomUUID()), null);
  } finally {
    await pool.end();
  }
});
