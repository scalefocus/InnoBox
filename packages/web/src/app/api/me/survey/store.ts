// Data layer for the feedback survey (INNOBOX_SPEC.md §13.10): first uses, the random roll and
// its guarded offer, the 90-day fallback, close, submit, the opt-out, and the platform switch.
// The rules themselves are pure and live in @innobox/shared/survey; this file applies them and
// re-checks eligibility inside the guarded UPDATE, so two tabs or two requests can never both win.
//
// Privacy (the reason for most of the shape here): NOTHING in this file writes an audit row —
// opening, closing, first uses and submissions are deliberately unaudited — and a response is
// stored with no reference to its author. The only audited write is the platform switch.
// Relative imports (not `@/…`) so the gated *.dbtest.ts suite can load this under plain node.
import { randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  SURVEY_FALLBACK_DAYS,
  SURVEY_FLOOR_DAYS,
  SURVEY_GRACE_DAYS,
  composeOffer,
  isOfferLive,
  isRandomSurveyEligible,
  isSurveyFallbackDue,
  isSurveyFeature,
  offerPayload,
  parseStoredOffer,
  rollSurvey,
  surveySegment,
  validateSurveySubmission,
  type StoredSurveyOffer,
  type SurveyFeature,
  type SurveyOfferPayload,
  type SurveyTrigger,
  type SurveyUserState,
} from "@innobox/shared/survey";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";

type Db = Pool | PoolClient;

/** [0, 1) from the CSPRNG — the roll is server-side so the client can neither steer nor re-roll it. */
export const cryptoRng = (): number => randomInt(0, 1_000_000) / 1_000_000;

export interface RollOptions {
  rng: () => number;
  /** The dev/e2e seam (lib/survey-dev.ts): the roll always wins. Never true in production. */
  forceWin?: boolean;
  now?: Date;
}

// ── The platform switch (§14.11) ─────────────────────────────────────────────────────────

const SWITCH_KEY = "survey_enabled";

export async function getSurveyEnabled(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [SWITCH_KEY]);
  return rows[0]?.value !== false; // default on
}

/** Turning the switch off ends every open offer at once (random and on-demand alike); turning it
 *  on again backfills nothing. Audited as `settings.survey_enabled_changed`. */
export async function setSurveyEnabled(pool: Pool, enabled: boolean, actorUserId: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into platform_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [SWITCH_KEY, JSON.stringify(enabled), actorUserId],
    );
    if (!enabled) await client.query(`update users set survey_offer = null where survey_offer is not null`);
    await appendAudit(client, {
      actorUserId,
      action: "settings.survey_enabled_changed",
      targetType: "platform_settings",
      targetId: SWITCH_KEY,
      after: { enabled },
    });
  });
}

// ── The user's survey state ───────────────────────────────────────────────────────────────

interface StateRow {
  active: boolean;
  scrubbed_at: Date | null;
  quick_start_seen_at: Date | null;
  surveys_enabled: boolean;
  survey_last_shown_at: Date | null;
  survey_offer: unknown;
  survey_self_shown_at: Date | null;
}

const STATE_COLUMNS = `active, scrubbed_at, quick_start_seen_at, surveys_enabled, survey_last_shown_at, survey_offer, survey_self_shown_at`;

async function loadState(db: Db, userId: string, forUpdate = false): Promise<StateRow | null> {
  const { rows } = await db.query<StateRow>(`select ${STATE_COLUMNS} from users where id = $1${forUpdate ? " for update" : ""}`, [userId]);
  return rows[0] ?? null;
}

interface LiveOffer {
  offer: StoredSurveyOffer;
  shownAt: Date;
}

/** The stored offer if it is still open, else null. */
function liveOffer(row: StateRow, now: Date): LiveOffer | null {
  const offer = parseStoredOffer(row.survey_offer);
  if (!offer) return null;
  const shownAt = offer.trigger === "self" ? row.survey_self_shown_at : row.survey_last_shown_at;
  return isOfferLive(offer, shownAt, row.surveys_enabled, now) && shownAt ? { offer, shownAt } : null;
}

/** Drops a stored offer that has ended (expired, older SURVEY_VERSION, or a random offer after the
 *  opt-out). Guarded on the exact value read, so it never clears an offer opened meanwhile. */
async function clearIfDead(db: Db, userId: string, row: StateRow, now: Date): Promise<void> {
  if (row.survey_offer === null || liveOffer(row, now)) return;
  await db.query(`update users set survey_offer = null where id = $1 and survey_offer = $2::jsonb`, [userId, JSON.stringify(row.survey_offer)]);
  row.survey_offer = null;
}

function userState(row: StateRow, now: Date): SurveyUserState {
  return {
    active: row.active,
    scrubbed: row.scrubbed_at !== null,
    quickStartSeenAt: row.quick_start_seen_at,
    surveysEnabled: row.surveys_enabled,
    lastShownAt: row.survey_last_shown_at,
    openOffer: liveOffer(row, now)?.offer ?? null,
  };
}

/** The open offer for the `me` resource — null whenever the switch is off. An ended offer is
 *  cleared on the way (an older-version offer is dropped on read). */
export async function readOpenSurvey(db: Db, userId: string, now: Date = new Date()): Promise<SurveyOfferPayload | null> {
  if (!(await getSurveyEnabled(db))) return null;
  const row = await loadState(db, userId);
  if (!row) return null;
  const live = liveOffer(row, now);
  if (!live) {
    await clearIfDead(db, userId, row, now);
    return null;
  }
  return offerPayload(live.offer, live.shownAt);
}

// ── The funnel (aggregate only) ───────────────────────────────────────────────────────────

const DAILY_COLUMNS = ["shown", "closed", "submitted", "submitted_from_menu", "shown_self", "submitted_self"] as const;
type DailyColumn = (typeof DAILY_COLUMNS)[number];

/** Bumps today's (UTC) counters. Column names come from the fixed list above, never from input. */
async function bumpDaily(db: Db, columns: readonly DailyColumn[]): Promise<void> {
  if (columns.length === 0) return;
  const cols = columns.filter((c) => (DAILY_COLUMNS as readonly string[]).includes(c));
  await db.query(
    `insert into survey_daily (day, ${cols.join(", ")})
     values ((now() at time zone 'utc')::date, ${cols.map(() => "1").join(", ")})
     on conflict (day) do update set ${cols.map((c) => `${c} = survey_daily.${c} + 1`).join(", ")}`,
  );
}

// ── Opening a random offer ────────────────────────────────────────────────────────────────

/**
 * The one guarded UPDATE that opens a random offer: the eligibility predicate re-checked in its
 * WHERE (switch aside — read just before), plus "no stored offer" (an ended one was cleared first,
 * and an open random offer implies the floor anyway). Of two concurrent winners exactly one gets a
 * row back. Stamps `survey_last_shown_at` — the 30-day floor runs from it, whatever happens next.
 */
async function openRandomOffer(
  db: Db,
  userId: string,
  trigger: Exclude<SurveyTrigger, "self">,
  feature: SurveyFeature | null,
  opts: RollOptions & { fallback?: boolean },
): Promise<SurveyOfferPayload | null> {
  const offer = composeOffer(trigger, feature, opts.rng);
  const { rows } = await db.query<{ survey_last_shown_at: Date }>(
    `update users
        set survey_last_shown_at = now(), survey_offer = $2::jsonb
      where id = $1
        and active and scrubbed_at is null
        and surveys_enabled
        and quick_start_seen_at is not null
        and quick_start_seen_at <= now() - make_interval(days => $3)
        and (survey_last_shown_at is null or survey_last_shown_at <= now() - make_interval(days => $4))
        and survey_offer is null
        and (not $5 or coalesce(survey_last_shown_at, quick_start_seen_at) <= now() - make_interval(days => $6))
      returning survey_last_shown_at`,
    [userId, JSON.stringify(offer), SURVEY_GRACE_DAYS, SURVEY_FLOOR_DAYS, Boolean(opts.fallback), SURVEY_FALLBACK_DAYS],
  );
  const shownAt = rows[0]?.survey_last_shown_at;
  if (!shownAt) return null;
  await bumpDaily(db, ["shown"]);
  return offerPayload(offer, shownAt);
}

/** Eligible right now (switch, user state, `canShow`), with any ended offer cleared first. */
async function eligibleRow(db: Db, userId: string, canShow: boolean, now: Date): Promise<StateRow | null> {
  if (!canShow) return null;
  const switchOn = await getSurveyEnabled(db);
  if (!switchOn) return null;
  const row = await loadState(db, userId);
  if (!row) return null;
  await clearIfDead(db, userId, row, now);
  return isRandomSurveyEligible(userState(row, now), { switchOn, canShow }, now) ? row : null;
}

/**
 * `POST /api/me/features/used`: records the first use, then — a FRESH insert only — rolls and,
 * on a win, opens the offer. A repeat use never triggers; a first use made while ineligible (or
 * with `canShow` false, or that loses the roll) is recorded and consumed for good.
 */
export async function recordFeatureUse(
  pool: Pool,
  userId: string,
  feature: SurveyFeature,
  canShow: boolean,
  opts: RollOptions,
): Promise<{ firstUse: boolean; survey: SurveyOfferPayload | null }> {
  const now = opts.now ?? new Date();
  const { rowCount } = await pool.query(
    `insert into user_feature_uses (user_id, feature) values ($1, $2) on conflict (user_id, feature) do nothing`,
    [userId, feature],
  );
  if (!rowCount) return { firstUse: false, survey: null };
  const row = await eligibleRow(pool, userId, canShow, now);
  if (!row) return { firstUse: true, survey: null };
  if (!opts.forceWin && !rollSurvey(opts.rng)) return { firstUse: true, survey: null };
  return { firstUse: true, survey: await openRandomOffer(pool, userId, "feature", feature, opts) };
}

/**
 * `POST /api/me/survey/check`: the long-time-user fallback, once per full page load. Due 90 days
 * after the last survey (or Quick start, never shown); rolls like a first use. Its feature
 * questions cover one random feature the user has already used — none recorded → general only.
 */
export async function checkSurveyFallback(
  pool: Pool,
  userId: string,
  canShow: boolean,
  opts: RollOptions,
): Promise<{ survey: SurveyOfferPayload | null }> {
  const now = opts.now ?? new Date();
  const row = await eligibleRow(pool, userId, canShow, now);
  if (!row) return { survey: null };
  if (!isSurveyFallbackDue({ lastShownAt: row.survey_last_shown_at, quickStartSeenAt: row.quick_start_seen_at }, now)) return { survey: null };
  if (!opts.forceWin && !rollSurvey(opts.rng)) return { survey: null };

  const { rows } = await pool.query<{ feature: string }>(`select feature from user_feature_uses where user_id = $1 order by feature`, [userId]);
  const used = rows.map((r) => r.feature).filter(isSurveyFeature);
  const feature = used.length > 0 ? used[Math.min(used.length - 1, Math.floor(opts.rng() * used.length))]! : null;
  return { survey: await openRandomOffer(pool, userId, "visit", feature, { ...opts, fallback: true }) };
}

// ── Close ─────────────────────────────────────────────────────────────────────────────────

/** "Not now": the offer stays open (Take the survey). The FIRST close of a random offer flips its
 *  `closed` flag and counts once in the funnel; later closes and `self` closes count nothing. */
export async function closeSurvey(pool: Pool, userId: string, now: Date = new Date()): Promise<"ok" | "no_open_survey"> {
  if (!(await getSurveyEnabled(pool))) return "no_open_survey";
  const row = await loadState(pool, userId);
  if (!row) return "no_open_survey";
  const live = liveOffer(row, now);
  if (!live) {
    await clearIfDead(pool, userId, row, now);
    return "no_open_survey";
  }
  if (live.offer.trigger === "self" || live.offer.closed) return "ok";
  const { rowCount } = await pool.query(
    `update users set survey_offer = jsonb_set(survey_offer, '{closed}', 'true'::jsonb)
      where id = $1 and survey_offer = $2::jsonb`,
    [userId, JSON.stringify(row.survey_offer)],
  );
  if (rowCount) await bumpDaily(pool, ["closed"]);
  return "ok";
}

// ── Submit ────────────────────────────────────────────────────────────────────────────────

export type SubmitSurveyResult = { status: "ok" } | { status: "no_open_survey" } | { status: "invalid"; error: string };

/**
 * `POST /api/me/survey/responses`, in ONE transaction (§13.10): re-read the open offer (409
 * without one), validate against it (422), insert the response — NO user column, the UTC date
 * only — and its answered questions, clear the offer, bump the funnel. The segment is computed
 * here from the SCIM-resolved roles (invariant 1).
 */
export async function submitSurvey(
  pool: Pool,
  user: { id: string; roles: { isPlatformAdmin: boolean; grants: readonly { role: string }[] } },
  body: unknown,
  now: Date = new Date(),
): Promise<SubmitSurveyResult> {
  return inTransaction(pool, async (client) => {
    if (!(await getSurveyEnabled(client))) return { status: "no_open_survey" };
    const row = await loadState(client, user.id, true);
    if (!row) return { status: "no_open_survey" };
    const live = liveOffer(row, now);
    if (!live) {
      await clearIfDead(client, user.id, row, now);
      return { status: "no_open_survey" };
    }
    const parsed = validateSurveySubmission(live.offer, body);
    if (!parsed.ok) return { status: "invalid", error: parsed.error };
    const { answers, freeText, via, feature } = parsed.value;

    const { rows } = await client.query<{ id: string }>(
      `insert into survey_responses (answered_on, survey_version, trigger, feature, segment, via, free_text)
       values ((now() at time zone 'utc')::date, $1, $2, $3, $4, $5, $6)
       returning id`,
      [live.offer.surveyVersion, live.offer.trigger, feature, surveySegment(user.roles), via, freeText],
    );
    const responseId = rows[0]!.id;
    if (answers.length > 0) {
      const params: unknown[] = [responseId];
      const values = answers.map((a) => {
        params.push(a.key, a.stars);
        return `($1, $${params.length - 1}, $${params.length})`;
      });
      await client.query(`insert into survey_answers (response_id, question_key, stars) values ${values.join(", ")}`, params);
    }
    await client.query(`update users set survey_offer = null where id = $1`, [user.id]);
    if (live.offer.trigger === "self") await bumpDaily(client, ["submitted_self"]);
    else await bumpDaily(client, via === "menu" ? ["submitted", "submitted_from_menu"] : ["submitted"]);
    return { status: "ok" };
  });
}

// ── The opt-out (profile, §13.10) ────────────────────────────────────────────────────────

/** Governs RANDOM prompts only: switching off clears an open random offer at once and keeps an
 *  on-demand one; switching back on does not reset `survey_last_shown_at`. Not audited, like
 *  every profile preference. */
export async function setSurveysEnabled(pool: Pool, userId: string, enabled: boolean): Promise<void> {
  await pool.query(
    `update users
        set surveys_enabled = $2,
            survey_offer = case
              when not $2 and survey_offer is not null and survey_offer ->> 'trigger' <> 'self' then null
              else survey_offer
            end,
            updated_at = now()
      where id = $1`,
    [userId, enabled],
  );
}
