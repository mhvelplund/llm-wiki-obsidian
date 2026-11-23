import { FileSystemAdapter, Plugin, type WorkspaceLeaf } from "obsidian";
import type { Engine } from "./engine/Engine";
import { createEngine } from "./engine/createEngine";
import { resolveDefaultRepoRoot } from "./repo";
import { createSecrets, type Secrets } from "./secrets";
import { DEFAULT_SETTINGS, LlmWikiSettingTab, type LlmWikiSettings } from "./settings";
import { ChatView, VIEW_TYPE, type ChatAction } from "./view/ChatView";

export default class LlmWikiChatPlugin extends Plugin {
  settings: LlmWikiSettings = { ...DEFAULT_SETTINGS };
  secrets!: Secrets;
  /** Task 8 replaces this with the RunController/SaveModal wiring. */
  onAction: (a: ChatAction) => void = () => {};
  private engine: Engine | { error: string } | null = null;

  async onload(): Promise<void> {
    this.secrets = createSecrets(this.app);
    await this.loadSettings();
    this.addSettingTab(new LlmWikiSettingTab(this.app, this));

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new ChatView(leaf, this);
      view.onAction = (a) => this.onAction(a);
      return view;
    });
    this.addRibbonIcon("message-square", "Open wiki chat", () => void this.activateView());
    this.addCommand({ id: "open-chat", name: "Open wiki chat", callback: () => void this.activateView() });
    this.addCommand({ id: "save-last-answer", name: "Save last answer", callback: () => void this.runAction("save-last") });
    this.addCommand({ id: "save-synthesis", name: "Save synthesis", callback: () => void this.runAction("save-synthesis") });
    this.addCommand({ id: "ingest-sources", name: "Ingest sources", callback: () => void this.runAction("ingest") });
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
    this.onSettingsChanged();
  }

  /** Drop the cached engine (config or secrets changed) and refresh open chat views. */
  onSettingsChanged(): void {
    this.engine = null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshEngineUi();
    }
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

  /** The cached engine, so the conversation survives across turns. Errors are not cached. */
  getEngine(): Engine | { error: string } {
    if (this.engine === null || "error" in this.engine) this.engine = this.buildEngine();
    return this.engine;
  }

  private async activateView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  private async runAction(a: ChatAction): Promise<void> {
    const view = await this.activateView();
    view?.onAction(a);
  }
}
