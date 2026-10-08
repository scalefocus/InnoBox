// Pure request-shape parsing for /api/admin/triage (INNOBOX_SPEC.md §14.1).
import { CHALLENGE_STATUSES, type ChallengeStatus } from "@innobox/shared";
import { isUuid } from "../../challenges/validation";
import { TRIAGE_PAGE_SIZE_DEFAULT, TRIAGE_PAGE_SIZE_MAX, type TriageFilters } from "./store";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// Matches the triage queue's own row cap (store.ts's `limit 500`) — a bulk action can never
// legitimately need to touch more rows than the queue can even display in one page, and
// capping here bounds a single request's connection-pool/transaction-count footprint.
const BULK_NUMBERS_MAX = 500;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function parseTriageFilters(params: URLSearchParams): Parsed<TriageFilters> {
  const value: TriageFilters = {};

  const namespaceId = params.get("namespaceId");
  if (namespaceId !== null) {
    if (!isUuid(namespaceId)) return fail("namespaceId must be a uuid");
    value.namespaceId = namespaceId;
  }

  const status = params.get("status");
  if (status !== null) {
    if (!(CHALLENGE_STATUSES as readonly string[]).includes(status)) {
      return fail(`status must be one of: ${CHALLENGE_STATUSES.join(", ")}`);
    }
    value.status = status as ChallengeStatus;
  }

  const authorName = params.get("authorName");
  if (authorName !== null && authorName.trim() !== "") value.authorName = authorName.trim();

  const assigneeId = params.get("assigneeId");
  if (assigneeId !== null) {
    if (assigneeId === "unassigned") value.assigneeId = "unassigned";
    else if (isUuid(assigneeId)) value.assigneeId = assigneeId;
    else return fail("assigneeId must be a uuid or 'unassigned'");
  }

  const number = params.get("number");
  if (number !== null && number.trim() !== "") {
    const bare = number.trim().replace(/^ch-?/i, "");
    if (!/^\d+$/.test(bare)) return fail("number must look like CH-123");
    value.number = bare;
  }

  return { ok: true, value };
}

export function parseTriagePagination(params: URLSearchParams): Parsed<{ page: number; pageSize: number }> {
  const pageRaw = params.get("page");
  let page = 1;
  if (pageRaw !== null) {
    page = Number(pageRaw);
    if (!Number.isInteger(page) || page < 1) return fail("page must be a positive integer");
  }

  const pageSizeRaw = params.get("pageSize");
  let pageSize = TRIAGE_PAGE_SIZE_DEFAULT;
  if (pageSizeRaw !== null) {
    pageSize = Number(pageSizeRaw);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > TRIAGE_PAGE_SIZE_MAX) {
      return fail(`pageSize must be an integer between 1 and ${TRIAGE_PAGE_SIZE_MAX}`);
    }
  }

  return { ok: true, value: { page, pageSize } };
}

export function parseBulkStatusBody(body: unknown, isValid: (s: string) => boolean): Parsed<{ numbers: string[]; status: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("request body must be a JSON object");
  const rec = body as Record<string, unknown>;
  if (!Array.isArray(rec.numbers) || rec.numbers.length === 0 || !rec.numbers.every((n) => typeof n === "string")) {
    return fail("numbers must be a non-empty array of challenge numbers");
  }
  if (rec.numbers.length > BULK_NUMBERS_MAX) return fail(`numbers must contain at most ${BULK_NUMBERS_MAX} items`);
  if (typeof rec.status !== "string" || !isValid(rec.status)) return fail("status must be a valid status value");
  return { ok: true, value: { numbers: rec.numbers.map((n) => n.replace(/^ch-?/i, "")), status: rec.status } };
}

export function parseBulkAssignBody(body: unknown): Parsed<{ numbers: string[]; assigneeUserId: string | null }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("request body must be a JSON object");
  const rec = body as Record<string, unknown>;
  if (!Array.isArray(rec.numbers) || rec.numbers.length === 0 || !rec.numbers.every((n) => typeof n === "string")) {
    return fail("numbers must be a non-empty array of challenge numbers");
  }
  if (rec.numbers.length > BULK_NUMBERS_MAX) return fail(`numbers must contain at most ${BULK_NUMBERS_MAX} items`);
  if (rec.assigneeUserId !== null && (typeof rec.assigneeUserId !== "string" || !isUuid(rec.assigneeUserId))) {
    return fail("assigneeUserId must be a uuid or null");
  }
  return { ok: true, value: { numbers: rec.numbers.map((n) => n.replace(/^ch-?/i, "")), assigneeUserId: rec.assigneeUserId } };
}
