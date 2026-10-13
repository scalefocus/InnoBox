// The §24.2 Public submissions card's read model (INNOBOX_SPEC.md §24.2, §14.3): the switch, the
// notice, the read-only public address, and — so the card can disable the switch with a hint —
// which precondition, if any, is missing.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { PUBLIC_FORM_PATH } from "@/lib/public-intake-paths";
import { PRECONDITION_HINT, missingPrecondition, type MissingPrecondition } from "@/lib/public-intake";
import { loadPublicIntakeState } from "@/lib/public-intake-live";

export interface PublicSubmissionsCard {
  enabled: boolean;
  privacyNotice: string;
  /** `<PUBLIC_BASE_URL>/submit` — shared by the organization wherever it wants submissions from. */
  publicUrl: string;
  /** Live: the switch is on and every precondition holds. */
  live: boolean;
  /** The first missing precondition (and its hint), or null. */
  missing: MissingPrecondition | null;
  hint: string | null;
}

export async function publicSubmissionsCard(): Promise<PublicSubmissionsCard> {
  const state = await loadPublicIntakeState();
  const missing = missingPrecondition(state);
  return {
    enabled: state.enabled,
    privacyNotice: state.privacyNotice,
    publicUrl: `${publicBaseUrl()}${PUBLIC_FORM_PATH}`,
    live: state.live,
    missing,
    hint: missing ? PRECONDITION_HINT[missing] : null,
  };
}
