// /submit/confirm — where the e-mailed confirmation link lands (INNOBOX_SPEC.md §24.5). The token
// is in the URL fragment, so it never reaches a server, proxy or Referer; the page reads it in the
// browser and confirms only on a click (e-mail scanners open links automatically). 404 while the
// form is off, like /submit (§24.2).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicIntakeState } from "@/lib/public-intake-live";
import { PublicFrame } from "../PublicFrame";
import { ConfirmView } from "./ConfirmView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Confirm your submission — InnoBox" };

export default async function PublicConfirmPage() {
  if (!(await loadPublicIntakeState()).live) notFound();
  return (
    <PublicFrame>
      <ConfirmView />
    </PublicFrame>
  );
}
