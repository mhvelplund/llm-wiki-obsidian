import type { App } from "obsidian";
import type { SecretId } from "./engine/settingsTypes";

export type { SecretId };

export interface Secrets {
  /** null when unset or cleared (an empty value counts as unset). */
  get(id: SecretId): string | null;
  /** "" clears the secret. */
  set(id: SecretId, value: string): void;
}

const PREFIX = "llm-wiki-chat-";

export function createSecrets(app: App): Secrets {
  return {
    get: (id) => app.secretStorage.getSecret(PREFIX + id) || null,
    set: (id, value) => app.secretStorage.setSecret(PREFIX + id, value),
  };
}
