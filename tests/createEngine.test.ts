import { describe, expect, it } from "vitest";
import { createEngine, engineFingerprint } from "../src/engine/createEngine";
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

describe("engineFingerprint", () => {
  const fp = (s: Partial<LlmWikiSettings>, m: Record<string, string> = {}, root = "/repo") =>
    engineFingerprint({ ...DEFAULT_SETTINGS, ...s }, root, secrets(m));

  it("is stable for identical settings", () => {
    expect(fp({}, { "oauth-token": "t" })).toBe(fp({}, { "oauth-token": "t" }));
  });

  it("changes with each engine-relevant field of the claude-code engine", () => {
    const base = fp({});
    expect(fp({ engine: "api" })).not.toBe(base);
    expect(fp({}, {}, "/other")).not.toBe(base);
    expect(fp({ cliPath: "x" })).not.toBe(base);
    expect(fp({ cliModel: "opus" })).not.toBe(base);
    expect(fp({ maxBudgetUsd: 2 })).not.toBe(base);
    expect(fp({ useApiKeyForCli: true })).not.toBe(base);
    expect(fp({}, { "oauth-token": "t" })).not.toBe(base);
  });

  it("ignores fields the selected engine does not use", () => {
    expect(fp({ apiModel: "other" })).toBe(fp({}));
    expect(fp({}, { "api-key": "k" })).toBe(fp({})); // CLI without useApiKeyForCli
    expect(fp({ engine: "api", cliModel: "opus" })).toBe(fp({ engine: "api" }));
  });

  it("changes with the API key and model for the api engine", () => {
    const base = fp({ engine: "api" }, { "api-key": "a" });
    expect(fp({ engine: "api" }, { "api-key": "b" })).not.toBe(base);
    expect(fp({ engine: "api", apiModel: "m2" }, { "api-key": "a" })).not.toBe(base);
    expect(fp({ engine: "api", useApiKeyForCli: true }, { "api-key": "a" })).toBe(base);
  });
});
