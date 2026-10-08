// CSP mode switch for the §2.4 web security baseline (INNOBOX_SPEC.md): CSP_MODE =
// enforce (default) | report-only | off. Pure and dependency-free, so the middleware (edge), the
// startup check in instrumentation.ts (node), and the unit tests share one rule.
//
// The mode governs ONLY the page/API policy. The attachment-download policy is a file-serving
// control and stays enforced in every mode; every other §2.4 header is untouched. In every mode
// the middleware still mints the nonce and forwards the policy on the REQUEST side, so the
// renderer keeps nonce-tagging its inline scripts and switching modes needs no rebuild.

export type CspMode = "enforce" | "report-only" | "off";

export const CSP_MODES: readonly CspMode[] = ["enforce", "report-only", "off"];

export interface CspModeResolution {
  mode: CspMode;
  /** The raw value was not a recognised mode (it resolves to `enforce`). */
  unrecognised: boolean;
}

/** The mode for a raw CSP_MODE value. Unset or blank (how an unset compose variable arrives) is
 *  the default `enforce`; the match is exact after trimming. An unrecognised value resolves to
 *  `enforce` — outside production with a warning, in production it never gets that far
 *  (cspModeStartupCheck refuses to start). */
export function resolveCspMode(raw: string | undefined): CspModeResolution {
  const v = raw?.trim() ?? "";
  if (v === "") return { mode: "enforce", unrecognised: false };
  if ((CSP_MODES as readonly string[]).includes(v)) return { mode: v as CspMode, unrecognised: false };
  return { mode: "enforce", unrecognised: true };
}

export interface CspStartupCheck {
  /** Fatal structured log line: the process must refuse to start. */
  fatal: string | null;
  /** Structured warning line to log once at startup (an unrecognised value outside production). */
  warning: string | null;
}

/** §2.3 fail-loud startup check, the same pattern as INNOBOX_DEV_AUTH: a production build that
 *  finds CSP_MODE=off, or any unrecognised value, refuses to start. `report-only` is a permitted
 *  rollout state in production. The value itself is not echoed. */
export function cspModeStartupCheck(env: { NODE_ENV?: string; CSP_MODE?: string }): CspStartupCheck {
  const { mode, unrecognised } = resolveCspMode(env.CSP_MODE);
  const production = env.NODE_ENV === "production";
  if (production && (mode === "off" || unrecognised)) {
    return {
      fatal: JSON.stringify({
        level: "fatal",
        msg: unrecognised
          ? "CSP_MODE has an unrecognised value in a production build — refusing to start. Use enforce or report-only."
          : "CSP_MODE=off in a production build — refusing to start. Use enforce or report-only.",
        variable: "CSP_MODE",
      }),
      warning: null,
    };
  }
  if (unrecognised) {
    return {
      fatal: null,
      warning: JSON.stringify({
        level: "warn",
        msg: "CSP_MODE has an unrecognised value — treating it as enforce. Use enforce, report-only or off.",
        variable: "CSP_MODE",
      }),
    };
  }
  return { fatal: null, warning: null };
}

export interface CspResponseHeaderInput {
  mode: CspMode;
  /** The page/API policy for this request (already carrying the report directives when the
   *  mode reports). */
  policy: string;
  /** The response's own CSP is the attachment-download policy instead. */
  attachmentPolicy: string | null;
  /** The `Reporting-Endpoints` value, or null when no origin could be determined. */
  reportingEndpoints: string | null;
}

/** The CSP-related response headers: a value to set, or null to remove the header (so nothing a
 *  route set itself can survive in the wrong mode). */
export function cspResponseHeaders(input: CspResponseHeaderInput): Record<
  "Content-Security-Policy" | "Content-Security-Policy-Report-Only" | "Reporting-Endpoints",
  string | null
> {
  if (input.attachmentPolicy) {
    // The download gateway's sandbox policy is enforced in every mode, and replaces the page
    // policy outright — there is nothing on a served file for the report endpoints to cover.
    return {
      "Content-Security-Policy": input.attachmentPolicy,
      "Content-Security-Policy-Report-Only": null,
      "Reporting-Endpoints": null,
    };
  }
  switch (input.mode) {
    case "enforce":
      return {
        "Content-Security-Policy": input.policy,
        "Content-Security-Policy-Report-Only": null,
        "Reporting-Endpoints": input.reportingEndpoints,
      };
    case "report-only":
      return {
        "Content-Security-Policy": null,
        "Content-Security-Policy-Report-Only": input.policy,
        "Reporting-Endpoints": input.reportingEndpoints,
      };
    case "off":
      return {
        "Content-Security-Policy": null,
        "Content-Security-Policy-Report-Only": null,
        "Reporting-Endpoints": null,
      };
  }
}
