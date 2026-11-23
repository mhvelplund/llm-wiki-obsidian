import { ItemView, MarkdownRenderer, Notice, TFile, type WorkspaceLeaf, setTooltip } from "obsidian";
import type { EngineEvent } from "../engine/Engine";
import type LlmWikiChatPlugin from "../main";
import type { ControllerEvent, ReportEvent } from "../runController";
import { rewriteLinkForVault } from "./render";

async function* errorStream(message: string): AsyncIterable<EngineEvent> {
  yield { type: "error", message };
}

export const VIEW_TYPE = "llm-wiki-chat-view";
export const BUSY_MESSAGE = "A run is already in progress";

export type ChatAction = "save-last" | "save-synthesis" | "ingest";
export interface TranscriptEntry {
  role: "user" | "assistant" | "report";
  text: string;
}

const RENDER_INTERVAL_MS = 100;
/** How long to wait for the vault to index a page a run just created before giving up. */
const OPEN_RETRY_MS = 1000;
const OPEN_POLL_MS = 100;
const INGEST_DISABLED_TIP = "Requires the Claude Code engine";

export class ChatView extends ItemView {
  transcript: TranscriptEntry[] = [];
  onAction: (a: ChatAction) => void = () => {};

  private messagesEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private actionBtns = new Map<ChatAction, HTMLButtonElement>();
  private abort: AbortController | null = null;
  /** Bumped by New chat; a run whose generation is stale must not touch transcript or DOM. */
  private generation = 0;
  private runPromise: Promise<void> | null = null;
  private pendingReset: Promise<void> = Promise.resolve();
  /** Latest render request per element, so a slow earlier render cannot overwrite a later one. */
  private renderSeq = new WeakMap<HTMLElement, number>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: LlmWikiChatPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Wiki chat";
  }
  getIcon(): string {
    return "message-square";
  }

  lastAnswer(): string | null {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const e = this.transcript[i]!;
      if (e.role === "assistant") return e.text;
    }
    return null;
  }

  appendReport(md: string): void {
    this.transcript.push({ role: "report", text: md });
    const el = this.messagesEl.createDiv({ cls: "llm-wiki-msg llm-wiki-report" });
    void this.renderMarkdown(el, md);
    this.scrollToEnd();
  }

  /** True while a run started in this pane is in flight (until it ends or is discarded). */
  get running(): boolean {
    return this.abort !== null;
  }

  /** Called by the plugin when settings change: update badge and ingest availability. */
  refreshEngineUi(): void {
    if (!this.badgeEl) return;
    this.badgeEl.setText(this.plugin.settings.engine === "api" ? "Anthropic API" : "Claude Code");
    this.refreshControls();
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("llm-wiki-chat");

    const header = root.createDiv({ cls: "llm-wiki-header" });
    header.createSpan({ cls: "llm-wiki-title", text: "Wiki chat" });
    this.badgeEl = header.createSpan({ cls: "llm-wiki-badge" });
    const newBtn = header.createEl("button", { cls: "llm-wiki-new", text: "New chat" });
    newBtn.addEventListener("click", () => this.newChat());

    this.messagesEl = root.createDiv({ cls: "llm-wiki-messages" });
    // Capture phase so we run before Obsidian's own link handling.
    this.registerDomEvent(this.messagesEl, "click", (e) => this.onLinkClick(e), true);

    const footer = root.createDiv({ cls: "llm-wiki-footer" });
    const actions = footer.createDiv({ cls: "llm-wiki-actions" });
    const defs: [ChatAction, string][] = [
      ["save-last", "Save last answer"],
      ["save-synthesis", "Save synthesis"],
      ["ingest", "Ingest sources"],
    ];
    for (const [action, label] of defs) {
      const btn = actions.createEl("button", { text: label });
      btn.addEventListener("click", () => this.onAction(action));
      this.actionBtns.set(action, btn);
    }

    const inputRow = footer.createDiv({ cls: "llm-wiki-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "llm-wiki-input",
      attr: { rows: "3", placeholder: "Ask the wiki..." },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendOrStop();
      }
    });
    this.sendBtn = inputRow.createEl("button", { cls: "mod-cta llm-wiki-send", text: "Send" });
    this.sendBtn.addEventListener("click", () => this.sendOrStop());

    this.refreshEngineUi();
  }

  async onClose(): Promise<void> {
    // A reopened, empty pane must not silently resume this conversation.
    this.discardConversation();
  }

  private refreshControls(): void {
    if (!this.sendBtn) return;
    const running = this.running;
    this.sendBtn.setText(running ? "Stop" : "Send");
    this.sendBtn.toggleClass("mod-warning", running);
    this.sendBtn.toggleClass("mod-cta", !running);
    const apiEngine = this.plugin.settings.engine === "api";
    for (const [action, btn] of this.actionBtns) {
      btn.disabled = running || (action === "ingest" && apiEngine);
      if (action === "ingest") setTooltip(btn, apiEngine ? INGEST_DISABLED_TIP : "Run the ingest workflow");
    }
  }

  private newChat(): void {
    this.discardConversation();
    this.transcript = [];
    this.messagesEl.empty();
    this.refreshControls();
  }

  /** Called by the plugin when it replaced the engine: the old conversation is gone. */
  startNewConversation(note: string): void {
    this.newChat();
    this.showNote(note);
  }

  /** Stops any run, ignores its output, and resets the engine's session once it has drained. */
  private discardConversation(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    // Reset only after the aborted run has finished draining, so it cannot corrupt the fresh session.
    const draining = this.runPromise;
    this.pendingReset = (async () => {
      await draining?.catch(() => {});
      this.plugin.resetConversation();
    })();
  }

  private sendOrStop(): void {
    if (this.abort) {
      this.abort.abort();
      return;
    }
    const prompt = this.inputEl.value.trim();
    if (prompt === "") return;
    this.plugin.syncEngine();
    this.inputEl.value = "";
    this.transcript.push({ role: "user", text: prompt });
    this.messagesEl.createDiv({ cls: "llm-wiki-msg llm-wiki-user" }).createDiv({
      cls: "llm-wiki-bubble",
      text: prompt,
    });
    this.scrollToEnd();
    void this.runStream((signal) => {
      const c = this.plugin.getController();
      return "error" in c ? errorStream(c.error) : c.chat(prompt, signal);
    }, true);
  }

  /**
   * Streams one run (chat, save or ingest) into the pane. Chat answers are recorded in the
   * transcript; save/ingest runs end in a report (appended via appendReport) instead.
   */
  runStream(start: (signal: AbortSignal) => AsyncIterable<ControllerEvent>, record: boolean): Promise<void> {
    if (this.running) {
      this.showError(BUSY_MESSAGE);
      return Promise.resolve();
    }
    const gen = this.generation;
    const abort = new AbortController();
    this.abort = abort; // set synchronously so Stop works and double sends are blocked
    this.refreshControls();
    const run = (async () => {
      await this.pendingReset;
      if (gen !== this.generation) return;
      try {
        await this.streamAnswer(start(abort.signal), record, gen);
      } catch (e) {
        if (gen === this.generation) this.showError(e instanceof Error ? e.message : String(e));
      }
    })();
    this.runPromise = run;
    return (async () => {
      try {
        await run;
      } finally {
        if (this.abort === abort) this.abort = null;
        if (this.runPromise === run) this.runPromise = null;
        this.refreshControls();
      }
    })();
  }

  private async streamAnswer(events: AsyncIterable<ControllerEvent>, record: boolean, gen: number): Promise<void> {
    const msgEl = this.messagesEl.createDiv({ cls: "llm-wiki-msg llm-wiki-assistant" });
    let toolsEl: HTMLDetailsElement | null = null;
    let summaryEl: HTMLElement | null = null;
    let toolListEl: HTMLElement | null = null;
    let toolCount = 0;
    const bodyEl = msgEl.createDiv({ cls: "llm-wiki-body" });
    let text = "";
    let lastRender = 0;
    let timer: number | null = null;
    const render = () => {
      timer = null;
      lastRender = Date.now();
      void this.renderMarkdown(bodyEl, text);
      this.scrollToEnd();
    };
    const schedule = () => {
      if (timer !== null) return;
      const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRender));
      timer = window.setTimeout(render, wait);
    };

    let terminal: EngineEvent | null = null;
    let report: ReportEvent | null = null;
    try {
      for await (const ev of events) {
        if (ev.type === "report") {
          report = ev;
        } else if (ev.type === "text-delta") {
          text += ev.text;
          schedule();
        } else if (ev.type === "tool-activity") {
          if (!toolsEl) {
            toolsEl = createEl("details", { cls: "llm-wiki-tools" });
            msgEl.insertBefore(toolsEl, bodyEl);
            summaryEl = toolsEl.createEl("summary");
            toolListEl = toolsEl.createEl("ul");
          }
          toolCount++;
          summaryEl!.setText(`Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`);
          toolListEl!.createEl("li", { text: ev.label });
        } else {
          terminal = ev;
        }
      }
    } finally {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    }
    if (gen !== this.generation) return; // New chat happened mid-run: discard everything

    if (!record) {
      // The report carries the final text, so drop the streamed body (keep tool activity).
      bodyEl.remove();
      if (!toolsEl) msgEl.remove();
      if (terminal?.type === "error") this.showError(terminal.message);
      if (report) {
        this.appendReport(report.markdown);
        if (report.openPath) void this.openCreatedPage(report.openPath);
      }
      return;
    }
    if (terminal?.type === "error") {
      if (text === "") msgEl.remove();
      else await this.renderMarkdown(bodyEl, text);
      this.showError(terminal.message);
      return;
    }
    const cancelled = terminal?.type === "done" && terminal.cancelled === true;
    const finalText = terminal?.type === "done" && terminal.text !== "" ? terminal.text : text;
    if (finalText === "") {
      msgEl.remove();
      if (cancelled) this.showNote("Stopped.");
      return;
    }
    await this.renderMarkdown(bodyEl, finalText);
    this.transcript.push({ role: "assistant", text: finalText });
    if (cancelled) msgEl.createDiv({ cls: "llm-wiki-note", text: "Stopped." });
    this.scrollToEnd();
  }

  showError(message: string): void {
    this.messagesEl.createDiv({ cls: "llm-wiki-msg llm-wiki-error" }).createDiv({
      cls: "llm-wiki-bubble",
      text: message,
    });
    this.scrollToEnd();
  }

  private showNote(text: string): void {
    this.messagesEl.createDiv({ cls: "llm-wiki-msg llm-wiki-note", text });
  }

  private async renderMarkdown(el: HTMLElement, md: string): Promise<void> {
    const seq = (this.renderSeq.get(el) ?? 0) + 1;
    this.renderSeq.set(el, seq);
    const tmp = createDiv();
    await MarkdownRenderer.render(this.app, md, tmp, "", this);
    if (this.renderSeq.get(el) !== seq) return; // a newer render of this element won
    el.replaceChildren(...Array.from(tmp.childNodes));
  }

  private isPage(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  /** Opens a page a run just wrote, waiting briefly for the vault to index it. Never creates a note. */
  private async openCreatedPage(path: string): Promise<void> {
    for (let waited = 0; !this.isPage(path); waited += OPEN_POLL_MS) {
      if (waited >= OPEN_RETRY_MS) {
        new Notice(`Page not found: ${path}`);
        return;
      }
      await sleep(OPEN_POLL_MS);
    }
    await this.app.workspace.openLinkText(path, "", true);
  }

  /** Answers link relative to the wiki; open them as vault pages. */
  private onLinkClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement | null)?.closest("a");
    if (!a) return;
    const href = a.getAttribute("data-href") ?? a.getAttribute("href");
    if (!href) return;
    const target = rewriteLinkForVault(href, "index.md");
    if (target === null) return; // external: default handling
    e.preventDefault();
    e.stopPropagation();
    // Never let a hallucinated link create a note: only open pages that exist.
    const path = target.split("#")[0]!;
    if (!this.isPage(path)) {
      new Notice(`Page not found: ${path}`);
      return;
    }
    void this.app.workspace.openLinkText(target, "", e.ctrlKey || e.metaKey);
  }

  private scrollToEnd(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
