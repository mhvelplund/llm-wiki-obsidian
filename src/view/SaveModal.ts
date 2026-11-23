import { type App, Modal, Setting } from "obsidian";
import { slugify } from "../repo";
import { planSave } from "../runController";

/** Slug of the answer's first heading, else of its first 6 words. */
export function suggestName(answer: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(answer);
  const source = heading ? heading[1]! : answer.trim().split(/\s+/).slice(0, 6).join(" ");
  return slugify(source);
}

export class SaveModal extends Modal {
  private folder: string;
  private newFolder = "";
  private name: string;

  constructor(
    app: App,
    private readonly folders: string[],
    suggestedName: string,
    private readonly onSubmit: (folder: string, name: string) => void,
    private readonly root: string,
  ) {
    super(app);
    this.folder = folders.includes("") ? "" : (folders[0] ?? "");
    this.name = suggestedName;
  }

  private chosenFolder(): string {
    const typed = this.newFolder
      .split("/")
      .map((s) => slugify(s))
      .filter((s) => s !== "")
      .join("/");
    return typed !== "" ? typed : this.folder;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Save to wiki");

    new Setting(contentEl).setName("Folder").addDropdown((dd) => {
      for (const f of this.folders) dd.addOption(f, f === "" ? "wiki/ (root)" : f);
      dd.setValue(this.folder).onChange((v) => {
        this.folder = v;
        update();
      });
    });
    new Setting(contentEl)
      .setName("New folder…")
      .setDesc("Optional. Overrides the folder above.")
      .addText((t) =>
        t.setPlaceholder("new-folder").onChange((v) => {
          this.newFolder = v;
          update();
        }),
      );
    new Setting(contentEl).setName("Page name").addText((t) =>
      t.setValue(this.name).onChange((v) => {
        this.name = v.trim();
        update();
      }),
    );
    const errorEl = contentEl.createDiv({ cls: "llm-wiki-modal-error" });
    let saveBtn!: HTMLButtonElement;
    new Setting(contentEl).addButton((b) => {
      b.setButtonText("Save").setCta().onClick(() => {
        this.close();
        this.onSubmit(this.chosenFolder(), this.name);
      });
      saveBtn = b.buttonEl;
    });

    const update = (): void => {
      const plan = planSave(this.root, this.chosenFolder(), this.name);
      const err = "error" in plan ? plan.error : "";
      errorEl.setText(err);
      saveBtn.disabled = err !== "";
    };
    update();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
