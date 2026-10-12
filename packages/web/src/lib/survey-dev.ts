// The forced-win seam for the survey e2e (INNOBOX_SPEC.md §13.10). The roll is 1 in 3 and
// server-side, so a browser test cannot otherwise make a survey appear. A dev sign-in with the
// survey flag marks that persona; its rolls then always win.
//
// Behind the same guard as the dev-auth bypass (§2.3): honoured only while INNOBOX_DEV_AUTH=1 and
// NODE_ENV is not production — a production build ignores it no matter what is in the set.
// Process memory, kept on globalThis so every route bundle in the dev server sees the same set.

const KEY = Symbol.for("innobox.survey.forced-win");

function forced(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (g[KEY] ??= new Set<string>());
}

export function surveySeamEnabled(env: { NODE_ENV?: string; INNOBOX_DEV_AUTH?: string } = process.env): boolean {
  return env.INNOBOX_DEV_AUTH === "1" && env.NODE_ENV !== "production";
}

export function setSurveyForcedWin(userId: string, on: boolean): void {
  if (on && surveySeamEnabled()) forced().add(userId);
  else forced().delete(userId);
}

export function isSurveyWinForced(userId: string): boolean {
  return surveySeamEnabled() && forced().has(userId);
}
