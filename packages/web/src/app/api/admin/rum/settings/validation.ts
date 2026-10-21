// Body validation for PATCH /api/admin/rum/settings (INNOBOX_SPEC.md §14.12). Pure, so the unit
// runner covers it without a session.
import { RUM_SAMPLE_RATES, isRumSampleRate, type RumSampleRate } from "@innobox/shared/rum";

export type RumSettingsPatch = { enabled?: boolean; sampleRate?: RumSampleRate };

export function parseRumSettingsPatch(
  body: Record<string, unknown>,
): { ok: true; value: RumSettingsPatch } | { ok: false; status: 400 | 422; error: string } {
  const value: RumSettingsPatch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, status: 400, error: "enabled must be true or false" };
    value.enabled = body.enabled;
  }
  if (body.sampleRate !== undefined) {
    if (!isRumSampleRate(body.sampleRate)) {
      return { ok: false, status: 422, error: `The sample rate must be one of ${RUM_SAMPLE_RATES.join(", ")} percent.` };
    }
    value.sampleRate = body.sampleRate;
  }
  if (value.enabled === undefined && value.sampleRate === undefined) {
    return { ok: false, status: 400, error: "Nothing to change — send enabled or sampleRate." };
  }
  return { ok: true, value };
}
