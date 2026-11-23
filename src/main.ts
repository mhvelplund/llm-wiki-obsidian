import { FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import type { Engine } from "./engine/Engine";
import { createEngine } from "./engine/createEngine";
import { listWikiFolders, resolveDefaultRepoRoot, validateRepo } from "./repo";
import { RunController } from "./runController";
import { createSecrets, type Secrets } from "./secrets";
import { DEFAULT_SETTINGS, LlmWikiSettingTab, type LlmWikiSettings } from "./settings";
import { ChatView, VIEW_TYPE, type ChatAction } from "./view/ChatView";
import { SaveModal, suggestName } from "./view/SaveModal";

export default class LlmWikiChatPlugin extends Plugin {
  settings: LlmWikiSettings = { ...DEFAULT_SETTINGS };
  secrets!: Secrets;
  private engine: Engine | { error: string } | null = null;
  private controller: { engine: Engine; controller: RunController } | null = null;

  async onload(): Promise<void> {
    this.secrets = createSecrets(this.app);
    await this.loadSettings();
    this.addSettingTab(new LlmWikiSettingTab(this.app, this));

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new ChatView(leaf, this);
      view.onAction = (a) => void this.handleAction(view, a);
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

  /** One controller per cached engine, so chat, save and ingest share one busy guard. */
  getController(): RunController | { error: string } {
    const engine = this.getEngine();
    if ("error" in engine) return engine;
    if (this.controller?.engine !== engine) {
      this.controller = { engine, controller: new RunController(engine, this.getRepoRoot()) };
    }
    return this.controller.controller;
  }

  private async handleAction(view: ChatView, a: ChatAction): Promise<void> {
    if (a === "ingest" && this.settings.engine === "api") {
      const msg = "Ingest requires the Claude Code engine";
      new Notice(msg);
      view.showError(msg);
      return;
    }
    const controller = this.getController();
    if ("error" in controller) return view.showError(controller.error);
    if (controller.busy) return view.showError("A run is already in progress");
    if (a === "ingest") {
      void view.runStream((signal) => controller.ingest(signal), false);
      return;
    }
    const root = this.getRepoRoot();
    const repo = validateRepo(root);
    if (!repo.ok) return view.showError(repo.reason);
    let lastAnswer: string | undefined;
    if (a === "save-last") {
      lastAnswer = view.lastAnswer() ?? undefined;
      if (lastAnswer === undefined) {
        new Notice("No answer to save yet");
        return;
      }
    } else if (view.transcript.length === 0) {
      new Notice("Nothing to synthesize yet");
      return;
    }
    const suggested = lastAnswer !== undefined ? suggestName(lastAnswer) : "";
    new SaveModal(
      this.app,
      listWikiFolders(root),
      suggested,
      (folder, name) => {
        void view.runStream(
          (signal) =>
            controller.save({ source: a === "save-last" ? "last" : "synthesis", lastAnswer, folder, name }, signal),
          false,
        );
      },
      root,
    ).open();
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
    if (view) await this.handleAction(view, a);
  }
}
