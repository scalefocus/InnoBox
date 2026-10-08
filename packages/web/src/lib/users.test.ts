// Hermetic unit tests for JIT provisioning (lib/users.ts): the pure claim-vs-row decision
// (insert / refresh-only-stubs / synced-never-overwritten / no-op on equal values) and the
// SQL + audit shape of the upsert paths — against capturing fakes, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  decideJitAction,
  devSlug,
  jitUpsertFromClaims,
  upsertDevUser,
  type JitClaims,
  type JitSnapshot,
} from "./users";

const claims: JitClaims = {
  oid: "00000000-0000-0000-0000-0000000000aa",
  userName: "ada.lovelace@example.com",
  email: "ada.lovelace@example.com",
  displayName: "Ada Lovelace",
};

const stub: JitSnapshot = {
  userName: claims.userName,
  email: claims.email,
  displayName: claims.displayName,
  active: true,
  scimSynced: false,
};

// ── decideJitAction (pure) ──────────────────────────────────────────────────────────────────

test("no stored row → insert", () => {
  assert.deepEqual(decideJitAction(null, claims), { action: "insert" });
});

test("stub row with drifted attributes → refresh with only the drifted columns", () => {
  const existing = { ...stub, displayName: "A. Lovelace", email: null };
  assert.deepEqual(decideJitAction(existing, claims), {
    action: "refresh",
    patch: { email: claims.email, display_name: claims.displayName },
  });
});

test("stub row equal to claims → none (no idle UPDATE per sign-in)", () => {
  assert.deepEqual(decideJitAction(stub, claims), { action: "none" });
});

test("scim_synced row → none, even when every attribute differs", () => {
  const synced: JitSnapshot = {
    userName: "old.upn@example.com",
    email: "old@example.com",
    displayName: "Old Name",
    active: true,
    scimSynced: true,
  };
  assert.deepEqual(decideJitAction(synced, claims), { action: "none" });
});

test("deactivated row → none (claims never touch a leaver's row)", () => {
  const inactive = { ...stub, active: false, displayName: "Former Name" };
  assert.deepEqual(decideJitAction(inactive, claims), { action: "none" });
});

// ── jitUpsertFromClaims (capturing fake) ────────────────────────────────────────────────────

interface Call {
  text: string;
  params: unknown[];
}

/** Scripted pg fake: responds to queries in call order. */
function scriptedDb(responses: { rows: unknown[] }[]) {
  const calls: Call[] = [];
  let i = 0;
  const db = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return { rows: responses[i++]?.rows ?? [], rowCount: 0 };
    },
  };
  return { db: db as unknown as Pool, calls };
}

const dbRow = {
  id: "11111111-0000-0000-0000-000000000001",
  external_id: claims.oid,
  user_name: claims.userName,
  email: claims.email,
  display_name: claims.displayName,
  active: true,
  scim_synced: false,
  email_notifications_enabled: true,
  quick_start_seen_at: null,
};

test("insert path: INSERT stub + audit user.jit_created with actor = the new user id", async () => {
  const { db, calls } = scriptedDb([
    { rows: [] }, // select by external_id — no row yet
    { rows: [dbRow] }, // insert … returning
    { rows: [] }, // audit insert
  ]);
  const user = await jitUpsertFromClaims(db, claims);
  assert.equal(user.id, dbRow.id);
  assert.equal(user.externalId, claims.oid);

  assert.equal(calls.length, 3);
  assert.match(calls[1]!.text, /insert into users/i);
  assert.match(calls[1]!.text, /scim_synced/); // stubs are explicitly not SCIM-owned
  assert.deepEqual(calls[1]!.params, [claims.oid, claims.userName, claims.email, claims.displayName, false]);

  assert.match(calls[2]!.text, /insert into audit_log/i);
  assert.equal(calls[2]!.params[0], dbRow.id); // actor = the user itself
  assert.equal(calls[2]!.params[1], "user.jit_created");
  assert.equal(calls[2]!.params[3], dbRow.id); // target id
});

test("insert path: skipQuickStart=true stamps quick_start_seen_at at creation (dev/e2e fixtures only)", async () => {
  const { db, calls } = scriptedDb([{ rows: [] }, { rows: [dbRow] }, { rows: [] }]);
  await jitUpsertFromClaims(db, claims, { skipQuickStart: true });
  assert.deepEqual(calls[1]!.params, [claims.oid, claims.userName, claims.email, claims.displayName, true]);
});

test("refresh path: UPDATEs only the drifted columns, stamps updated_at, no audit row", async () => {
  const stored = { ...dbRow, display_name: "A. Lovelace" };
  const { db, calls } = scriptedDb([
    { rows: [stored] }, // select by external_id
    { rows: [] }, // update
  ]);
  const user = await jitUpsertFromClaims(db, claims);
  assert.equal(user.displayName, claims.displayName); // returned row reflects the patch

  assert.equal(calls.length, 2, "no audit write on refresh");
  const update = calls[1]!;
  assert.match(update.text, /update users set display_name = \$1, updated_at = now\(\)/i);
  assert.doesNotMatch(update.text, /user_name|email =/i); // untouched columns stay out
  assert.deepEqual(update.params, [claims.displayName, stored.id]);
});

test("synced row: returns it untouched — a lone SELECT, zero writes", async () => {
  const synced = { ...dbRow, scim_synced: true, display_name: "SCIM Owned" };
  const { db, calls } = scriptedDb([{ rows: [synced] }]);
  const user = await jitUpsertFromClaims(db, claims);
  assert.equal(user.displayName, "SCIM Owned");
  assert.equal(calls.length, 1);
});

// ── dev bypass fixtures ─────────────────────────────────────────────────────────────────────

test("devSlug flattens display names into stable external ids", () => {
  assert.equal(devSlug("Ada Lovelace"), "ada-lovelace");
  assert.equal(devSlug("  Grace -- Hopper!  "), "grace-hopper");
  assert.equal(devSlug("!!!"), "user");
});

/** Routing pg fake for the multi-table dev flow. */
function routedDb(userRows: () => unknown[]) {
  const calls: Call[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      if (/select .+ from users where external_id/i.test(text)) return { rows: userRows(), rowCount: 0 };
      if (/insert into users/i.test(text)) return { rows: [dbRow], rowCount: 1 };
      if (/insert into groups/i.test(text)) return { rows: [{ id: "g-dev" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { db: db as unknown as Pool, calls };
}

test("upsertDevUser(admin): ensures dev group, platform_admin mapping, and membership in the DB", async () => {
  const { db, calls } = routedDb(() => []);
  const user = await upsertDevUser(db, { name: "Ada Lovelace", email: null, admin: true });
  assert.equal(user.id, dbRow.id);

  const insertUser = calls.find((c) => /insert into users/i.test(c.text));
  assert.ok(insertUser, "dev user is a real users row");
  assert.equal(insertUser.params[0], "dev-ada-lovelace"); // external_id = "dev-" + slug
  assert.equal(insertUser.params[1], "ada-lovelace@dev.local"); // no email → synthetic UPN

  const group = calls.find((c) => /insert into groups/i.test(c.text));
  assert.ok(group);
  assert.deepEqual(group.params, ["dev-platform-admins", "Dev Platform Admins"]);

  const mapping = calls.find((c) => /insert into role_mappings/i.test(c.text));
  assert.ok(mapping, "platform_admin resolves via role_mappings, never from the session");
  assert.match(mapping.text, /'platform_admin'/);
  assert.match(mapping.text, /where not exists/i); // NULL namespace_id defeats ON CONFLICT
  assert.deepEqual(mapping.params, ["dev-platform-admins"]);

  const membership = calls.find((c) => /insert into group_members/i.test(c.text));
  assert.ok(membership);
  assert.deepEqual(membership.params, ["g-dev", dbRow.id]);
});

test("upsertDevUser: user_name is slug-derived, never the email — so shared emails can't collide", async () => {
  // Regression: two dev personas sharing an email (e.g. "Dev" then "Krasi Admin", both
  // dev@innobox.innovate) must map to DIFFERENT external_ids AND different user_names, or the
  // second sign-in trips the lower(user_name) unique index that ON CONFLICT (external_id) misses.
  const { db, calls } = routedDb(() => []); // no existing row → forces the INSERT path
  await upsertDevUser(db, { name: "Krasi Admin", email: "dev@innobox.innovate", admin: false });

  const insertUser = calls.find((c) => /insert into users/i.test(c.text));
  assert.ok(insertUser, "dev user is a real users row");
  assert.equal(insertUser.params[0], "dev-krasi-admin"); // external_id = "dev-" + slug
  assert.equal(insertUser.params[1], "krasi-admin@dev.local"); // user_name tracks the slug, NOT the email
  assert.equal(insertUser.params[2], "dev@innobox.innovate"); // the email still lands in the email column
});

test("upsertDevUser: defaults to skipQuickStart=true (dev/e2e personas aren't interrupted by onboarding)", async () => {
  const { db, calls } = routedDb(() => []);
  await upsertDevUser(db, { name: "Ada Lovelace", email: null, admin: false });
  const insertUser = calls.find((c) => /insert into users/i.test(c.text));
  assert.equal(insertUser?.params[4], true);
});

test("upsertDevUser({ freshOnboarding: true }): leaves quick_start_seen_at unset, for the dedicated onboarding e2e spec", async () => {
  const { db, calls } = routedDb(() => []);
  await upsertDevUser(db, { name: "Ada Lovelace", email: null, admin: false, freshOnboarding: true });
  const insertUser = calls.find((c) => /insert into users/i.test(c.text));
  assert.equal(insertUser?.params[4], false);
});

test("upsertDevUser(non-admin): drops any dev-admin membership so the toggle round-trips", async () => {
  const { db, calls } = routedDb(() => [dbRow]);
  await upsertDevUser(db, { name: "Ada Lovelace", email: claims.email, admin: false });

  assert.ok(!calls.some((c) => /insert into (groups|role_mappings|group_members)/i.test(c.text)));
  const drop = calls.find((c) => /delete from group_members/i.test(c.text));
  assert.ok(drop);
  assert.deepEqual(drop.params, [dbRow.id, "dev-platform-admins"]);
});
