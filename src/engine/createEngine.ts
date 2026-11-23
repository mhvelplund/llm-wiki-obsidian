import { createHash } from "node:crypto";
import type { Engine } from "./Engine";
import { ApiEngine, createAnthropicClient } from "./ApiEngine";
import { ClaudeCodeEngine } from "./ClaudeCodeEngine";
import type { LlmWikiSettings, SecretId } from "./settingsTypes";

export function createEngine(
  s: LlmWikiSettings,
  repoRoot: string,
  secrets: { get(id: SecretId): string | null },
): Engine | { error: string } {
  if (s.engine === "api") {
    const apiKey = secrets.get("api-key");
    if (!apiKey) return { error: "No Anthropic API key set. Add one in the LLM Wiki Chat settings." };
    return new ApiEngine({ client: createAnthropicClient(apiKey), repoRoot, model: s.apiModel });
  }
  const env: Record<string, string> = {};
  const token = secrets.get("oauth-token");
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  if (s.useApiKeyForCli) {
    const apiKey = secrets.get("api-key");
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  }
  return new ClaudeCodeEngine({
    cliPath: s.cliPath,
    repoRoot,
    model: s.cliModel,
    maxBudgetUsd: s.maxBudgetUsd ?? undefined,
    env,
  });
}

/**
 * Hash of everything the engine built by createEngine depends on, for the selected engine
 * only. A changed fingerprint means the cached engine (and its conversation) is stale.
 */
export function engineFingerprint(
  s: LlmWikiSettings,
  repoRoot: string,
  secrets: { get(id: SecretId): string | null },
): string {
  const parts =
    s.engine === "api"
      ? ["api", repoRoot, s.apiModel, secrets.get("api-key")]
      : [
          "claude-code",
          repoRoot,
          s.cliPath,
          s.cliModel,
          s.maxBudgetUsd,
          s.useApiKeyForCli,
          secrets.get("oauth-token"),
          s.useApiKeyForCli ? secrets.get("api-key") : null,
        ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
