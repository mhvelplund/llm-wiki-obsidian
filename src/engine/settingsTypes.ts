// Obsidian-free so createEngine can be unit tested under Node. Re-exported from ../settings.
export interface LlmWikiSettings {
  engine: "api" | "claude-code";
  /** "" means the vault parent at runtime. */
  repoRoot: string;
  apiModel: string;
  cliPath: string;
  cliModel: string;
  maxBudgetUsd: number | null;
  useApiKeyForCli: boolean;
}

export type SecretId = "api-key" | "oauth-token";

export const DEFAULT_SETTINGS: LlmWikiSettings = {
  engine: "claude-code",
  repoRoot: "",
  apiModel: "claude-sonnet-5-5",
  cliPath: "claude",
  cliModel: "sonnet",
  maxBudgetUsd: null,
  useApiKeyForCli: false,
};
