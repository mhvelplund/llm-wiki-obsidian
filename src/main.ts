import { FileSystemAdapter, Plugin } from "obsidian";
import type { Engine } from "./engine/Engine";
import { createEngine } from "./engine/createEngine";
import { resolveDefaultRepoRoot } from "./repo";
import { createSecrets, type Secrets } from "./secrets";
import { DEFAULT_SETTINGS, LlmWikiSettingTab, type LlmWikiSettings } from "./settings";

export default class LlmWikiChatPlugin extends Plugin {
  settings: LlmWikiSettings = { ...DEFAULT_SETTINGS };
  secrets!: Secrets;

  async onload(): Promise<void> {
    this.secrets = createSecrets(this.app);
    await this.loadSettings();
    this.addSettingTab(new LlmWikiSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    // Pick only known keys so stray data.json fields are dropped.
    const data = ((await this.loadData()) ?? {}) as Partial<LlmWikiSettings>;
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof LlmWikiSettings)[]) {
      if (data[k] !== undefined) s[k] = data[k];
    }
    this.settings = s as unknown as LlmWikiSettings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings); // LlmWikiSettings has no secret fields
  }

  getRepoRoot(): string {
    if (this.settings.repoRoot) return this.settings.repoRoot;
    const adapter = this.app.vault.adapter;
    const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
    return resolveDefaultRepoRoot(base);
  }

  buildEngine(): Engine | { error: string } {
    return createEngine(this.settings, this.getRepoRoot(), this.secrets);
  }
}
