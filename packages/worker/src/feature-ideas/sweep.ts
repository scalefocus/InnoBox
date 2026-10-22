// The shipped-teaser sweep (INNOBOX_SPEC.md §38.9). Specified teasers leave UPCOMING in the commit
// that ships them; this sweep, run once each time a worker replica acquires leadership (after every
// deploy, and after a failover), notices, tells the voters, and clears the votes.
//
//   1. Upsert every UPCOMING entry's key, current title and audience into coming_soon_teasers — the
//      mirror that remembers a teaser after the release that drops it.
//   2. For each mirrored key no longer in UPCOMING, in ONE transaction: a key on
//      DROPPED_UPCOMING_KEYS has its votes deleted silently; any other key writes §12.1 event 20 to
//      its voters (only while feature ideas are on) and then deletes its votes; the mirror row goes.
//
// Idempotent: a crash before a commit leaves the key for the next run, and after the commit nothing
// remains to repeat, so no voter is told twice. The first run finds an empty mirror, seeds it and
// announces nothing. Never audited, like every scheduled sweep (§15).
import type { Pool } from "pg";
import {
  DROPPED_UPCOMING_KEYS,
  UPCOMING,
  deliverFeatureAvailable,
  getFeatureIdeasEnabled,
  planTeaserSweep,
  type MirroredTeaser,
  type UpcomingEntry,
} from "@innobox/shared";

export interface TeaserSweepSummary {
  seeded: number;
  shipped: number;
  dropped: number;
  notified: number;
}

export async function runShippedTeaserSweep(
  pool: Pool,
  opts: { entries?: readonly UpcomingEntry[]; droppedKeys?: readonly string[]; bootstrapAdminGroup?: string } = {},
): Promise<TeaserSweepSummary> {
  const entries = opts.entries ?? UPCOMING;
  const { rows: mirror } = await pool.query<MirroredTeaser>(`select key, title, audience from coming_soon_teasers order by key`);
  const plan = planTeaserSweep(mirror, entries, opts.droppedKeys ?? DROPPED_UPCOMING_KEYS);
  const summary: TeaserSweepSummary = { seeded: 0, shipped: 0, dropped: 0, notified: 0 };

  for (const teaser of plan.upserts) {
    const { rows } = await pool.query<{ inserted: boolean }>(
      `insert into coming_soon_teasers (key, title, audience) values ($1, $2, $3)
       on conflict (key) do update set title = excluded.title, audience = excluded.audience
       returning (xmax = 0) as inserted`,
      [teaser.key, teaser.title, teaser.audience],
    );
    if (rows[0]?.inserted) summary.seeded += 1;
  }

  const enabled = await getFeatureIdeasEnabled(pool);
  for (const [teaser, shipped] of [...plan.shipped.map((t) => [t, true] as const), ...plan.dropped.map((t) => [t, false] as const)]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The mirror row is the claim: whoever deletes it announces. A concurrent run finds nothing.
      const { rowCount } = await client.query(`delete from coming_soon_teasers where key = $1`, [teaser.key]);
      if ((rowCount ?? 0) > 0) {
        const { rows: votes } = await client.query<{ user_id: string }>(
          `delete from feature_idea_votes where spec_key = $1 returning user_id`,
          [teaser.key],
        );
        if (shipped && enabled) {
          summary.notified += await deliverFeatureAvailable(client, {
            title: teaser.title,
            proposerId: null,
            voterIds: votes.map((v) => v.user_id),
            // The audience it last had, from the mirror: only voters it still applies to hear.
            audience: teaser.audience,
            actorId: null,
            bootstrapAdminGroup: opts.bootstrapAdminGroup,
          });
        }
        if (shipped) summary.shipped += 1;
        else summary.dropped += 1;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // A teaser added and removed again between two leadership changes was never mirrored, so the
  // steps above cannot see it: its votes would be orphaned. Nothing can be announced without its
  // title, so they are cleared silently.
  await pool.query(`delete from feature_idea_votes where spec_key is not null and not (spec_key = any($1::text[]))`, [entries.map((e) => e.key)]);
  return summary;
}
