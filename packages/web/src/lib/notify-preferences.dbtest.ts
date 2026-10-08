// Live-DB integration test (gated) for the §12.1 per-event preferences: an opted-out recipient
// gets neither the inbox row nor the outbox row, exempt recipients always do, a dispatch without
// a mute ignores the toggles, and the profile store round-trips the switches. Self-skips when
// DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "notification preferences: row-level mute at insert, exemptions, profile round-trip",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { dispatchEvent } = await import("./notify");
    const { getOwnProfile, setNotificationPreferences } = await import("../app/api/profile/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-pref-${label}-${stamp}`, `dbtest-pref-${label}-${stamp}@example.test`, `Dbtest Pref ${label}`],
        );
        return rows[0]!.id;
      };
      const actor = await mkUser("actor");
      const keen = await mkUser("keen"); // keeps everything on
      const quiet = await mkUser("quiet"); // mutes comments
      const duty = await mkUser("duty"); // mutes comments but is exempt below
      const { rows: ch } = await pool.query<{ id: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'prefs', $3, $4, 'valid') returning id`,
        [globalId, `Prefs ${stamp}`, ia[0]!.id, actor],
      );
      const challengeId = ch[0]!.id;
      const resolveRoles = async () => buildRoleSet([], { globalNamespaceId: globalId });

      // Defaults are all on.
      const fresh = await getOwnProfile(pool, quiet);
      assert.deepEqual(fresh!.notificationPreferences, { followedComments: true, followedStatus: true, followedSolutions: true });

      await setNotificationPreferences(pool, quiet, { followedComments: false });
      await setNotificationPreferences(pool, duty, { followedComments: false, followedSolutions: false });
      assert.deepEqual((await getOwnProfile(pool, quiet))!.notificationPreferences, { followedComments: false, followedStatus: true, followedSolutions: true });
      assert.deepEqual((await getOwnProfile(pool, duty))!.notificationPreferences, { followedComments: false, followedStatus: true, followedSolutions: false });

      const rowsFor = async (table: "notifications" | "notification_outbox", message: string) =>
        (await pool.query<{ user_id: string }>(`select user_id from ${table} where payload->>'message' = $1`, [message])).rows.map((r) => r.user_id).sort();

      // A muted event: quiet is dropped from BOTH tables; duty is exempt; keen keeps it.
      const muted = `muted ${stamp}`;
      await dispatchEvent({ pool, actorId: actor, resolveRoles }, { parentType: "challenge", parentId: challengeId }, [keen, quiet, duty], "comment_posted", { message: muted, link: "/x" }, {
        preference: "followedComments",
        exempt: [duty],
      });
      assert.deepEqual(await rowsFor("notifications", muted), [keen, duty].sort());
      assert.deepEqual(await rowsFor("notification_outbox", muted), [keen, duty].sort(), "no outbox row either — no e-mail");

      // A different preference is untouched by the comments switch.
      const status = `status ${stamp}`;
      await dispatchEvent({ pool, actorId: actor, resolveRoles }, { parentType: "challenge", parentId: challengeId }, [keen, quiet, duty], "status_changed", { message: status, link: "/x" }, {
        preference: "followedStatus",
      });
      assert.deepEqual(await rowsFor("notifications", status), [keen, quiet, duty].sort());

      // No mute → toggles do not apply (the actionable events).
      const rejected = `rejected ${stamp}`;
      await dispatchEvent({ pool, actorId: actor, resolveRoles }, { parentType: "challenge", parentId: challengeId }, [quiet], "rejected", { message: rejected, link: "/x" });
      assert.deepEqual(await rowsFor("notifications", rejected), [quiet]);

      // Forward-only: switching back on does not replay what was missed.
      await setNotificationPreferences(pool, quiet, { followedComments: true });
      assert.deepEqual(await rowsFor("notifications", muted), [keen, duty].sort());
    } finally {
      await pool.end();
    }
  },
);
