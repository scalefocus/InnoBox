// The §24.2 Public submissions card's read model (INNOBOX_SPEC.md §24.2, §14.3): the switch, the
// notice, the read-only public address, and every missing precondition with its hint — so the
// card can disable the switch and list everything there is to fix.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { PUBLIC_FORM_PATH } from "@/lib/public-intake-paths";
import { PRECONDITION_HINT, missingPrecondition, unmetPreconditionList, type MissingPrecondition, type UnmetPrecondition } from "@/lib/public-intake";
import { readPublicIntakeState } from "@/lib/public-intake-live";

export interface PublicSubmissionsCard {
  enabled: boolean;
  privacyNotice: string;
  /** `<PUBLIC_BASE_URL>/submit` — shared by the organization wherever it wants submissions from. */
  publicUrl: string;
  /** Live: the switch is on and every precondition holds. */
  live: boolean;
  /** Every unmet precondition with its hint, in the key → notice → transport order; empty when none. */
  unmet: UnmetPrecondition[];
  /** The first missing precondition (and its hint), or null — kept for compatibility. */
  missing: MissingPrecondition | null;
  hint: string | null;
}

export async function publicSubmissionsCard(): Promise<PublicSubmissionsCard> {
  const state = await readPublicIntakeState();
  const missing = missingPrecondition(state);
  return {
    enabled: state.enabled,
    privacyNotice: state.privacyNotice,
    publicUrl: `${publicBaseUrl()}${PUBLIC_FORM_PATH}`,
    live: state.live,
    unmet: unmetPreconditionList(state),
    missing,
    hint: missing ? PRECONDITION_HINT[missing] : null,
  };
}
