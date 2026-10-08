// Hermetic unit tests for the sign-out cookie sweep (lib/auth-cookie-sweep.ts, INNOBOX_SPEC.md
// §3): which names are swept (prefix stripped, chunks read from the request, non-auth state
// untouched), the expiry attributes (Max-Age=0, Path=/, no Domain, Secure rule), and that only
// a sign-out Auth.js accepted — not its CSRF-rejected redirect — gets the sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySignOutCookieSweep,
  authCookiesToExpire,
  expiredCookieHeader,
  isAcceptedSignOutTarget,
  isAuthCookieName,
  isHttpsBase,
  parseCookieNames,
  stripCookiePrefix,
} from "./auth-cookie-sweep";

test("prefix stripping: __Secure- and __Host- only", () => {
  assert.equal(stripCookiePrefix("__Secure-next-auth.session-token"), "next-auth.session-token");
  assert.equal(stripCookiePrefix("__Host-next-auth.csrf-token"), "next-auth.csrf-token");
  assert.equal(stripCookiePrefix("next-auth.callback-url"), "next-auth.callback-url");
  assert.equal(stripCookiePrefix("__Other-next-auth.x"), "__Other-next-auth.x");
});

test("auth cookie names: every next-auth.* (prefixed or not); nothing else", () => {
  for (const n of [
    "next-auth.session-token",
    "next-auth.session-token.0",
    "next-auth.session-token.7",
    "__Secure-next-auth.session-token.1",
    "__Host-next-auth.csrf-token",
    "__Secure-next-auth.callback-url",
    "__Secure-next-auth.pkce.code_verifier",
    "__Secure-next-auth.state",
    "__Secure-next-auth.nonce",
  ]) {
    assert.equal(isAuthCookieName(n), true, n);
  }
  for (const n of ["theme", "innobox-theme", "admin-cards", "challenges-view", "next-authx", "my-next-auth.session-token", "__Other-next-auth.x"]) {
    assert.equal(isAuthCookieName(n), false, n);
  }
});

test("the set is read from what was carried — every chunk, deduplicated, sorted", () => {
  const names = parseCookieNames(
    "theme=dark; __Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b; __Secure-next-auth.session-token.2=c; __Host-next-auth.csrf-token=x%7Cy; collapsed=1",
  );
  assert.deepEqual(authCookiesToExpire([...names, "__Secure-next-auth.session-token.1"]), [
    "__Host-next-auth.csrf-token",
    "__Secure-next-auth.session-token.0",
    "__Secure-next-auth.session-token.1",
    "__Secure-next-auth.session-token.2",
  ]);
});

test("parseCookieNames tolerates empty input and stray separators", () => {
  assert.deepEqual(parseCookieNames(null), []);
  assert.deepEqual(parseCookieNames(""), []);
  assert.deepEqual(parseCookieNames("a=1;; b=2; "), ["a", "b"]);
});

test("expiry header: Max-Age=0, Path=/, no Domain; Secure for prefixed names or an https base", () => {
  const plain = expiredCookieHeader("next-auth.session-token", false);
  assert.match(plain, /^next-auth\.session-token=;/);
  assert.match(plain, /Max-Age=0/);
  assert.match(plain, /Path=\//);
  assert.doesNotMatch(plain, /Domain/i);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(expiredCookieHeader("next-auth.session-token", true), /; Secure$/);
  assert.match(expiredCookieHeader("__Secure-next-auth.session-token", false), /; Secure$/);
  assert.match(expiredCookieHeader("__Host-next-auth.csrf-token", false), /; Secure$/);
});

test("https base detection: PUBLIC_BASE_URL, NEXTAUTH_URL fallback, garbage → false", () => {
  assert.equal(isHttpsBase({ PUBLIC_BASE_URL: "https://innobox.example.com" }), true);
  assert.equal(isHttpsBase({ PUBLIC_BASE_URL: "http://localhost:3000" }), false);
  assert.equal(isHttpsBase({ NEXTAUTH_URL: "https://innobox.example.com" }), true);
  assert.equal(isHttpsBase({ PUBLIC_BASE_URL: "not a url" }), false);
  assert.equal(isHttpsBase({}), false);
});

test("accepted vs rejected sign-out targets", () => {
  assert.equal(isAcceptedSignOutTarget("http://localhost:3000/"), true);
  assert.equal(isAcceptedSignOutTarget("/"), true);
  assert.equal(isAcceptedSignOutTarget("http://localhost:3000/api/auth/signout?csrf=true"), false);
  assert.equal(isAcceptedSignOutTarget(null), false);
  assert.equal(isAcceptedSignOutTarget(""), false);
});

const CARRIED =
  "theme=dark; next-auth.session-token.0=a; next-auth.session-token.1=b; next-auth.csrf-token=x; next-auth.callback-url=y; next-auth.pkce.code_verifier=z; next-auth.state=s; next-auth.nonce=n";

function expiredNames(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((v) => /Max-Age=0/.test(v))
    .map((v) => v.split("=")[0]!)
    .sort();
}

test("accepted sign-out (redirect): every carried auth cookie expired, non-auth untouched", async () => {
  const res = new Response(null, { status: 302, headers: { Location: "http://localhost:3000/" } });
  await applySignOutCookieSweep(CARRIED, res, { PUBLIC_BASE_URL: "http://localhost:3000" });
  assert.deepEqual(expiredNames(res), [
    "next-auth.callback-url",
    "next-auth.csrf-token",
    "next-auth.nonce",
    "next-auth.pkce.code_verifier",
    "next-auth.session-token.0",
    "next-auth.session-token.1",
    "next-auth.state",
  ]);
  assert.ok(!res.headers.getSetCookie().some((v) => v.startsWith("theme=")));
});

test("accepted sign-out (client json mode): the { url } body is the target", async () => {
  const res = new Response(JSON.stringify({ url: "http://localhost:3000/" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  await applySignOutCookieSweep(CARRIED, res, { PUBLIC_BASE_URL: "https://innobox.example.com" });
  const set = res.headers.getSetCookie();
  assert.equal(set.length, 7);
  assert.ok(set.every((v) => v.endsWith("; Secure")), "https base → Secure on every expiry");
  assert.deepEqual(await res.json(), { url: "http://localhost:3000/" }, "body still readable by the client");
});

test("a cookie Auth.js re-sets in the same response is expired after it (the sweep wins)", async () => {
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", "next-auth.callback-url=%2F; Path=/; HttpOnly; SameSite=Lax");
  const res = new Response(null, { status: 302, headers });
  await applySignOutCookieSweep("theme=dark", res, {});
  const set = res.headers.getSetCookie();
  assert.equal(set.length, 2);
  assert.match(set[1]!, /^next-auth\.callback-url=; .*Max-Age=0/);
});

test("CSRF-rejected sign-out (redirect to signout?csrf=true): no sweep", async () => {
  const res = new Response(null, { status: 302, headers: { Location: "http://localhost:3000/api/auth/signout?csrf=true" } });
  await applySignOutCookieSweep(CARRIED, res, {});
  assert.deepEqual(res.headers.getSetCookie(), []);
  const json = new Response(JSON.stringify({ url: "http://localhost:3000/api/auth/signout?csrf=true" }), {
    headers: { "Content-Type": "application/json" },
  });
  await applySignOutCookieSweep(CARRIED, json, {});
  assert.deepEqual(json.headers.getSetCookie(), []);
});

test("no redirect at all (an error response): no sweep", async () => {
  const res = new Response("oops", { status: 500 });
  await applySignOutCookieSweep(CARRIED, res, {});
  assert.deepEqual(res.headers.getSetCookie(), []);
});
