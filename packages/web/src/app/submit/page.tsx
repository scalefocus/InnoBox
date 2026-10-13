// /submit — the public submission form (INNOBOX_SPEC.md §24.3). Unauthenticated, outside the app
// shell, and present only while a platform admin has switched it on and its preconditions hold:
// otherwise it is a plain 404, so the feature cannot be discovered (§24.2). It is linked from
// nowhere in InnoBox — the organization shares the address itself.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicIntakeState } from "@/lib/public-intake-live";
import { PublicFrame } from "./PublicFrame";
import { SubmitForm } from "./SubmitForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Submit a challenge — InnoBox" };

export default async function PublicSubmitPage() {
  if (!(await loadPublicIntakeState()).live) notFound();
  return (
    <PublicFrame>
      <SubmitForm />
    </PublicFrame>
  );
}
