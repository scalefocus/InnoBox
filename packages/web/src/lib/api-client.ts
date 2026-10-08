"use client";
// Shared client-side fetch wrappers — previously reimplemented per-page (admin/page.tsx,
// challenges/[number]/page.tsx, profile/page.tsx, CommentThread.tsx). Every API route in
// this app returns `{error: string}` JSON on failure, so these throw a normal Error with
// that message (or a generic fallback) on any non-ok response, leaving callers to just
// `try { await postJson(...) } catch (err) { ... }`.
export async function readJson(res: Response): Promise<{ error?: string; [key: string]: unknown }> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function jsonRequest(method: "POST" | "PATCH", url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

export function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  return jsonRequest("POST", url, body);
}

export function patchJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  return jsonRequest("PATCH", url, body);
}

export async function deleteReq(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE" });
  if (res.status === 204 || res.ok) return;
  const json = await readJson(res);
  throw new Error(json.error ?? `request failed (${res.status})`);
}
