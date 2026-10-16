// Unit tests for the §14.11 survey-results rules: the size-5 withholding (question cards, trend
// buckets), the current-day exclusion, the Source filter and the bucket choice.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SURVEY_MIN_GROUP,
  bucketStart,
  buildSurveySeries,
  isWithheld,
  parseSurveyFeatureFilter,
  parseSurveyRange,
  parseSurveySegmentFilter,
  parseSurveySource,
  questionFigure,
  surveyBucketFor,
  surveyRangeBounds,
  surveyFeedPlan,
  triggersForSource,
} from "./survey-results.js";

const NOW = new Date("2026-10-12T23:59:00Z");

test("the minimum group size is 5", () => {
  assert.equal(SURVEY_MIN_GROUP, 5);
  assert.equal(isWithheld(4), true);
  assert.equal(isWithheld(5), false);
});

test("ranges always exclude the current UTC day", () => {
  assert.deepEqual(surveyRangeBounds("7", NOW), { from: "2026-10-05", to: "2026-10-12" });
  assert.deepEqual(surveyRangeBounds("30", NOW), { from: "2026-09-12", to: "2026-10-12" });
  assert.deepEqual(surveyRangeBounds("all", NOW), { from: null, to: "2026-10-12" });
  // Just after midnight UTC the new day starts — yesterday becomes visible, today is not.
  assert.deepEqual(surveyRangeBounds("7", new Date("2026-10-13T00:00:01Z")).to, "2026-10-13");
});

test("parsers fall back to safe defaults", () => {
  assert.equal(parseSurveyRange("90"), "90");
  assert.equal(parseSurveyRange("365"), "30");
  assert.equal(parseSurveyRange(null), "30");
  assert.equal(parseSurveySource("self"), "self");
  assert.equal(parseSurveySource("bogus"), "all");
  assert.equal(parseSurveySegmentFilter("committee"), "committee");
  assert.equal(parseSurveySegmentFilter("all"), null);
  assert.equal(parseSurveyFeatureFilter("search"), "search");
  assert.equal(parseSurveyFeatureFilter("all"), null);
});

test("Source: Prompted covers the random survey (feature + visit), Self-initiated the on-demand one", () => {
  assert.equal(triggersForSource("all"), null);
  assert.deepEqual(triggersForSource("prompted"), ["feature", "visit"]);
  assert.deepEqual(triggersForSource("self"), ["self"]);
});

test("the Bug reports source: bug only; Self-initiated stays self only", () => {
  assert.equal(parseSurveySource("bug"), "bug");
  assert.deepEqual(triggersForSource("bug"), ["bug"]);
  assert.equal(triggersForSource("prompted")!.includes("bug"), false);
});

test("the feed's withholding counts survey comments only — bug reports are listed regardless", () => {
  // All sources, fewer than 5 survey comments: those are withheld, the bug reports still listed.
  assert.deepEqual(surveyFeedPlan("all", 4), { withheld: true, listSurvey: false, listBugs: true });
  assert.deepEqual(surveyFeedPlan("all", 5), { withheld: false, listSurvey: true, listBugs: true });
  // No survey comment at all: nothing is withheld (the feed shows its empty state, or the bug reports).
  assert.deepEqual(surveyFeedPlan("all", 0), { withheld: false, listSurvey: true, listBugs: true });
  assert.deepEqual(surveyFeedPlan("self", 0), { withheld: false, listSurvey: true, listBugs: false });
  // Bug reports only: nothing to withhold.
  assert.deepEqual(surveyFeedPlan("bug", 0), { withheld: false, listSurvey: false, listBugs: true });
  // A survey-only source never lists bug reports.
  assert.deepEqual(surveyFeedPlan("self", 4), { withheld: true, listSurvey: false, listBugs: false });
  assert.deepEqual(surveyFeedPlan("prompted", 9), { withheld: false, listSurvey: true, listBugs: false });
});

test("question figures are withheld below 5 answers — no average, no distribution", () => {
  assert.deepEqual(questionFigure([0, 0, 1, 2, 1]), { n: 4, avg: null, distribution: null, withheld: true });
  assert.deepEqual(questionFigure([1, 0, 1, 2, 1]), { n: 5, avg: 3.4, distribution: [1, 0, 1, 2, 1], withheld: false });
  assert.deepEqual(questionFigure([]), { n: 0, avg: null, distribution: null, withheld: true });
});

test("trend buckets withhold thin averages and are never zero-filled", () => {
  const series = buildSurveySeries(
    [
      { day: "2026-10-01", n: 3, overallN: 3, overallSum: 12 },
      { day: "2026-10-03", n: 6, overallN: 5, overallSum: 21 },
    ],
    "day",
  );
  assert.deepEqual(series, [
    { date: "2026-10-01", n: 3, overallAvg: null },
    { date: "2026-10-03", n: 6, overallAvg: 4.2 },
  ]);
  // Two thin days in the same week together clear the bar.
  const weekly = buildSurveySeries(
    [
      { day: "2026-10-06", n: 3, overallN: 3, overallSum: 9 },
      { day: "2026-10-08", n: 3, overallN: 3, overallSum: 15 },
    ],
    "week",
  );
  assert.deepEqual(weekly, [{ date: "2026-10-05", n: 6, overallAvg: 4 }]);
});

test("buckets: days to a month, weeks to half a year, months beyond; weeks start Monday", () => {
  assert.equal(surveyBucketFor("7", null, null), "day");
  assert.equal(surveyBucketFor("30", null, null), "day");
  assert.equal(surveyBucketFor("90", null, null), "week");
  assert.equal(surveyBucketFor("all", "2026-09-01", "2026-09-20"), "day");
  assert.equal(surveyBucketFor("all", "2026-05-01", "2026-09-20"), "week");
  assert.equal(surveyBucketFor("all", "2025-05-01", "2026-09-20"), "month");
  assert.equal(bucketStart("2026-10-11", "week"), "2026-10-05"); // a Sunday → its Monday
  assert.equal(bucketStart("2026-10-05", "week"), "2026-10-05");
  assert.equal(bucketStart("2026-10-11", "month"), "2026-10-01");
});
