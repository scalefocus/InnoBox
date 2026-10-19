// Live-DB integration test (gated) for the agent-access OAuth server (INNOBOX_SPEC.md §25.3,
// §25.9, §25.10, §25.12, §25.13):
//   • register → pending authorization (single-use, expiring, bound to its person) → approve →
//     code (single-use, PKCE, redirect-bound) → tokens → bearer → refresh rotation;
//   • a reused refresh token revokes the whole grant (audited, reason refresh_reuse);
//   • a blocked client gets no grant, no refresh and no bearer — and unblocking restores it;
//   • the person's own revoke, deactivation and erasure revoke every grant and token;
//   • the first approval writes the 0-point agent_connected row and earns Plugged In, once;
//   • settings changes are audited with all four values; the hourly sweep clears expired rows.
// Self-skips when DATABASE_URL is unset. It switches agent access on and leaves it off.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "agent access OAuth: consent, codes, rotation, reuse, block, revoke, leavers, badge, sweep",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { createHash, randomUUID, randomBytes } = await import("node:crypto");
    const { eraseUserGrants, revokeUserGrants, sweepOauth } = await import("@innobox/shared");
    const store = await import("./store");
    const { hashToken } = await import("./oauth");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-mcp-${label}-${stamp}`,
          `dbtest-mcp-${label}-${stamp}@example.test`,
          `Dbtest mcp ${label} ${stamp}`,
        ]);
        return rows[0]!.id;
      };
      const person = await mkUser("person");
      const other = await mkUser("other");
      const admin = await mkUser("admin");
      const audit = async (action: string) =>
        (await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = $1 order by id desc`, [action])).rows;

      // Settings: every change is audited with all four values.
      const settings = await store.setMcpSettings(pool, { enabled: true, accessTokenTtlMinutes: 30 }, admin);
      assert.deepEqual(settings, { enabled: true, restrictedContentEnabled: false, accessTokenTtlMinutes: 30, refreshTokenTtlDays: 90 });
      assert.deepEqual((await audit("settings.mcp_changed"))[0]!.after, settings);

      const client = await store.registerClient(
        pool,
        { clientName: `Dbtest Agent ${stamp}`, redirectUris: ["http://127.0.0.1:1/cb"], clientUri: null, logoUri: null, softwareId: null, softwareVersion: null },
        "127.0.0.1",
      );
      assert.equal((await store.findClient(pool, client.clientId))?.id, client.id);
      assert.equal(await store.findClient(pool, "nope"), null);

      const verifier = randomBytes(40).toString("base64url");
      const request = {
        redirectUri: "http://127.0.0.1:5000/cb",
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        state: "s",
        resource: "http://localhost:3000/mcp",
      };

      // Pending authorization: bound to its person, single use, 10 minutes.
      const pendingId = await store.createPendingAuthorization(pool, person, client.id, request);
      assert.equal(await store.consumePendingAuthorization(pool, pendingId, other), null, "bound to its person");
      assert.deepEqual((await store.consumePendingAuthorization(pool, pendingId, person))?.request, request);
      assert.equal(await store.consumePendingAuthorization(pool, pendingId, person), null, "single use");
      const stale = await store.createPendingAuthorization(pool, person, client.id, request);
      await pool.query(`update oauth_pending_authorizations set created_at = now() - interval '11 minutes' where id = $1`, [stale]);
      assert.equal(await store.consumePendingAuthorization(pool, stale, person), null, "expires after 10 minutes");
      assert.equal(await store.consumePendingAuthorization(pool, "not-a-uuid", person), null);

      // Approve: a new grant, audited, plus agent_connected and Plugged In — once.
      const first = await store.approveAuthorization(pool, person, client.id, request);
      assert.ok(first.status === "ok" && first.grantCreated);
      assert.equal((await audit("mcp.grant_created")).filter((r) => r.after.userId === person).length, 1);
      const again = await store.approveAuthorization(pool, person, client.id, request);
      assert.ok(again.status === "ok" && !again.grantCreated, "approving again refreshes the live grant");
      const { rows: ledger } = await pool.query<{ reason: string; points: number; via_mcp: boolean; item_id: string | null }>(
        `select reason, points, via_mcp, item_id from gamification_ledger where user_id = $1`,
        [person],
      );
      assert.deepEqual(ledger, [{ reason: "agent_connected", points: 0, via_mcp: true, item_id: null }]);
      const { rows: badges } = await pool.query<{ badge_key: string }>(`select badge_key from user_badges where user_id = $1`, [person]);
      assert.deepEqual(badges.map((b) => b.badge_key), ["plugged_in"]);

      // Code exchange: PKCE, redirect, single use (a failed attempt burns the code), and a code
      // presented a SECOND time revokes the whole grant (reason code_reuse) — the sibling code of
      // the same grant dies with it.
      if (first.status !== "ok" || again.status !== "ok") throw new Error("approve failed");
      const exchange = (code: string, codeVerifier: string, redirectUri = request.redirectUri) =>
        store.exchangeCode(pool, { code, codeVerifier, clientId: client.clientId, redirectUri, resource: request.resource }, settings);
      assert.equal((await exchange(first.code, "x".repeat(43))).status, "invalid_grant");
      const replayed = await exchange(first.code, verifier);
      assert.deepEqual(replayed, { status: "reuse", of: "code", clientName: client.clientName, userId: person }, "the failed attempt consumed the code; presenting it again is reuse");
      assert.equal((await audit("mcp.grant_revoked"))[0]!.after.reason, "code_reuse");
      assert.equal((await store.listConnections(pool, person)).length, 0, "the whole grant is revoked");
      assert.equal((await exchange(again.code, verifier)).status, "invalid_grant", "the sibling code died with the grant");
      assert.equal((await exchange(first.code, verifier)).status, "invalid_grant", "the replayed code is gone too — no second revocation");
      const fourth = await store.approveAuthorization(pool, person, client.id, request);
      assert.ok(fourth.status === "ok" && fourth.grantCreated, "a new grant after the revocation");
      if (fourth.status !== "ok") throw new Error("approve failed");
      assert.equal((await exchange(fourth.code, verifier, "http://127.0.0.1:5001/cb")).status, "invalid_grant", "redirect URI must match exactly");
      const third = await store.approveAuthorization(pool, person, client.id, request);
      if (third.status !== "ok") throw new Error("approve failed");
      const issued = await exchange(third.code, verifier);
      assert.equal(issued.status, "ok");
      if (issued.status !== "ok") throw new Error("exchange failed");
      assert.equal(issued.tokens.expires_in, 30 * 60, "the access lifetime follows the setting");
      const { rows: stored } = await pool.query<{ n: string }>(`select count(*)::text as n from oauth_tokens where token_hash = $1 or token_hash = $2`, [
        issued.tokens.access_token,
        issued.tokens.refresh_token,
      ]);
      assert.equal(stored[0]!.n, "0", "tokens are stored only as hashes");

      const bearer = await store.authenticateBearer(pool, issued.tokens.access_token);
      assert.ok(bearer.status === "ok" && bearer.principal.userId === person && bearer.principal.clientName === client.clientName);
      assert.equal((await store.authenticateBearer(pool, "x".repeat(43))).status, "invalid");

      // Refresh: rotates; the old one presented again revokes the whole grant.
      const rotated = await store.refreshTokens(pool, { refreshToken: issued.tokens.refresh_token, clientId: client.clientId, resource: null }, settings);
      assert.ok(rotated.status === "ok" && rotated.rotated);
      if (rotated.status !== "ok") throw new Error("rotation failed");
      assert.equal((await store.authenticateBearer(pool, rotated.tokens.access_token)).status, "ok");
      const reuse = await store.refreshTokens(pool, { refreshToken: issued.tokens.refresh_token, clientId: client.clientId, resource: null }, settings);
      assert.equal(reuse.status, "reuse");
      assert.equal((await store.authenticateBearer(pool, rotated.tokens.access_token)).status, "invalid", "the whole grant is gone");
      assert.equal((await store.refreshTokens(pool, { refreshToken: rotated.tokens.refresh_token, clientId: client.clientId, resource: null }, settings)).status, "invalid_grant");
      assert.equal((await audit("mcp.grant_revoked"))[0]!.after.reason, "refresh_reuse");
      assert.equal((await store.listConnections(pool, person)).length, 0);

      const connect = async (userId: string) => {
        const a = await store.approveAuthorization(pool, userId, client.id, request);
        if (a.status !== "ok") return null;
        const t = await exchange(a.code, verifier);
        return t.status === "ok" ? t.tokens : null;
      };
      const refresh = (refreshToken: string, resource: string | null) => store.refreshTokens(pool, { refreshToken, clientId: client.clientId, resource }, settings);

      // Rotation ends the grant's earlier access tokens; the refresh row carries its resource, and a
      // refresh naming a different resource is invalid_grant (the same one, or none, passes).
      const r0 = (await connect(person))!;
      assert.ok(r0);
      const { rows: refreshRows } = await pool.query<{ resource: string | null }>(`select resource from oauth_tokens where token_hash = $1 and kind = 'refresh'`, [hashToken(r0.refresh_token)]);
      assert.equal(refreshRows[0]?.resource, request.resource, "the refresh row carries the resource of the code it came from");
      assert.equal((await refresh(r0.refresh_token, "http://localhost:3000/other")).status, "invalid_grant", "a different resource is refused");
      assert.equal((await store.authenticateBearer(pool, r0.access_token)).status, "ok", "a refused refresh changes nothing");
      const r1 = await refresh(r0.refresh_token, request.resource);
      assert.ok(r1.status === "ok" && r1.rotated, "the same resource passes");
      if (r1.status !== "ok") throw new Error("rotation failed");
      assert.equal((await store.authenticateBearer(pool, r0.access_token)).status, "invalid", "the rotation ended the earlier access token");
      assert.equal((await store.authenticateBearer(pool, r1.tokens.access_token)).status, "ok");
      const { rows: r1Rows } = await pool.query<{ resource: string | null }>(`select resource from oauth_tokens where token_hash = $1 and kind = 'refresh'`, [hashToken(r1.tokens.refresh_token)]);
      assert.equal(r1Rows[0]?.resource, request.resource, "the resource travels through rotation");
      const r2 = await refresh(r1.tokens.refresh_token, null);
      assert.ok(r2.status === "ok", "no resource passes");
      if (r2.status !== "ok") throw new Error("rotation failed");
      assert.equal((await store.authenticateBearer(pool, r1.tokens.access_token)).status, "invalid");
      assert.equal((await store.authenticateBearer(pool, r2.tokens.access_token)).status, "ok");
      const { rows: accessRows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from oauth_tokens t join oauth_grants g on g.id = t.grant_id where g.user_id = $1 and g.revoked_at is null and t.kind = 'access'`,
        [person],
      );
      assert.equal(accessRows[0]!.n, "1", "exactly one live access token after the rotations");

      // A code presented a second time AFTER a successful exchange revokes the grant: the tokens
      // the first exchange minted stop authenticating.
      const [liveConn] = await store.listConnections(pool, person);
      assert.equal(await store.revokeOwnGrant(pool, person, liveConn!.id), true);
      const approvedOnce = await store.approveAuthorization(pool, person, client.id, request);
      if (approvedOnce.status !== "ok") throw new Error("approve failed");
      const minted = await exchange(approvedOnce.code, verifier);
      assert.equal(minted.status, "ok");
      if (minted.status !== "ok") throw new Error("exchange failed");
      assert.equal((await store.authenticateBearer(pool, minted.tokens.access_token)).status, "ok");
      const secondTime = await exchange(approvedOnce.code, verifier);
      assert.ok(secondTime.status === "reuse" && secondTime.of === "code", JSON.stringify(secondTime));
      assert.equal((await audit("mcp.grant_revoked"))[0]!.after.reason, "code_reuse");
      assert.equal((await store.authenticateBearer(pool, minted.tokens.access_token)).status, "invalid", "the first exchange's access token died with the grant");
      assert.equal((await refresh(minted.tokens.refresh_token, null)).status, "invalid_grant", "and so did its refresh token");
      assert.equal((await store.listConnections(pool, person)).length, 0);

      // A fresh connection for the block test.
      const t2 = (await connect(person))!;
      assert.ok(t2);
      const blocked = await store.setClientBlocked(pool, client.id, true, admin);
      assert.equal(blocked?.blocked, true);
      assert.equal((await audit("mcp.client_blocked"))[0]!.after.client, client.clientName);
      assert.equal((await store.authenticateBearer(pool, t2.access_token)).status, "blocked");
      assert.equal((await store.refreshTokens(pool, { refreshToken: t2.refresh_token, clientId: client.clientId, resource: null }, settings)).status, "blocked");
      assert.equal((await store.approveAuthorization(pool, other, client.id, request)).status, "blocked", "no new grant");
      assert.equal((await store.listConnections(pool, person)).length, 1, "a block keeps the grants");
      await store.setClientBlocked(pool, client.id, false, admin);
      assert.equal((await audit("mcp.client_unblocked")).length > 0, true);
      assert.equal((await store.authenticateBearer(pool, t2.access_token)).status, "ok", "unblocking restores the connection");

      // Off is dormant: nothing is revoked (the routes answer 503; the grant and tokens survive).
      await store.setMcpSettings(pool, { enabled: false }, admin);
      assert.equal((await store.authenticateBearer(pool, t2.access_token)).status, "ok");
      await store.setMcpSettings(pool, { enabled: true }, admin);

      // The person's own revoke: someone else cannot; the owner can; audited reason user.
      const [conn] = await store.listConnections(pool, person);
      assert.equal(await store.revokeOwnGrant(pool, other, conn!.id), false);
      assert.equal(await store.revokeOwnGrant(pool, person, conn!.id), true);
      assert.equal((await audit("mcp.grant_revoked"))[0]!.after.reason, "user");
      assert.equal((await store.authenticateBearer(pool, t2.access_token)).status, "invalid");

      // Leavers: deactivation revokes every grant and token; a deactivated person's token fails anyway.
      const t3 = (await connect(person))!;
      assert.equal(await revokeUserGrants(pool, person, "deactivated"), 1);
      assert.equal((await audit("mcp.grant_revoked"))[0]!.after.reason, "deactivated");
      assert.equal((await store.authenticateBearer(pool, t3.access_token)).status, "invalid");
      const t4 = (await connect(other))!;
      await pool.query(`update users set active = false where id = $1`, [other]);
      assert.equal((await store.authenticateBearer(pool, t4.access_token)).status, "invalid", "an inactive person is refused even before revocation");
      await pool.query(`update users set active = true where id = $1`, [other]);

      // Erasure: revoked (reason erased) and the rows deleted.
      await eraseUserGrants(pool, other, admin);
      assert.equal((await audit("mcp.grant_revoked"))[0]!.after.reason, "erased");
      const { rows: left } = await pool.query(`select 1 from oauth_grants where user_id = $1`, [other]);
      assert.equal(left.length, 0);

      // Admin views.
      const clients = await store.listAdminClients(pool);
      assert.ok(clients.some((c) => c.id === client.id && c.liveConnections === 0));
      const counts = await store.mcpCounts(pool);
      assert.ok(counts.registeredClients >= 1);

      // Sweep: expired tokens, consumed pending rows, clients with no grant after 7 days.
      const orphan = await store.registerClient(pool, { clientName: "Orphan", redirectUris: ["https://a.example/cb"], clientUri: null, logoUri: null, softwareId: null, softwareVersion: null }, null);
      await pool.query(`update oauth_clients set created_at = now() - interval '8 days' where id = $1`, [orphan.id]);
      const t5 = (await connect(person))!;
      await pool.query(`update oauth_tokens set expires_at = now() - interval '1 second' where grant_id in (select id from oauth_grants where user_id = $1)`, [person]);
      const swept = await sweepOauth(pool);
      assert.ok(swept.tokens >= 2 && swept.pending >= 1 && swept.clients >= 1, JSON.stringify(swept));
      assert.equal(await store.findClient(pool, orphan.clientId), null);
      assert.notEqual(await store.findClient(pool, client.clientId), null, "a client with grants is kept");
      assert.equal((await store.authenticateBearer(pool, t5.access_token)).status, "invalid");
    } finally {
      await pool.query(`insert into platform_settings (key, value) values ('mcp_enabled', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`).catch(() => {});
      await pool.end();
    }
  },
);
