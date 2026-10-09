"use client";
// The §13.1 gallery filters — status, impact area, namespace, author name — as one control row,
// shared by the Challenges gallery and the Search page (§13.4, where they narrow the results
// alongside the query). Pure presentation: the API applies the filters, visibility-filtered and
// anonymity-safe (an author filter never matches an anonymous item).
import { useEffect, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { CHALLENGE_STATUS_LABEL } from "./status";

export interface GalleryFilterValues {
  status: string;
  impactAreaId: string;
  namespaceId: string;
  authorName: string;
}

export const EMPTY_GALLERY_FILTERS: GalleryFilterValues = { status: "", impactAreaId: "", namespaceId: "", authorName: "" };

interface ImpactArea {
  id: string;
  name: string;
  active: boolean;
}

interface NamespaceOption {
  id: string;
  slug: string;
  displayName: string;
}

/** Writes the non-empty filters onto a query string (the API's parameter names). */
export function applyGalleryFilters(params: URLSearchParams, filters: GalleryFilterValues): URLSearchParams {
  if (filters.status) params.set("status", filters.status);
  if (filters.impactAreaId) params.set("impactAreaId", filters.impactAreaId);
  if (filters.namespaceId) params.set("namespaceId", filters.namespaceId);
  if (filters.authorName.trim()) params.set("authorName", filters.authorName.trim());
  return params;
}

/** Renders the four filter controls as fragments, so the caller decides the surrounding row. */
export function GalleryFilterFields({
  value,
  onChange,
}: {
  value: GalleryFilterValues;
  onChange: (next: GalleryFilterValues) => void;
}) {
  const [impactAreas, setImpactAreas] = useState<ImpactArea[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);

  useEffect(() => {
    cachedGet<{ impactAreas: ImpactArea[] }>("/api/impact-areas")
      .then((j) => setImpactAreas(j.impactAreas))
      .catch(() => {});
    cachedGet<{ namespaces: NamespaceOption[] }>("/api/namespaces")
      .then((j) => setNamespaces(j.namespaces))
      .catch(() => {});
  }, []);

  const set = (patch: Partial<GalleryFilterValues>) => onChange({ ...value, ...patch });

  return (
    <>
      <select className="field" aria-label="Status" value={value.status} onChange={(e) => set({ status: e.target.value })}>
        <option value="">All statuses</option>
        {Object.keys(CHALLENGE_STATUS_LABEL).map((s) => (
          <option key={s} value={s}>
            {CHALLENGE_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <select className="field" aria-label="Impact area" value={value.impactAreaId} onChange={(e) => set({ impactAreaId: e.target.value })}>
        <option value="">All impact areas</option>
        {impactAreas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <select className="field" aria-label="Namespace" value={value.namespaceId} onChange={(e) => set({ namespaceId: e.target.value })}>
        <option value="">All my namespaces</option>
        {namespaces.map((ns) => (
          <option key={ns.id} value={ns.id}>
            {ns.displayName}
          </option>
        ))}
      </select>
      <input
        className="field"
        aria-label="Author name"
        placeholder="Filter by author name"
        value={value.authorName}
        onChange={(e) => set({ authorName: e.target.value })}
      />
    </>
  );
}
