// §14.10 explanation selection and the card summary label.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_SYNC_EXPLANATIONS,
  identitySyncState,
  identitySyncSummaryLabel,
  SCIM_REJECTION_ERROR_CODES,
  SCIM_REJECTION_HINTS,
  SCIM_REJECTION_LABELS,
  scimRejectionHint,
  scimRejectionReasonFromErrorCode,
  UNARRIVED_GROUP_HINT,
  type ScimRejectionReason,
} from "./identity-sync.js";

test("identitySyncState: nothing at all → nothing_synced", () => {
  assert.equal(identitySyncState({ users: 0, groups: 0 }), "nothing_synced");
});

test("identitySyncState: users but no groups → users_no_groups", () => {
  assert.equal(identitySyncState({ users: 1, groups: 0 }), "users_no_groups");
  assert.equal(identitySyncState({ users: 500, groups: 0 }), "users_no_groups");
});

test("identitySyncState: groups present → ok, with or without users", () => {
  assert.equal(identitySyncState({ users: 12, groups: 3 }), "ok");
  assert.equal(identitySyncState({ users: 0, groups: 2 }), "ok", "groups without users is not one of the fixed explanations");
});

test("explanations: exactly the two non-ok states carry copy, and it names the runbook steps", () => {
  assert.equal(IDENTITY_SYNC_EXPLANATIONS.ok, null);
  assert.match(IDENTITY_SYNC_EXPLANATIONS.nothing_synced ?? "", /\/scim\/v2/);
  assert.match(IDENTITY_SYNC_EXPLANATIONS.nothing_synced ?? "", /Provision on demand/);
  assert.match(IDENTITY_SYNC_EXPLANATIONS.users_no_groups ?? "", /Sync only assigned users and groups/);
  for (const copy of [...Object.values(IDENTITY_SYNC_EXPLANATIONS), UNARRIVED_GROUP_HINT]) {
    assert.ok(!copy?.includes("§"), "no spec reference on a user-facing surface");
  }
});

test("identitySyncSummaryLabel: counts, pluralised, or Not synced", () => {
  assert.equal(identitySyncSummaryLabel({ users: 0, groups: 0 }), "Not synced");
  assert.equal(identitySyncSummaryLabel({ users: 42, groups: 3 }), "42 users · 3 groups");
  assert.equal(identitySyncSummaryLabel({ users: 1, groups: 1 }), "1 user · 1 group");
  assert.equal(identitySyncSummaryLabel({ users: 7, groups: 0 }), "7 users · 0 groups");
});

// ── §14.10 last rejected SCIM request: reason and hint ───────────────────────────────────

test("scimRejectionReasonFromErrorCode: each worker code maps back; legacy and others → null", () => {
  for (const [reason, code] of Object.entries(SCIM_REJECTION_ERROR_CODES)) {
    assert.equal(scimRejectionReasonFromErrorCode(code), reason);
  }
  assert.equal(scimRejectionReasonFromErrorCode("scim_unauthorized"), null, "rows from before reason codes");
  assert.equal(scimRejectionReasonFromErrorCode("webhook_http_error"), null);
  assert.equal(scimRejectionReasonFromErrorCode(null), null);
  assert.equal(scimRejectionReasonFromErrorCode(undefined), null);
});

test("every reason has a label; forbidden alone has no hint", () => {
  for (const reason of Object.keys(SCIM_REJECTION_ERROR_CODES) as ScimRejectionReason[]) {
    assert.ok(SCIM_REJECTION_LABELS[reason], reason);
  }
  assert.equal(SCIM_REJECTION_HINTS.forbidden, null);
  assert.ok(SCIM_REJECTION_HINTS.token_mismatch);
});

test("scimRejectionHint: shown while the rejection is newer than the last accepted request", () => {
  const rejected = "2026-10-14T12:00:00.000Z";
  assert.equal(
    scimRejectionHint({ reason: "token_mismatch", lastRejectedAt: rejected, lastAcceptedAt: null }),
    SCIM_REJECTION_HINTS.token_mismatch,
    "nothing ever accepted",
  );
  assert.equal(
    scimRejectionHint({ reason: "no_token", lastRejectedAt: rejected, lastAcceptedAt: "2026-10-14T11:00:00.000Z" }),
    SCIM_REJECTION_HINTS.no_token,
    "accepted earlier, rejected since",
  );
  assert.equal(
    scimRejectionHint({ reason: "token_mismatch", lastRejectedAt: rejected, lastAcceptedAt: "2026-10-14T12:05:00.000Z" }),
    null,
    "an accepted request is newer — provisioning got through",
  );
  assert.equal(scimRejectionHint({ reason: null, lastRejectedAt: rejected, lastAcceptedAt: null }), null, "legacy row: no reason, no hint");
  assert.equal(scimRejectionHint({ reason: "forbidden", lastRejectedAt: rejected, lastAcceptedAt: null }), null);
  assert.equal(scimRejectionHint({ reason: "no_token", lastRejectedAt: null, lastAcceptedAt: null }), null);
});
