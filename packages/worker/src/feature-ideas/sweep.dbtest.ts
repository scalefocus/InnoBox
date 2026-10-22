// Live-DB integration test (gated) for the §38.9 shipped-teaser sweep: the first run seeds the
// mirror and announces nothing; a key that leaves UPCOMING is announced to its voters once (event
// 18, the teaser's last audience applied, a deactivated voter skipped) and its votes cleared; a
// dropped key's votes are cleared silently; while feature ideas are off nothing is written but the
// votes still go; orphaned votes on a never-mirrored key are cleared; a re-run repeats nothing.
// Self-skips when DATABASE_URL is unset. It flips the feature-ideas switch and restores it to on.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test("shipped-teaser sweep: seed, announce once, drop silently, honour the switch", { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { runShippedTeaserSweep } = await import("./sweep.js");

  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const mkUser = async (label: string) =>
      (
        await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-sweep-${label}-${stamp}`,
          `dbtest-sweep-${label}-${stamp}@example.test`,
          `Dbtest sweep ${label}`,
        ])
      ).rows[0]!.id;
    const fan = await mkUser("fan");
    const leaver = await mkUser("leaver");
    const member = await mkUser("member");
    const admin = await mkUser("admin");
    const ext = `dbtest-sweep-pa-${stamp}`;
    const { rows: grp } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [ext]);
    await pool.query(`insert into role_mappings (group_external_id, role) values ($1, 'platform_admin')`, [ext]);
    await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [grp[0]!.id, admin]);
    await pool.query(`update platform_settings set value = 'true'::jsonb where key = 'feature_ideas_enabled'`);

    const teaser = (key: string, title: string, audience: "everyone" | "admins" | "platform_admin" = "everyone") => ({
      key: `${key}-${stamp}`,
      ids: ["GAP-999"],
      title,
      teaser: "t",
      audience,
    });
    const shipping = teaser("shipping", `Shipping ${stamp}`);
    const descoped = teaser("descoped", `Descoped ${stamp}`);
    const adminOnly = teaser("admin-only", `Admin only ${stamp}`, "platform_admin");
    const stays = teaser("stays", `Stays ${stamp}`);
    const vote = async (userId: string, key: string) => pool.query(`insert into feature_idea_votes (user_id, spec_key) values ($1, $2)`, [userId, key]);
    const announced = async (userId: string) =>
      (await pool.query<{ payload: { message: string } }>(`select payload from notifications where user_id = $1 and type = 'feature_available'`, [userId])).rows.map((r) => r.payload.message);
    const votesOn = async (key: string) => (await pool.query(`select 1 from feature_idea_votes where spec_key = $1`, [key])).rows.length;
    const live = [shipping, descoped, adminOnly, stays];

    // ── The first run seeds the mirror and announces nothing. ──
    const first = await runShippedTeaserSweep(pool, { entries: live, droppedKeys: [] });
    assert.ok(first.seeded >= 4);
    assert.equal(first.shipped, 0);
    for (const v of [fan, leaver, member]) await vote(v, shipping.key);
    await vote(fan, descoped.key);
    await vote(member, adminOnly.key);
    await vote(admin, adminOnly.key);
    await vote(fan, stays.key);
    await pool.query(`update users set active = false where id = $1`, [leaver]);

    // ── A release drops three teasers: one shipped, one descoped, one admin-only shipped. ──
    const second = await runShippedTeaserSweep(pool, { entries: [stays], droppedKeys: [descoped.key] });
    assert.equal(second.shipped, 2);
    assert.equal(second.dropped, 1);
    assert.deepEqual(await announced(fan), [`Shipping ${stamp} is now available. You upvoted it.`]);
    assert.deepEqual(await announced(leaver), [], "never a deactivated voter");
    assert.deepEqual(await announced(member), [`Shipping ${stamp} is now available. You upvoted it.`], "the admin-only teaser's audience excludes a member");
    assert.deepEqual(await announced(admin), [`Admin only ${stamp} is now available. You upvoted it.`]);
    for (const k of [shipping.key, descoped.key, adminOnly.key]) assert.equal(await votesOn(k), 0, `${k} cleared`);
    assert.equal(await votesOn(stays.key), 1, "a live teaser keeps its votes");
    assert.equal((await pool.query(`select 1 from coming_soon_teasers where key = $1`, [shipping.key])).rows.length, 0);

    // ── A re-run repeats nothing. ──
    const third = await runShippedTeaserSweep(pool, { entries: [stays], droppedKeys: [descoped.key] });
    assert.equal(third.shipped + third.dropped + third.notified, 0);
    assert.equal((await announced(fan)).length, 1, "nobody is told twice");

    // ── Off: nothing is written, the votes still go. Orphans on a never-mirrored key go too. ──
    await pool.query(`update platform_settings set value = 'false'::jsonb where key = 'feature_ideas_enabled'`);
    await vote(member, `orphan-${stamp}`);
    const offRun = await runShippedTeaserSweep(pool, { entries: [], droppedKeys: [] });
    assert.ok(offRun.shipped >= 1);
    assert.equal(offRun.notified, 0);
    assert.equal(await votesOn(stays.key), 0);
    assert.equal((await announced(fan)).length, 1, "no event 20 while off");
    assert.equal(await votesOn(`orphan-${stamp}`), 0, "an orphaned key's votes are cleared");
  } finally {
    await pool.query(`update platform_settings set value = 'true'::jsonb where key = 'feature_ideas_enabled'`).catch(() => {});
    await pool.end();
  }
});
