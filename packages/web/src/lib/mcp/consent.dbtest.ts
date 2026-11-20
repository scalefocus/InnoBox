// Live-DB integration test (gated) for POST /oauth/consent's logic (INNOBOX_SPEC.md §25.3, §25.13):
// Approve and Deny are answered with the forwarding page — 200, no `Location` header — whose
// target is the pending row's redirect URI with `code`/`state`/`iss` or
// `error=access_denied`/`state`/`iss`; a second submit of the same form is 400 and carries no
// target; an approve without the confirmation is 400 and leaves the row usable; a blocked client
// gets 403, no page that forwards, and is reported to the route.
// Self-skips when DATABASE_URL is unset. It switches agent access on and leaves it off.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "agent access consent: forwarding page for approve and deny, never a redirect; single use; blocked client",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { createHash, randomUUID, randomBytes } = await import("node:crypto");
    const store = await import("./store");
    const { answerConsent } = await import("./consent");
    const { hashToken } = await import("./oauth");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-consent-${label}-${stamp}`,
          `dbtest-consent-${label}-${stamp}@example.test`,
          `Dbtest consent ${label} ${stamp}`,
        ]);
        return rows[0]!.id;
      };
      const person = await mkUser("person");
      const admin = await mkUser("admin");
      await store.setMcpSettings(pool, { enabled: true }, admin);

      const REDIRECT = "https://ai.example.test/oauth/clients/mcp:innobox/callback";
      const ISS = "https://innobox.example.test";
      const client = await store.registerClient(
        pool,
        { clientName: `Dbtest Consent ${stamp}`, redirectUris: [REDIRECT], clientUri: null, logoUri: null, softwareId: null, softwareVersion: null },
        "127.0.0.1",
      );
      const verifier = randomBytes(40).toString("base64url");
      // A state a client could send: the page must carry it through intact and inert.
      const request = {
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        state: `st&te "<${stamp}>"`,
        resource: "http://localhost:3000/mcp",
      };
      const pend = () => store.createPendingAuthorization(pool, person, client.id, request);
      const form = (fields: Record<string, string>) => new URLSearchParams(fields);

      /** The forwarding page's one target: the refresh URL, which must equal the Continue link. */
      const targetOf = (html: string): URL => {
        const unescape = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        const refresh = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(html);
        const link = /<a class="go" href="([^"]*)">Continue<\/a>/.exec(html);
        assert.ok(refresh && link, "a refresh and a Continue link");
        assert.equal(refresh[1], link[1], "one and the same URL");
        return new URL(unescape(refresh[1]!));
      };
      const isForwardingPage = async (res: Response): Promise<URL> => {
        assert.equal(res.status, 200, "200 — never a redirect");
        assert.equal(res.headers.get("location"), null, "no Location header");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
        const html = await res.text();
        assert.ok(html.includes(`Returning to <span class="destination">ai.example.test</span>`));
        assert.ok(!html.includes("<script") && !html.includes(`<${stamp}>`), "no script, and the state stays inert");
        return targetOf(html);
      };

      // Deny: the forwarding page, to the pending row's redirect URI with access_denied.
      const denyId = await pend();
      const denied = await answerConsent(pool, person, form({ request_id: denyId, decision: "deny" }), ISS);
      assert.equal(denied.blockedClientName, null);
      const deniedTarget = await isForwardingPage(denied.response);
      assert.equal(deniedTarget.origin + deniedTarget.pathname, REDIRECT);
      assert.deepEqual(Object.fromEntries(deniedTarget.searchParams), { error: "access_denied", state: request.state, iss: ISS });
      assert.equal((await pool.query(`select 1 from oauth_grants where user_id = $1`, [person])).rowCount, 0, "a denial grants nothing");

      // Approve without the tick: 400, nothing forwarded, and the row is still usable.
      const approveId = await pend();
      const unticked = await answerConsent(pool, person, form({ request_id: approveId, decision: "approve" }), ISS);
      assert.equal(unticked.response.status, 400);
      assert.ok(!(await unticked.response.text()).includes('http-equiv="refresh"'));

      // Approve: the forwarding page, to the same redirect URI with a code that really exchanges.
      const approved = await answerConsent(pool, person, form({ request_id: approveId, decision: "approve", confirm: "1" }), ISS);
      const approvedTarget = await isForwardingPage(approved.response);
      assert.equal(approvedTarget.origin + approvedTarget.pathname, REDIRECT);
      assert.deepEqual([...approvedTarget.searchParams.keys()].sort(), ["code", "iss", "state"]);
      assert.equal(approvedTarget.searchParams.get("state"), request.state);
      assert.equal(approvedTarget.searchParams.get("iss"), ISS);
      const code = approvedTarget.searchParams.get("code")!;
      const { rows: codes } = await pool.query<{ redirect_uri: string }>(`select redirect_uri from oauth_tokens where kind = 'code' and token_hash = $1 and used_at is null`, [hashToken(code)]);
      assert.deepEqual(codes, [{ redirect_uri: REDIRECT }], "the code on the page is the one that was minted, unused");

      // A second submit of the same form — a reload, a double click — is 400 and carries no target,
      // so it can neither mint a second code nor send the first one again.
      const again = await answerConsent(pool, person, form({ request_id: approveId, decision: "approve", confirm: "1" }), ISS);
      assert.equal(again.response.status, 400);
      assert.equal(again.response.headers.get("location"), null);
      const againHtml = await again.response.text();
      assert.ok(againHtml.includes("This approval has expired or was already used."));
      assert.ok(!againHtml.includes('http-equiv="refresh"') && !againHtml.includes(code) && !againHtml.includes("ai.example.test"));
      assert.equal((await pool.query(`select 1 from oauth_tokens t join oauth_grants g on g.id = t.grant_id where g.user_id = $1 and t.kind = 'code'`, [person])).rowCount, 1, "still one code");

      // A blocked client: 403, the error page, and its name handed back for the system log.
      await store.setClientBlocked(pool, client.id, true, admin);
      const blockedId = await pend();
      const blocked = await answerConsent(pool, person, form({ request_id: blockedId, decision: "approve", confirm: "1" }), ISS);
      assert.equal(blocked.response.status, 403);
      assert.equal(blocked.blockedClientName, `Dbtest Consent ${stamp}`);
      const blockedHtml = await blocked.response.text();
      assert.ok(blockedHtml.includes("An administrator has blocked this application.") && !blockedHtml.includes('http-equiv="refresh"'));
    } finally {
      await pool.query(`insert into platform_settings (key, value) values ('mcp_enabled', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`).catch(() => {});
      await pool.end();
    }
  },
);
