// Query-string parsing shared by the Survey results routes (INNOBOX_SPEC.md §14.11). Unknown or
// missing values fall back to the defaults: 30 days, every segment, every feature, every source.
import {
  parseSurveyFeatureFilter,
  parseSurveyRange,
  parseSurveySegmentFilter,
  parseSurveySource,
} from "@innobox/shared/survey-results";
import type { SurveyFilters } from "./store";

export function parseSurveyFilters(params: URLSearchParams): SurveyFilters {
  return {
    range: parseSurveyRange(params.get("range")),
    segment: parseSurveySegmentFilter(params.get("segment")),
    feature: parseSurveyFeatureFilter(params.get("feature")),
    source: parseSurveySource(params.get("source")),
  };
}
