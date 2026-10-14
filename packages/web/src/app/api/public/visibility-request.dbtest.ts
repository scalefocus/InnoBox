// Live-DB integration test (gated) for the outside submitter's visibility request (INNOBOX_SPEC.md
// §24.3, §24.5, §24.6, §24.8, §4.3). Proves, as the least-privilege app role:
//   - the request (people / teams) is stored with the submission;
//   - the review panel resolves each requested address to a user, or leaves it pending;
//   - accepting as `people` writes the access list with the challenge, in one transaction, and the
//     list grants nothing while the challenge is in triage;
//   - a teams request cannot be accepted as namespace-only in `global` (it would reach everyone);
//   - the erasure empties the requested lists and leaves the challenge's access list alone.
// Self-skips when DATABASE_URL is unset; like the other suites it leaves its rows behind.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§24.3 visibility request: stored, resolved for review, accepted as people or refused as global teams, erased",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { receiveSubmission, confirmSubmission } = await import("./store");
    const admin = await import("../admin/public-submissions/store");
    const challenges = await import("../challenges/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Visreq') returning id`, [
        `dbtest-visreq-${stamp}`,
      ]);
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string, email: string | null = null) =>
        (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, email, display_name) values ($1, $1, $2, $3) returning id`, [
            `dbtest-visreq-${label}-${stamp}`,
            email,
            `Dbtest Visreq ${label}`,
          ])
        ).rows[0]!.id;
      const knownEmail = `known.${stamp}@corp.example.test`;
      const knownId = await mkUser("known", knownEmail);
      const unknownEmail = `nobody.${stamp}@corp.example.test`;
      const platformAdmin = { userId: await mkUser("admin"), roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }) };
      const internal = (await challenges.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const salt = () => `${randomUUID().replace(/-/g, "").slice(0, 24)}?expires=${Date.now() + 600_000}`;

      const submit = async (label: string, request: { visibility: "org" | "people" | "teams"; emails: string[]; teams: string[] }) => {
        const r = await receiveSubmission(
          pool,
          {
            title: `${label} ${stamp}`,
            description: `Visibility request ${label} ${stamp}`,
            name: "Zed Outsider",
            email: `zed.${label}.${stamp}@outside.example`,
            company: "Acme Ltd",
            honeypot: "",
            request,
          },
          salt(),
        );
        if (r.status !== "received") throw new Error(`fixture: ${r.status}`);
        assert.equal((await confirmSubmission(pool, r.token)).status, "confirmed");
        return r.id;
      };

      // ── People: stored, resolved, accepted with the list ──────────────────────────────────
      const peopleId = await submit("People", { visibility: "people", emails: [knownEmail, unknownEmail], teams: [] });
      const { rows: stored } = await pool.query<{ requested_visibility: string; requested_emails: string[]; requested_teams: string[] }>(
        `select requested_visibility, requested_emails, requested_teams from public_submissions where id = $1`,
        [peopleId],
      );
      assert.deepEqual(stored[0], { requested_visibility: "people", requested_emails: [knownEmail, unknownEmail], requested_teams: [] });
      const detail = await admin.getPublicSubmission(pool, platformAdmin, peopleId);
      assert.equal(detail?.requestedVisibility, "people");
      assert.deepEqual(detail?.requested.emails, [
        { email: knownEmail, user: { id: knownId, displayName: "Dbtest Visreq known" } },
        { email: unknownEmail, user: null },
      ]);

      const base = { namespaceId: nsId, impactAreaId: internal.id, clientName: null, title: `People ${stamp}`, description: `Visibility request People ${stamp}` };
      assert.equal((await admin.acceptPublicSubmission(pool, platformAdmin, peopleId, { ...base, visibility: "people", access: { userIds: [], emails: [] } })).status, "invalid_access");
      const accepted = await admin.acceptPublicSubmission(pool, platformAdmin, peopleId, {
        ...base,
        visibility: "people",
        access: { userIds: [knownId], emails: [unknownEmail] },
      });
      assert.equal(accepted.status, "ok");
      if (accepted.status !== "ok") throw new Error("fixture");
      const { rows: ch } = await pool.query<{ visibility: string; status: string }>(`select visibility, status from challenges where id = $1`, [accepted.challengeId]);
      assert.deepEqual(ch[0], { visibility: "people", status: "awaiting_triage" });
      const { rows: access } = await pool.query<{ user_id: string | null; email: string | null }>(
        `select user_id, email from challenge_access where challenge_id = $1 order by user_id nulls last`,
        [accepted.challengeId],
      );
      assert.deepEqual(
        access.map((a) => [a.user_id, a.email]),
        [
          [knownId, null],
          [null, unknownEmail],
        ],
      );
      const { rows: via } = await pool.query<{ after: { via: string } }>(`select after from audit_log where target_id = $1 and action = 'challenge.access_changed'`, [
        accepted.challengeId,
      ]);
      assert.equal(via[0]?.after.via, "accept");
      const known = { userId: knownId, roles: buildRoleSet([], { globalNamespaceId: globalId, accessListChallengeIds: [accepted.challengeId] }) };
      assert.equal(await challenges.getChallengeByNumber(pool, known, accepted.number.replace("CH-", "")), null, "nothing while in triage");
      const { rows: shared } = await pool.query(`select 1 from notifications where user_id = $1 and type = 'challenge_shared'`, [knownId]);
      assert.equal(shared.length, 0, "event 15 waits for the challenge to leave triage");

      // ── Erasure: the requested lists go, the access list stays ────────────────────────────
      assert.deepEqual(await admin.eraseSubmissionContact(pool, platformAdmin, peopleId), { status: "ok", erased: true });
      const { rows: erased } = await pool.query<{ requested_visibility: string; requested_emails: string[]; requested_teams: string[] }>(
        `select requested_visibility, requested_emails, requested_teams from public_submissions where id = $1`,
        [peopleId],
      );
      assert.deepEqual(erased[0], { requested_visibility: "people", requested_emails: [], requested_teams: [] });
      const { rows: kept } = await pool.query(`select 1 from challenge_access where challenge_id = $1`, [accepted.challengeId]);
      assert.equal(kept.length, 2, "the challenge's access list is access control, not contact data");

      // ── Teams: never namespace-only in global ─────────────────────────────────────────────
      const teamsId = await submit("Teams", { visibility: "teams", emails: [], teams: ["Payments", "Core Banking"] });
      assert.deepEqual((await admin.getPublicSubmission(pool, platformAdmin, teamsId))?.requested.teams, ["Payments", "Core Banking"]);
      const teamsBase = { ...base, title: `Teams ${stamp}`, description: `Visibility request Teams ${stamp}` };
      assert.deepEqual(await admin.acceptPublicSubmission(pool, platformAdmin, teamsId, { ...teamsBase, namespaceId: globalId, visibility: "namespace" }), {
        status: "teams_need_namespace",
      });
      const { rows: stillPending } = await pool.query<{ status: string }>(`select status from public_submissions where id = $1`, [teamsId]);
      assert.equal(stillPending[0]?.status, "pending_review", "the refusal decided nothing");
      const teamsAccepted = await admin.acceptPublicSubmission(pool, platformAdmin, teamsId, { ...teamsBase, visibility: "namespace" });
      assert.equal(teamsAccepted.status, "ok", "namespace-only in the matching namespace is fine");
    } finally {
      await pool.end();
    }
  },
);
