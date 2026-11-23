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
