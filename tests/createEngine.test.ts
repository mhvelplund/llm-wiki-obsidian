import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine/createEngine";
import { DEFAULT_SETTINGS, type LlmWikiSettings } from "../src/engine/settingsTypes";

const secrets = (m: Record<string, string>) => ({ get: (id: string) => m[id] ?? null });
const envOf = (e: unknown) => (e as { opts: { env: Record<string, string> } }).opts.env;

describe("createEngine", () => {
  it("api engine without key returns an error mentioning the API key", () => {
    const s: LlmWikiSettings = { ...DEFAULT_SETTINGS, engine: "api" };
    const r = createEngine(s, "/repo", secrets({}));
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/API key/i);
  });

  it("api engine with key builds an api engine", () => {
    const s: LlmWikiSettings = { ...DEFAULT_SETTINGS, engine: "api" };
    const r = createEngine(s, "/repo", secrets({ "api-key": "k" }));
    expect((r as { id: string }).id).toBe("api");
  });

  it("claude-code passes the OAuth token in env", () => {
    const r = createEngine(DEFAULT_SETTINGS, "/repo", secrets({ "oauth-token": "tok" }));
    expect(envOf(r).CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("claude-code omits ANTHROPIC_API_KEY unless useApiKeyForCli", () => {
    const m = { "api-key": "k" };
    const off = createEngine({ ...DEFAULT_SETTINGS, useApiKeyForCli: false }, "/repo", secrets(m));
    expect(envOf(off)).not.toHaveProperty("ANTHROPIC_API_KEY");
    const on = createEngine({ ...DEFAULT_SETTINGS, useApiKeyForCli: true }, "/repo", secrets(m));
    expect(envOf(on).ANTHROPIC_API_KEY).toBe("k");
  });
});
