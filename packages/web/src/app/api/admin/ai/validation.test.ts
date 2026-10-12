// Unit tests for the §22 AI provider request parsers (INNOBOX_SPEC.md §22.4, §22.9): provider,
// base URL and key shapes, the model, the enable patch and the switches allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAiConfigInput, parseAiConnectionInput, parseAiEnabledPatch, parseAiSwitchesInput } from "./validation";

test("connection: provider required, base URL optional text, blank key means stored", () => {
  assert.deepEqual(parseAiConnectionInput({ provider: "openai" }), { ok: true, value: { provider: "openai", baseUrl: "", token: "" } });
  assert.deepEqual(parseAiConnectionInput({ provider: "openwebui", baseUrl: "https://h/api", token: " sk-1 " }), {
    ok: true,
    value: { provider: "openwebui", baseUrl: "https://h/api", token: "sk-1" },
  });
  assert.equal(parseAiConnectionInput({ provider: "azure" }).ok, false);
  assert.equal(parseAiConnectionInput({ provider: "openai", baseUrl: 5 }).ok, false);
  assert.equal(parseAiConnectionInput({ provider: "openai", token: "has space" }).ok, false);
});

test("config: a model is required", () => {
  assert.equal(parseAiConfigInput({ provider: "openai" }).ok, false);
  const ok = parseAiConfigInput({ provider: "openai", model: " gpt-4o-mini " });
  assert.ok(ok.ok && ok.value.model === "gpt-4o-mini");
});

test("enable patch: a boolean only", () => {
  assert.deepEqual(parseAiEnabledPatch({ enabled: true }), { ok: true, value: { enabled: true } });
  assert.equal(parseAiEnabledPatch({ enabled: "yes" }).ok, false);
  assert.equal(parseAiEnabledPatch({}).ok, false);
});

test("switches: restricted content and registered switchable tasks only", () => {
  assert.deepEqual(parseAiSwitchesInput({ restrictedContent: true }, []), { ok: true, value: { restrictedContent: true, features: {} } });
  assert.deepEqual(parseAiSwitchesInput({ features: { triage_assist: false } }, ["triage_assist"]), { ok: true, value: { features: { triage_assist: false } } });
  assert.equal(parseAiSwitchesInput({ features: { submit_draft: true } }, ["triage_assist"]).ok, false, "a task without a switch");
  assert.equal(parseAiSwitchesInput({ restrictedContent: "on" }, []).ok, false);
  assert.equal(parseAiSwitchesInput({}, []).ok, false, "nothing to change");
});
