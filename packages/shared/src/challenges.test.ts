import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoleSet } from "./rbac.js";
import {
  CLIENT_NAME_MAX,
  TRASH_RETENTION_DAYS,
  blocksAcceptedInternally,
  canAuthorEditChallenge,
  canAuthorEditSolution,
  canAuthorResubmit,
  canAuthorWithdrawChallenge,
  canAuthorWithdrawSolution,
  canSeeChallenge,
  canSeeSolution,
  challengeEnforcedTargets,
  daysInTrash,
  decideTransition,
  isChallengeEnforcedTransition,
  isChallengeStatus,
  isSolutionEnforcedTransition,
  isTrashPurgeDue,
  isSolutionStatus,
  maskAuthor,
  notificationLinkScope,
  parentStatusAfterSolutionDelete,
  siblingsToAutoClose,
  solutionEnforcedTargets,
  solutionRestoreBlocked,
  trashPurgesOn,
  isRestrictedVisibility,
  validateChallengeFields,
  validateDeleteReason,
  validateSolutionFields,
  validateTrashReason,
} from "./challenges.js";

const GLOBAL = "00000000-0000-0000-0000-000000000001";
const NS_A = "aaaaaaaa-0000-0000-0000-000000000001";
const NS_B = "bbbbbbbb-0000-0000-0000-000000000002";
const AUTHOR = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
const ASSIGNEE = "33333333-0000-0000-0000-000000000003";
const CH = "cccccccc-0000-0000-0000-000000000001";

function viewer(
  userId: string,
  grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[] = [],
  accessListChallengeIds: string[] = [],
) {
  return { userId, roles: buildRoleSet(grants, { globalNamespaceId: GLOBAL, accessListChallengeIds }) };
}

// ── status vocab ─────────────────────────────────────────────────────────────────────────

test("isChallengeStatus / isSolutionStatus accept only their own vocab", () => {
  assert.equal(isChallengeStatus("valid"), true);
  assert.equal(isChallengeStatus("proposed"), false); // solution-only
  assert.equal(isSolutionStatus("proposed"), true);
  assert.equal(isSolutionStatus("awaiting_triage"), false); // challenge-only
});

// ── masking ──────────────────────────────────────────────────────────────────────────────

test("maskAuthor: anonymous item shows Anonymous and NULL userId (anonymity-safe, §9)", () => {
  const masked = maskAuthor({ isAnonymous: true, authorId: "user-1", authorDisplayName: "Jane Doe" });
  // The real author id must never leak for an anonymous item — it is the avatar/photo key (§13.6).
  assert.deepEqual(masked, { userId: null, displayName: "Anonymous", anonymous: true });
});

test("maskAuthor: non-anonymous item shows the real name and userId", () => {
  const masked = maskAuthor({ isAnonymous: false, authorId: "user-1", authorDisplayName: "Jane Doe" });
  assert.deepEqual(masked, { userId: "user-1", displayName: "Jane Doe", anonymous: false, active: true, scrubbed: false });
});

test("maskAuthor: a deactivated non-anonymous author carries active=false (§13.6 greyed bubble)", () => {
  const masked = maskAuthor({ isAnonymous: false, authorId: "user-1", authorDisplayName: "Jane Doe", authorActive: false });
  assert.deepEqual(masked, { userId: "user-1", displayName: "Jane Doe", anonymous: false, active: false, scrubbed: false });
});

test("maskAuthor: an anonymous author's account state never leaks (no active field, identical shapes)", () => {
  const live = maskAuthor({ isAnonymous: true, authorId: "user-1", authorDisplayName: "Jane Doe", authorActive: true });
  const gone = maskAuthor({ isAnonymous: true, authorId: "user-2", authorDisplayName: "Deleted User", authorActive: false, authorScrubbed: true });
  assert.deepEqual(live, gone);
  assert.equal("active" in live, false);
  assert.equal("scrubbed" in live, false);
});

test("maskAuthor: a scrubbed non-anonymous author carries scrubbed=true (§13.6 'Deleted User' bubble)", () => {
  const masked = maskAuthor({ isAnonymous: false, authorId: "user-1", authorDisplayName: "Deleted User", authorActive: false, authorScrubbed: true });
  assert.deepEqual(masked, { userId: "user-1", displayName: "Deleted User", anonymous: false, active: false, scrubbed: true });
});

// ── challenge visibility (§4.3) ──────────────────────────────────────────────────────────

test("canSeeChallenge: org-visible, non-triage challenge is visible to any authenticated user", () => {
  const v = viewer(OTHER);
  assert.equal(
    canSeeChallenge(v, { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "org", status: "valid", authorId: AUTHOR, trashed: false }),
    true,
  );
});

test("canSeeChallenge: namespace-visible challenge hidden from non-members", () => {
  const outsider = viewer(OTHER);
  assert.equal(
    canSeeChallenge(outsider, { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "namespace", status: "valid", authorId: AUTHOR, trashed: false }),
    false,
  );
  const member = viewer(OTHER, [{ role: "member", namespaceId: NS_A }]);
  assert.equal(
    canSeeChallenge(member, { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "namespace", status: "valid", authorId: AUTHOR, trashed: false }),
    true,
  );
});

test("canSeeChallenge: awaiting_triage hidden from everyone except author and namespace/platform admins", () => {
  const outsider = viewer(OTHER);
  const challenge = { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "org" as const, status: "awaiting_triage" as const, authorId: AUTHOR, trashed: false };
  assert.equal(canSeeChallenge(outsider, challenge), false);

  const author = viewer(AUTHOR);
  assert.equal(canSeeChallenge(author, challenge), true);

  const nsAdmin = viewer(OTHER, [{ role: "namespace_admin", namespaceId: NS_A }]);
  assert.equal(canSeeChallenge(nsAdmin, challenge), true);

  const platformAdmin = viewer(OTHER, [{ role: "platform_admin", namespaceId: null }]);
  assert.equal(canSeeChallenge(platformAdmin, challenge), true);

  // Committee is explicitly excluded from awaiting_triage visibility (§4.3).
  const committee = viewer(OTHER, [{ role: "committee", namespaceId: NS_A }]);
  assert.equal(canSeeChallenge(committee, challenge), false);
});

test("canSeeChallenge: withdrawn follows the same rule as awaiting_triage", () => {
  const challenge = { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "org" as const, status: "withdrawn" as const, authorId: AUTHOR, trashed: false };
  assert.equal(canSeeChallenge(viewer(OTHER), challenge), false);
  assert.equal(canSeeChallenge(viewer(AUTHOR), challenge), true);
});

// ── §4.3 `people` visibility ─────────────────────────────────────────────────────────────

const people = (status: "valid" | "awaiting_triage" | "withdrawn" = "valid", assigneeId: string | null = null) => ({
  id: CH,
  namespaceId: NS_A,
  assigneeId,
  visibility: "people" as const,
  status,
  authorId: AUTHOR,
  trashed: false,
});

test("canSeeChallenge people: the access list, the namespace's admins and committee, the assignee and platform admins", () => {
  assert.equal(canSeeChallenge(viewer(OTHER, [], [CH]), people()), true, "listed");
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "namespace_admin", namespaceId: NS_A }]), people()), true, "namespace admin");
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "committee", namespaceId: NS_A }]), people()), true, "committee");
  assert.equal(canSeeChallenge(viewer(ASSIGNEE), people("valid", ASSIGNEE)), true, "assignee");
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "platform_admin", namespaceId: null }]), people()), true, "platform admin");
});

test("canSeeChallenge people: namespace membership alone grants nothing, nor does another challenge's list", () => {
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "member", namespaceId: NS_A }]), people()), false, "member");
  assert.equal(canSeeChallenge(viewer(OTHER), people()), false, "outsider");
  assert.equal(canSeeChallenge(viewer(OTHER, [], ["dddddddd-0000-0000-0000-000000000001"]), people()), false, "listed elsewhere");
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "committee", namespaceId: NS_B }]), people()), false, "committee elsewhere");
  // The author of a people challenge is not on its list unless an admin put them there.
  assert.equal(canSeeChallenge(viewer(AUTHOR), people()), false, "author past triage");
});

test("canSeeChallenge people: the state rule applies on top — listed people see nothing in triage or withdrawn", () => {
  for (const status of ["awaiting_triage", "withdrawn"] as const) {
    assert.equal(canSeeChallenge(viewer(OTHER, [], [CH]), people(status)), false, `listed, ${status}`);
    assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "committee", namespaceId: NS_A }]), people(status)), false, `committee, ${status}`);
    assert.equal(canSeeChallenge(viewer(AUTHOR), people(status)), true, `author, ${status}`);
    assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "namespace_admin", namespaceId: NS_A }]), people(status)), true, `admin, ${status}`);
  }
});

test("canSeeChallenge people: an agent's org-only view hides it, even from someone on the list", () => {
  assert.equal(canSeeChallenge({ ...viewer(OTHER, [], [CH]), orgVisibleOnly: true }, people()), false);
  assert.equal(canSeeChallenge({ ...viewer(OTHER, [], [CH]) }, people()), true);
});

test("isRestrictedVisibility: everything but org", () => {
  assert.equal(isRestrictedVisibility("org"), false);
  assert.equal(isRestrictedVisibility("namespace"), true);
  assert.equal(isRestrictedVisibility("people"), true);
});

test("canSeeChallenge: namespace admin of a DIFFERENT namespace cannot see another namespace's awaiting_triage item", () => {
  const otherNsAdmin = viewer(OTHER, [{ role: "namespace_admin", namespaceId: NS_B }]);
  const challenge = { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "org" as const, status: "awaiting_triage" as const, authorId: AUTHOR, trashed: false };
  assert.equal(canSeeChallenge(otherNsAdmin, challenge), false);
});

// ── solution visibility (§4.3) ───────────────────────────────────────────────────────────

test("canSeeSolution: non-proposed solution is visible to anyone who can see the challenge", () => {
  const outsider = viewer(OTHER);
  const challenge = { namespaceId: NS_A, assigneeId: null };
  assert.equal(canSeeSolution(outsider, challenge, { status: "valid", authorId: AUTHOR, trashed: false }), true);
});

test("canSeeSolution: proposed solution hidden from a random viewer", () => {
  const outsider = viewer(OTHER);
  const challenge = { namespaceId: NS_A, assigneeId: null };
  assert.equal(canSeeSolution(outsider, challenge, { status: "proposed", authorId: AUTHOR, trashed: false }), false);
});

test("canSeeSolution: proposed solution visible to its own author", () => {
  const author = viewer(AUTHOR);
  const challenge = { namespaceId: NS_A, assigneeId: null };
  assert.equal(canSeeSolution(author, challenge, { status: "proposed", authorId: AUTHOR, trashed: false }), true);
});

test("canSeeSolution: proposed solution visible to the challenge's assignee", () => {
  const assignee = viewer(ASSIGNEE);
  const challenge = { namespaceId: NS_A, assigneeId: ASSIGNEE };
  assert.equal(canSeeSolution(assignee, challenge, { status: "proposed", authorId: AUTHOR, trashed: false }), true);
});

test("canSeeSolution: proposed solution visible to namespace committee and admins", () => {
  const challenge = { namespaceId: NS_A, assigneeId: null };
  const committee = viewer(OTHER, [{ role: "committee", namespaceId: NS_A }]);
  assert.equal(canSeeSolution(committee, challenge, { status: "proposed", authorId: AUTHOR, trashed: false }), true);
  const nsAdmin = viewer(OTHER, [{ role: "namespace_admin", namespaceId: NS_A }]);
  assert.equal(canSeeSolution(nsAdmin, challenge, { status: "proposed", authorId: AUTHOR, trashed: false }), true);
});

// ── §8.3 single-winner gate & auto-close ─────────────────────────────────────────────────

test("blocksAcceptedInternally: false when no sibling has advanced", () => {
  assert.equal(blocksAcceptedInternally(["proposed", "in_review", "rejected"]), false);
});

test("blocksAcceptedInternally: true when a sibling is at or past accepted_internally", () => {
  assert.equal(blocksAcceptedInternally(["proposed", "accepted_internally"]), true);
  assert.equal(blocksAcceptedInternally(["implemented"]), true);
  assert.equal(blocksAcceptedInternally(["waiting_for_resources"]), true);
});

test("siblingsToAutoClose: closes only non-terminal siblings, excludes the implemented one", () => {
  const solutions = [
    { id: "a", status: "implemented" as const },
    { id: "b", status: "in_review" as const },
    { id: "c", status: "rejected" as const },
    { id: "d", status: "proposed" as const },
  ];
  const closed = siblingsToAutoClose(solutions, "a");
  assert.deepEqual(new Set(closed), new Set(["b", "d"]));
});

// ── §7.2/§8.2 enforced state machine (committee & assignee) ──────────────────────────────

test("challengeEnforcedTargets: matches the §7.2 graph, excluding admin-only arrows", () => {
  // Triage (leaving awaiting_triage) is admin-only, so committee/assignee get nothing here.
  assert.deepEqual(challengeEnforcedTargets("awaiting_triage"), []);
  assert.deepEqual(new Set(challengeEnforcedTargets("in_review")), new Set(["valid", "needs_improvement", "meeting_scheduled", "rejected"]));
  assert.deepEqual(new Set(challengeEnforcedTargets("meeting_scheduled")), new Set(["in_review", "valid", "needs_improvement", "rejected"]));
  assert.deepEqual(challengeEnforcedTargets("needs_improvement"), ["in_review"]);
  // valid → solved is automatic/admin-override only; terminals have no enforced exits.
  assert.deepEqual(challengeEnforcedTargets("valid"), []);
  assert.deepEqual(challengeEnforcedTargets("solved"), []);
  assert.deepEqual(challengeEnforcedTargets("rejected"), []);
  assert.deepEqual(challengeEnforcedTargets("withdrawn"), []);
});

test("solutionEnforcedTargets: matches the §8.2 graph (no admin-only triage step)", () => {
  assert.deepEqual(new Set(solutionEnforcedTargets("proposed")), new Set(["in_review", "rejected"]));
  assert.deepEqual(new Set(solutionEnforcedTargets("in_review")), new Set(["valid", "needs_improvement", "rejected"]));
  assert.deepEqual(solutionEnforcedTargets("needs_improvement"), ["in_review"]);
  assert.deepEqual(solutionEnforcedTargets("valid"), ["accepted_internally"]);
  assert.deepEqual(new Set(solutionEnforcedTargets("accepted_internally")), new Set(["waiting_for_resources", "rejected"]));
  assert.deepEqual(new Set(solutionEnforcedTargets("in_implementation")), new Set(["external_acceptance", "implemented", "rejected"]));
  assert.deepEqual(solutionEnforcedTargets("implemented"), []);
  assert.deepEqual(solutionEnforcedTargets("not_selected"), []);
  assert.deepEqual(solutionEnforcedTargets("withdrawn"), []);
});

test("isChallengeEnforcedTransition / isSolutionEnforcedTransition guard the arrows", () => {
  assert.equal(isChallengeEnforcedTransition("in_review", "valid"), true);
  assert.equal(isChallengeEnforcedTransition("awaiting_triage", "in_review"), false); // admin-only triage
  assert.equal(isChallengeEnforcedTransition("valid", "solved"), false); // automatic/admin-only
  assert.equal(isSolutionEnforcedTransition("proposed", "in_review"), true);
  assert.equal(isSolutionEnforcedTransition("in_review", "implemented"), false); // not a legal arrow
});

test("decideTransition: a non-admin non-enforcer is forbidden outright", () => {
  const d = decideTransition({ from: "in_review", to: "valid", isAdmin: false, isEnforcer: false, isLegalArrow: true });
  assert.deepEqual(d, { allowed: false, reason: "forbidden" });
});

test("decideTransition: admin free-sets any target as an override (graph ignored)", () => {
  const d = decideTransition({ from: "awaiting_triage", to: "solved", isAdmin: true, isEnforcer: false, isLegalArrow: false });
  assert.deepEqual(d, { allowed: true, mode: "override", changed: true });
});

test("decideTransition: enforcer on a legal arrow is an enforced transition", () => {
  const d = decideTransition({ from: "in_review", to: "valid", isAdmin: false, isEnforcer: true, isLegalArrow: true });
  assert.deepEqual(d, { allowed: true, mode: "enforced", changed: true });
});

test("decideTransition: enforcer on an illegal arrow is refused", () => {
  const d = decideTransition({ from: "awaiting_triage", to: "in_review", isAdmin: false, isEnforcer: true, isLegalArrow: false });
  assert.deepEqual(d, { allowed: false, reason: "illegal_transition" });
});

test("decideTransition: same-status is an idempotent no-op for any authorized actor (no illegal-arrow check)", () => {
  const enforcer = decideTransition({ from: "valid", to: "valid", isAdmin: false, isEnforcer: true, isLegalArrow: false });
  assert.deepEqual(enforcer, { allowed: true, mode: "enforced", changed: false });
  const admin = decideTransition({ from: "solved", to: "solved", isAdmin: true, isEnforcer: false, isLegalArrow: false });
  assert.deepEqual(admin, { allowed: true, mode: "override", changed: false });
});

// ── §10.1 author edit / withdraw / resubmit windows ──────────────────────────────────────

test("canAuthorEditChallenge: only awaiting_triage and needs_improvement", () => {
  assert.equal(canAuthorEditChallenge("awaiting_triage"), true);
  assert.equal(canAuthorEditChallenge("needs_improvement"), true);
  for (const s of ["in_review", "meeting_scheduled", "valid", "solved", "rejected", "withdrawn"] as const) {
    assert.equal(canAuthorEditChallenge(s), false, `${s} must not be author-editable`);
  }
});

test("canAuthorEditSolution: only proposed and needs_improvement", () => {
  assert.equal(canAuthorEditSolution("proposed"), true);
  assert.equal(canAuthorEditSolution("needs_improvement"), true);
  for (const s of ["in_review", "valid", "accepted_internally", "implemented", "rejected", "not_selected", "withdrawn"] as const) {
    assert.equal(canAuthorEditSolution(s), false, `${s} must not be author-editable`);
  }
});

test("canAuthorResubmit: only from needs_improvement", () => {
  assert.equal(canAuthorResubmit("needs_improvement"), true);
  assert.equal(canAuthorResubmit("in_review"), false);
  assert.equal(canAuthorResubmit("proposed"), false);
});

test("canAuthorWithdraw*: any non-terminal status; terminal statuses refused", () => {
  assert.equal(canAuthorWithdrawChallenge("awaiting_triage"), true);
  assert.equal(canAuthorWithdrawChallenge("valid"), true);
  for (const s of ["solved", "rejected", "withdrawn"] as const) assert.equal(canAuthorWithdrawChallenge(s), false);
  assert.equal(canAuthorWithdrawSolution("proposed"), true);
  assert.equal(canAuthorWithdrawSolution("in_implementation"), true);
  for (const s of ["implemented", "rejected", "not_selected", "withdrawn"] as const) assert.equal(canAuthorWithdrawSolution(s), false);
});

// ── validation ───────────────────────────────────────────────────────────────────────────

test("validateChallengeFields: happy path, org visibility, non-Client area", () => {
  const result = validateChallengeFields({
    title: "  A great idea  ",
    description: "Details here",
    clientName: undefined,
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: false,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.title, "A great idea");
    assert.equal(result.value.clientName, null);
  }
});

test("validateChallengeFields: rejects missing/blank title", () => {
  const result = validateChallengeFields({
    title: "   ",
    description: "x",
    clientName: null,
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: false,
  });
  assert.equal(result.ok, false);
});

test("validateChallengeFields: rejects title over 120 chars", () => {
  const result = validateChallengeFields({
    title: "x".repeat(121),
    description: "x",
    clientName: null,
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: false,
  });
  assert.equal(result.ok, false);
});

test("validateChallengeFields: rejects description over 10000 chars", () => {
  const result = validateChallengeFields({
    title: "t",
    description: "x".repeat(10_001),
    clientName: null,
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: false,
  });
  assert.equal(result.ok, false);
});

test("validateChallengeFields: clientName required when impact area is Client", () => {
  const missing = validateChallengeFields({
    title: "t",
    description: "d",
    clientName: "",
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: true,
  });
  assert.equal(missing.ok, false);

  const present = validateChallengeFields({
    title: "t",
    description: "d",
    clientName: "Acme Corp",
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: true,
  });
  assert.equal(present.ok, true);
  if (present.ok) assert.equal(present.value.clientName, "Acme Corp");
});

test("validateChallengeFields: clientName is capped at CLIENT_NAME_MAX (200) characters, measured trimmed", () => {
  const base = { title: "t", description: "d", visibility: "org", isAnonymous: false, impactAreaIsClient: true } as const;
  assert.equal(CLIENT_NAME_MAX, 200);
  const atCap = validateChallengeFields({ ...base, clientName: "x".repeat(CLIENT_NAME_MAX) });
  assert.equal(atCap.ok, true);
  const padded = validateChallengeFields({ ...base, clientName: `  ${"x".repeat(CLIENT_NAME_MAX)}  ` });
  assert.equal(padded.ok, true);
  const over = validateChallengeFields({ ...base, clientName: "x".repeat(CLIENT_NAME_MAX + 1) });
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.error, /at most 200/);
});

test("validateChallengeFields: clientName must be empty when impact area is not Client", () => {
  const result = validateChallengeFields({
    title: "t",
    description: "d",
    clientName: "Acme Corp",
    visibility: "org",
    isAnonymous: false,
    impactAreaIsClient: false,
  });
  assert.equal(result.ok, false);
});

test("validateChallengeFields: rejects an invalid visibility value", () => {
  const result = validateChallengeFields({
    title: "t",
    description: "d",
    clientName: null,
    visibility: "public",
    isAnonymous: false,
    impactAreaIsClient: false,
  });
  assert.equal(result.ok, false);
});

test("validateSolutionFields: happy path with optional costVsBenefits", () => {
  const result = validateSolutionFields({ description: "  Do the thing  ", costVsBenefits: "cheap", isAnonymous: true });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.description, "Do the thing");
    assert.equal(result.value.costVsBenefits, "cheap");
  }
});

test("validateSolutionFields: costVsBenefits is optional", () => {
  const result = validateSolutionFields({ description: "d", costVsBenefits: undefined, isAnonymous: false });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.costVsBenefits, null);
});

test("validateSolutionFields: rejects blank description", () => {
  const result = validateSolutionFields({ description: "  ", costVsBenefits: null, isAnonymous: false });
  assert.equal(result.ok, false);
});

test("validateSolutionFields: rejects costVsBenefits over 5000 chars", () => {
  const result = validateSolutionFields({ description: "d", costVsBenefits: "x".repeat(5001), isAnonymous: false });
  assert.equal(result.ok, false);
});

// ── §10.3 admin delete ────────────────────────────────────────────────────────────────────

test("validateDeleteReason: trims and accepts a real reason", () => {
  const result = validateDeleteReason("  contained a client contract  ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "contained a client contract");
});

test("validateDeleteReason: rejects missing, blank, and non-string reasons", () => {
  for (const bad of [undefined, null, "", "   ", 42, {}]) {
    assert.equal(validateDeleteReason(bad).ok, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("validateDeleteReason: rejects a reason over 500 chars", () => {
  assert.equal(validateDeleteReason("x".repeat(501)).ok, false);
  assert.equal(validateDeleteReason("x".repeat(500)).ok, true);
});

test("parentStatusAfterSolutionDelete: deleting the implemented solution un-solves the challenge", () => {
  assert.equal(parentStatusAfterSolutionDelete({ solutionStatus: "implemented", challengeStatus: "solved" }), "valid");
});

test("parentStatusAfterSolutionDelete: an admin-moved challenge is never force-set", () => {
  for (const challengeStatus of ["rejected", "withdrawn", "valid", "in_review"] as const) {
    assert.equal(parentStatusAfterSolutionDelete({ solutionStatus: "implemented", challengeStatus }), null, challengeStatus);
  }
});

test("parentStatusAfterSolutionDelete: pre-implemented advanced statuses change nothing", () => {
  for (const solutionStatus of ["accepted_internally", "waiting_for_resources", "in_implementation", "external_acceptance"] as const) {
    assert.equal(parentStatusAfterSolutionDelete({ solutionStatus, challengeStatus: "valid" }), null, solutionStatus);
    // …not even on a solved challenge: only the implemented solution un-solves it.
    assert.equal(parentStatusAfterSolutionDelete({ solutionStatus, challengeStatus: "solved" }), null, solutionStatus);
  }
});

test("parentStatusAfterSolutionDelete: ordinary and terminal statuses change nothing", () => {
  for (const solutionStatus of ["proposed", "in_review", "valid", "rejected", "not_selected", "withdrawn"] as const) {
    assert.equal(parentStatusAfterSolutionDelete({ solutionStatus, challengeStatus: "solved" }), null, solutionStatus);
  }
});

test("notificationLinkScope: a challenge matches its own link plus its solutions' hashes", () => {
  const scope = notificationLinkScope({ challengeNumber: "CH-42" });
  assert.equal(scope.exact, "/challenges/42");
  assert.equal(scope.prefix, "/challenges/42#");
});

test("notificationLinkScope: the '#' prefix keeps CH-4 from swallowing CH-42", () => {
  const four = notificationLinkScope({ challengeNumber: 4 });
  assert.equal(four.prefix, "/challenges/4#");
  assert.ok(!"/challenges/42".startsWith(four.prefix!));
  assert.notEqual("/challenges/42", four.exact);
});

test("notificationLinkScope: a solution matches exactly one link", () => {
  const scope = notificationLinkScope({ challengeNumber: "CH-42", solutionNumber: "SOL-17" });
  assert.equal(scope.exact, "/challenges/42#SOL-17");
  assert.equal(scope.prefix, null);
});

// ── §10.4 trash & restore ────────────────────────────────────────────────────────────────

test("canSeeChallenge: a trashed challenge is visible to platform admins only", () => {
  const challenge = { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "org" as const, status: "valid" as const, authorId: AUTHOR, trashed: true };
  assert.equal(canSeeChallenge(viewer(OTHER), challenge), false);
  assert.equal(canSeeChallenge(viewer(AUTHOR), challenge), false, "not even its author");
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "namespace_admin", namespaceId: NS_A }]), challenge), false);
  assert.equal(canSeeChallenge(viewer(OTHER, [{ role: "platform_admin", namespaceId: null }]), challenge), true);
});

test("canSeeSolution: a trashed solution alone is visible to platform admins only", () => {
  const challenge = { namespaceId: NS_A, assigneeId: ASSIGNEE };
  const solution = { status: "valid" as const, authorId: AUTHOR, trashed: true };
  assert.equal(canSeeSolution(viewer(AUTHOR), challenge, solution), false);
  assert.equal(canSeeSolution(viewer(ASSIGNEE), challenge, solution), false);
  assert.equal(canSeeSolution(viewer(OTHER, [{ role: "committee", namespaceId: NS_A }]), challenge, solution), false);
  assert.equal(canSeeSolution(viewer(OTHER, [{ role: "platform_admin", namespaceId: null }]), challenge, solution), true);
});

test("trashPurgesOn / isTrashPurgeDue: the item is due exactly 30 days after it was trashed", () => {
  assert.equal(TRASH_RETENTION_DAYS, 30);
  const at = new Date("2026-10-01T10:00:00Z");
  assert.equal(trashPurgesOn(at).toISOString(), "2026-10-31T10:00:00.000Z");
  assert.equal(isTrashPurgeDue(at, new Date("2026-10-31T09:59:59Z")), false);
  assert.equal(isTrashPurgeDue(at, new Date("2026-10-31T10:00:00Z")), true);
});

test("daysInTrash counts whole days", () => {
  const at = new Date("2026-10-01T10:00:00Z");
  assert.equal(daysInTrash(at, new Date("2026-10-01T23:00:00Z")), 0);
  assert.equal(daysInTrash(at, new Date("2026-10-04T10:00:01Z")), 3);
});

test("solutionRestoreBlocked: a solution waits for its trashed challenge to be restored first", () => {
  assert.equal(solutionRestoreBlocked({ challengeTrashed: true }), true);
  assert.equal(solutionRestoreBlocked({ challengeTrashed: false }), false);
});

test("validateTrashReason: required, trimmed, at most 500 characters", () => {
  assert.equal(validateTrashReason(undefined).ok, false);
  assert.equal(validateTrashReason("   ").ok, false);
  assert.deepEqual(validateTrashReason("  posted by mistake "), { ok: true, value: "posted by mistake" });
  assert.equal(validateTrashReason("x".repeat(500)).ok, true);
  assert.equal(validateTrashReason("x".repeat(501)).ok, false);
});

test("an AI agent never sees a trashed item, not even a platform admin's (§10.4, §25)", () => {
  const pa = viewer(OTHER, [{ role: "platform_admin", namespaceId: null }]);
  const agent = { ...pa, viaAgent: true };
  const challenge = { id: CH, namespaceId: NS_A, assigneeId: null, visibility: "org" as const, status: "valid" as const, authorId: AUTHOR, trashed: true };
  assert.equal(canSeeChallenge(pa, challenge), true, "the person in the browser gets the read-only view");
  assert.equal(canSeeChallenge(agent, challenge), false);
  assert.equal(canSeeSolution(agent, { namespaceId: NS_A, assigneeId: null }, { status: "valid", authorId: AUTHOR, trashed: true }), false);
  assert.equal(canSeeChallenge(agent, { ...challenge, trashed: false }), true, "a live item is unaffected");
});
