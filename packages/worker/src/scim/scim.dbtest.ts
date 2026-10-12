// Live-DB integration test (gated): drives the SCIM router with the literal Entra payload
// shapes from the ENTRA_AUTH_SPEC.md §5 provisioning contract against a real Postgres with db/migrations
// applied. Self-skips when DATABASE_URL is unset so the hermetic unit stage stays green
// (packages/web/src/lib/audit.dbtest.ts style). Groups are cleaned up by the 'scimtest-'
// external_id prefix at the START of the run (SCIM group DELETE is a real, granted
// privilege). Users are NEVER hard-deleted by the app role — invariant 5's sibling: leaver
// is deactivate-only (migration 0003 grants users only SELECT/INSERT/UPDATE) — so this run
// mints a fresh per-run externalId/userName instead of relying on deleting old rows.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "SCIM 2.0 server: full Entra provisioning conformance walk",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const [{ Pool }, express, { default: request }, { createScimRouter }] = await Promise.all([
      import("pg"),
      import("express").then((m) => m.default),
      import("supertest"),
      import("./router.js"),
    ]);

    const pool = new Pool({ connectionString: url });
    const PREFIX = "scimtest-";
    const bearerToken = "scimtest-bearer-8f2c1a9b7e6d4f30"; // gitleaks:allow — test-only fixture
    // Unique per run: avoids colliding with a leftover user row from a prior run, since
    // this test cannot (and must not) hard-delete users.
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    async function cleanup(): Promise<void> {
      // group_members cascades off groups(id); role_mappings has no FK to groups at all,
      // so deleting groups is safe and sufficient (this is the one resource SCIM DELETE
      // is real for — migration 0003 grants DELETE on groups, unlike users).
      await pool.query(`delete from groups where external_id like $1`, [`${PREFIX}%`]);
    }

    await cleanup();

    const app = express();
    app.use("/scim/v2", createScimRouter(pool, { bearerToken }));

    const auth = (req: import("supertest").Test) => req.set("Authorization", `Bearer ${bearerToken}`);

    try {
      // ── auth ─────────────────────────────────────────────────────────────────────────
      const noAuth = await request(app).get("/scim/v2/Users");
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.body.schemas?.[0], "urn:ietf:params:scim:api:messages:2.0:Error");

      const wrongAuth = await request(app).get("/scim/v2/Users").set("Authorization", "Bearer nope");
      assert.equal(wrongAuth.status, 401);

      // ── create — literal Entra POST /Users payload ──────────────────────────────────
      const userExternalId = `${PREFIX}${runId}-user`;
      const userName = `${PREFIX}${runId}-ada@contoso.com`;
      const createPayload = {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: userExternalId,
        userName,
        active: true,
        displayName: "Ada Lovelace",
        name: { givenName: "Ada", familyName: "Lovelace" },
        emails: [{ value: userName, type: "work", primary: true }],
        title: "Mathematician",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Analytical Engines" },
      };
      const created = await auth(request(app).post("/scim/v2/Users").send(createPayload));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.externalId, userExternalId);
      assert.equal(created.body.meta.resourceType, "User");
      assert.ok(created.body.id, "server-assigned id present");
      const userId: string = created.body.id;

      // ── GET-filter (Entra's existence probe before every create) ────────────────────
      const byUserName = await auth(request(app).get(`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`));
      assert.equal(byUserName.status, 200);
      assert.equal(byUserName.body.totalResults, 1);
      assert.equal(byUserName.body.Resources[0].id, userId);

      const byExternalId = await auth(
        request(app).get(`/scim/v2/Users?filter=${encodeURIComponent(`externalId eq "${userExternalId}"`)}`),
      );
      assert.equal(byExternalId.status, 200);
      assert.equal(byExternalId.body.totalResults, 1);

      const invalidFilter = await auth(request(app).get(`/scim/v2/Users?filter=${encodeURIComponent(`title eq "x"`)}`));
      assert.equal(invalidFilter.status, 400);
      assert.equal(invalidFilter.body.scimType, "invalidFilter");

      // ── duplicate POST must not duplicate ────────────────────────────────────────────
      const dup = await auth(request(app).post("/scim/v2/Users").send(createPayload));
      assert.equal(dup.body.id, userId, "same row returned, not a new one");
      const { rows: dupCount } = await pool.query(`select count(*)::int as n from users where external_id = $1`, [
        userExternalId,
      ]);
      assert.equal(dupCount[0].n, 1, "no duplicate row created");

      // ── 409 uniqueness on a conflicting userName under a DIFFERENT externalId ────────
      const conflictExternalId = `${PREFIX}${runId}-conflict`;
      const conflict = await auth(
        request(app)
          .post("/scim/v2/Users")
          .send({ ...createPayload, externalId: conflictExternalId }),
      );
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.scimType, "uniqueness");

      // ── office_location is reconciliation-owned: SCIM must never clobber it (§13.8) ─────
      // Stamp the column the way the Graph reconciliation pass would, then let the PATCH and PUT
      // below run: SCIM carries no office attribute, so both writes must leave the value alone.
      // A regression here (adding office_location to SCIM's column lists) would silently wipe the
      // directory profile of every provisioned user on the next sync cycle.
      await pool.query(`update users set office_location = 'Sofia' where id = $1`, [userId]);

      // ── PATCH deactivate — the capitalized-string-boolean quirk ──────────────────────
      const deactivate = await auth(
        request(app)
          .patch(`/scim/v2/Users/${userId}`)
          .send({
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [{ op: "Replace", path: "active", value: "False" }],
          }),
      );
      assert.equal(deactivate.status, 200, JSON.stringify(deactivate.body));
      assert.equal(deactivate.body.active, false);
      const { rows: afterDeactivate } = await pool.query(`select active, deactivated_at from users where id = $1`, [
        userId,
      ]);
      assert.equal(afterDeactivate[0].active, false);
      assert.ok(afterDeactivate[0].deactivated_at, "deactivated_at stamped");

      // ── reactivate ────────────────────────────────────────────────────────────────────
      const reactivate = await auth(
        request(app)
          .patch(`/scim/v2/Users/${userId}`)
          .send({ Operations: [{ op: "replace", path: "active", value: true }] }),
      );
      assert.equal(reactivate.status, 200);
      assert.equal(reactivate.body.active, true);
      const { rows: afterReactivate } = await pool.query(`select active, deactivated_at from users where id = $1`, [
        userId,
      ]);
      assert.equal(afterReactivate[0].active, true);
      assert.equal(afterReactivate[0].deactivated_at, null, "reactivation clears deactivated_at");

      // ── PUT full replace — externalId omitted, taken from the stored row ─────────────
      const put = await auth(
        request(app)
          .put(`/scim/v2/Users/${userId}`)
          .send({
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName,
            active: true,
            displayName: "Ada Lovelace, Countess of Lovelace",
            emails: [{ value: userName, type: "work", primary: true }],
          }),
      );
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.body.externalId, userExternalId, "externalId preserved from the stored row");
      assert.equal(put.body.displayName, "Ada Lovelace, Countess of Lovelace");

      const { rows: afterScimWrites } = await pool.query<{ office_location: string | null }>(
        `select office_location from users where id = $1`,
        [userId],
      );
      assert.equal(
        afterScimWrites[0]!.office_location,
        "Sofia",
        "SCIM PATCH/PUT must never touch office_location — reconciliation owns it (§13.8)",
      );

      // ── group create ──────────────────────────────────────────────────────────────────
      const groupExternalId = `${PREFIX}${runId}-group`;
      const groupCreated = await auth(
        request(app).post("/scim/v2/Groups").send({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          externalId: groupExternalId,
          displayName: `${PREFIX}Engineering`,
        }),
      );
      assert.equal(groupCreated.status, 201, JSON.stringify(groupCreated.body));
      const groupId: string = groupCreated.body.id;

      // ── membership add (incl. an unknown member id — tolerated, never 400/500) ───────
      const unknownMemberId = "00000000-0000-0000-0000-000000000000";
      const add = await auth(
        request(app)
          .patch(`/scim/v2/Groups/${groupId}`)
          .send({
            Operations: [{ op: "Add", path: "members", value: [{ value: userId }, { value: unknownMemberId }] }],
          }),
      );
      assert.equal(add.status, 200, JSON.stringify(add.body));
      const { rows: membershipAfterAdd } = await pool.query(
        `select user_id from group_members where group_id = $1`,
        [groupId],
      );
      assert.deepEqual(
        membershipAfterAdd.map((r: { user_id: string }) => r.user_id),
        [userId],
        "known member added, unknown member id silently ignored",
      );
      const { rows: anomalyRows } = await pool.query(
        `select action from audit_log where target_type = 'group' and target_id = $1 and action = 'scim.anomaly'`,
        [groupId],
      );
      assert.ok(anomalyRows.length >= 1, "unknown member id on add is audited as scim.anomaly");

      // ── remove-by-filter form ─────────────────────────────────────────────────────────
      const remove = await auth(
        request(app)
          .patch(`/scim/v2/Groups/${groupId}`)
          .send({ Operations: [{ op: "Remove", path: `members[value eq "${userId}"]` }] }),
      );
      assert.equal(remove.status, 200, JSON.stringify(remove.body));
      const { rows: membershipAfterRemove } = await pool.query(
        `select user_id from group_members where group_id = $1`,
        [groupId],
      );
      assert.equal(membershipAfterRemove.length, 0);

      // ── user DELETE — leaver semantics, idempotent ───────────────────────────────────
      const del1 = await auth(request(app).delete(`/scim/v2/Users/${userId}`));
      assert.equal(del1.status, 204);
      const { rows: afterDel1 } = await pool.query(`select active, deactivated_at from users where id = $1`, [userId]);
      assert.equal(afterDel1[0].active, false);
      assert.ok(afterDel1[0].deactivated_at);

      const del2 = await auth(request(app).delete(`/scim/v2/Users/${userId}`));
      assert.equal(del2.status, 204, "second DELETE is idempotent, not an error");

      const delUnknown = await auth(request(app).delete(`/scim/v2/Users/00000000-0000-0000-0000-000000000000`));
      assert.equal(delUnknown.status, 204, "DELETE of an unknown id is also idempotent 204, never 404/500");

      // ── GET/PUT/PATCH on an unknown id -> 404 (distinct from DELETE's tolerance) ─────
      const getUnknown = await auth(request(app).get(`/scim/v2/Users/00000000-0000-0000-0000-000000000000`));
      assert.equal(getUnknown.status, 404);
      assert.equal(getUnknown.body.schemas?.[0], "urn:ietf:params:scim:api:messages:2.0:Error");

      // ── group DELETE — group + memberships gone ──────────────────────────────────────
      const delGroup = await auth(request(app).delete(`/scim/v2/Groups/${groupId}`));
      assert.equal(delGroup.status, 204);
      const { rows: groupGone } = await pool.query(`select 1 from groups where id = $1`, [groupId]);
      assert.equal(groupGone.length, 0);

      // ── discovery documents (Entra "Test Connection" tolerance) ──────────────────────
      const spConfig = await auth(request(app).get("/scim/v2/ServiceProviderConfig"));
      assert.equal(spConfig.status, 200);
      assert.equal(spConfig.body.patch.supported, true);
      assert.equal(spConfig.body.filter.supported, true);
    } finally {
      await cleanup();
      await pool.end();
    }
  },
);

test(
  "SCIM 2.0 server: never writes to or returns a GDPR-erased user (INNOBOX_SPEC.md §3)",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const [{ Pool }, express, { default: request }, { createScimRouter }] = await Promise.all([
      import("pg"),
      import("express").then((m) => m.default),
      import("supertest"),
      import("./router.js"),
    ]);

    const pool = new Pool({ connectionString: url });
    const PREFIX = "scimtest-erased-";
    const bearerToken = "scimtest-bearer-8f2c1a9b7e6d4f30"; // gitleaks:allow — test-only fixture
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const cleanup = () => pool.query(`delete from groups where external_id like $1`, [`${PREFIX}%`]);
    await cleanup();

    const app = express();
    app.use("/scim/v2", createScimRouter(pool, { bearerToken }));
    const auth = (req: import("supertest").Test) => req.set("Authorization", `Bearer ${bearerToken}`);

    try {
      // Provision a user through SCIM, then erase it the way scrubUser does (the web tier owns the
      // real erasure; the columns that matter to SCIM are scrubbed_at, user_name and the PII).
      const externalId = `${PREFIX}${runId}-user`;
      const userName = `${PREFIX}${runId}-grace@example.com`;
      const userPayload = {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId,
        userName,
        active: true,
        displayName: "Grace Hopper",
        emails: [{ value: userName, type: "work", primary: true }],
        title: "Rear Admiral",
      };
      const created = await auth(request(app).post("/scim/v2/Users").send(userPayload));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const userId: string = created.body.id;
      await pool.query(
        `update users
            set display_name = 'Deleted User', user_name = 'deleted-' || id, email = null, job_title = null,
                department = null, active = false, deactivated_at = now(), scim_synced = false, scrubbed_at = now()
          where id = $1`,
        [userId],
      );
      const snapshot = async () =>
        (
          await pool.query(
            `select display_name, user_name, email, job_title, active, scim_synced, external_id, updated_at
               from users where id = $1`,
            [userId],
          )
        ).rows[0];
      const erased = await snapshot();

      // ── every id-addressed verb answers 404, and nothing on the row changes ──────────────
      const get = await auth(request(app).get(`/scim/v2/Users/${userId}`));
      assert.equal(get.status, 404, "GET on an erased user is 404");
      assert.equal(get.body.schemas?.[0], "urn:ietf:params:scim:api:messages:2.0:Error");

      const put = await auth(request(app).put(`/scim/v2/Users/${userId}`).send(userPayload));
      assert.equal(put.status, 404, "PUT on an erased user is 404 — it never refills the PII");

      const patch = await auth(
        request(app)
          .patch(`/scim/v2/Users/${userId}`)
          .send({
            Operations: [
              { op: "replace", path: "active", value: true },
              { op: "replace", path: "displayName", value: "Grace Hopper" },
            ],
          }),
      );
      assert.equal(patch.status, 404, "PATCH on an erased user is 404 — it never reactivates the row");

      const del = await auth(request(app).delete(`/scim/v2/Users/${userId}`));
      assert.equal(del.status, 404, "DELETE on an erased user is 404, not the idempotent 204");

      // ── a POST keyed on the erased row's externalId answers 409 ──────────────────────────
      const post = await auth(request(app).post("/scim/v2/Users").send(userPayload));
      assert.equal(post.status, 409, JSON.stringify(post.body));
      assert.equal(post.body.schemas?.[0], "urn:ietf:params:scim:api:messages:2.0:Error");
      const { rows: sameExternal } = await pool.query(`select count(*)::int as n from users where external_id = $1`, [
        externalId,
      ]);
      assert.equal(sameExternal[0].n, 1, "no second row is created for the erased externalId");

      assert.deepEqual(await snapshot(), erased, "no refused request wrote anything to the erased row");

      // ── list and filter reads exclude the erased row, totalResults included ──────────────
      const byExternalId = await auth(
        request(app).get(`/scim/v2/Users?filter=${encodeURIComponent(`externalId eq "${externalId}"`)}`),
      );
      assert.equal(byExternalId.status, 200);
      assert.equal(byExternalId.body.totalResults, 0);

      const byUserName = await auth(
        request(app).get(`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "deleted-${userId}"`)}`),
      );
      assert.equal(byUserName.body.totalResults, 0, "the scrubbed userName token is not findable either");

      const list = await auth(request(app).get(`/scim/v2/Users?count=200`));
      assert.equal(list.status, 200);
      const { rows: counts } = await pool.query<{ live: number; total: number }>(
        `select count(*) filter (where scrubbed_at is null)::int as live, count(*)::int as total from users`,
      );
      assert.equal(list.body.totalResults, counts[0]!.live, "totalResults counts only non-erased users");
      assert.ok(counts[0]!.total > counts[0]!.live, "the erased row exists but is not counted");
      assert.equal(
        (list.body.Resources as Array<{ id: string }>).some((r) => r.id === userId),
        false,
        "the erased row is not on the page",
      );

      // ── a group membership add naming the erased user writes nothing ─────────────────────
      const group = await auth(
        request(app)
          .post("/scim/v2/Groups")
          .send({ externalId: `${PREFIX}${runId}-group`, displayName: `${PREFIX}${runId}`, members: [{ value: userId }] }),
      );
      assert.equal(group.status, 201, JSON.stringify(group.body));
      const groupId: string = group.body.id;
      const patchAdd = await auth(
        request(app)
          .patch(`/scim/v2/Groups/${groupId}`)
          .send({ Operations: [{ op: "Add", path: "members", value: [{ value: userId }] }] }),
      );
      assert.equal(patchAdd.status, 200);
      const putGroup = await auth(
        request(app)
          .put(`/scim/v2/Groups/${groupId}`)
          .send({ displayName: `${PREFIX}${runId}`, members: [{ value: userId }] }),
      );
      assert.equal(putGroup.status, 200);
      const { rows: members } = await pool.query(`select 1 from group_members where user_id = $1`, [userId]);
      assert.equal(members.length, 0, "POST, PATCH and PUT on /Groups never add an erased user");
      const { rows: memberAnomalies } = await pool.query<{ n: number }>(
        `select count(*)::int as n from audit_log
          where action = 'scim.anomaly' and target_type = 'group' and target_id = $1
            and after->>'reason' = 'unknown_member_id_on_add'`,
        [groupId],
      );
      assert.equal(memberAnomalies[0]!.n, 3, "each refused membership add is audited as an unknown member");

      // ── every refusal on the erased row is audited as scim.anomaly ───────────────────────
      const { rows: refusals } = await pool.query<{ request: string }>(
        `select after->>'request' as request from audit_log
          where action = 'scim.anomaly' and target_type = 'user' and target_id = $1
            and after->>'reason' = 'scrubbed_user'
          order by request`,
        [userId],
      );
      assert.deepEqual(
        refusals.map((r) => r.request),
        ["DELETE /Users/:id", "GET /Users/:id", "PATCH /Users/:id", "POST /Users", "PUT /Users/:id"],
      );
    } finally {
      await cleanup();
      await pool.end();
    }
  },
);
