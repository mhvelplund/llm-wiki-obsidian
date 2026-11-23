import type { App } from "obsidian";
import type { SecretId } from "./engine/settingsTypes";

export type { SecretId };

export interface Secrets {
  get(id: SecretId): string | null;
  set(id: SecretId, value: string): void;
}

const PREFIX = "llm-wiki-chat-";

export function createSecrets(app: App): Secrets {
  return {
    get: (id) => app.secretStorage.getSecret(PREFIX + id),
    set: (id, value) => app.secretStorage.setSecret(PREFIX + id, value),
  };
}
