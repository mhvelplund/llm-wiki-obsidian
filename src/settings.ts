import { execFile } from "node:child_process";
import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LlmWikiChatPlugin from "./main";
import { validateRepo } from "./repo";
import { ClaudeCodeEngine } from "./engine/ClaudeCodeEngine";
import { createAnthropicClient } from "./engine/ApiEngine";
import { createEngine } from "./engine/createEngine";
import { DEFAULT_SETTINGS, type LlmWikiSettings, type SecretId } from "./engine/settingsTypes";

export { DEFAULT_SETTINGS };
export type { LlmWikiSettings };

function cliVersion(cliPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, ["--version"], { timeout: 15000, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const KEY_DESC = "Stored in Obsidian secret storage, never in data.json.";

export class LlmWikiSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LlmWikiChatPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl).setName("Engine").addDropdown((d) =>
      d
        .addOption("claude-code", "Claude Code CLI")
        .addOption("api", "Anthropic API")
        .setValue(p.settings.engine)
        .onChange(async (v) => {
          p.settings.engine = v as LlmWikiSettings["engine"];
          await p.saveSettings();
          this.display();
        }),
    );

    const repoSetting = new Setting(containerEl)
      .setName("Repository root")
      .setDesc("Leave empty to use the parent folder of the vault.");
    const validity = containerEl.createDiv({ cls: "setting-item-description" });
    const refreshValidity = () => {
      const v = validateRepo(p.getRepoRoot());
      validity.setText(v.ok ? `Valid repository: ${p.getRepoRoot()}` : `Invalid: ${v.reason}`);
    };
    repoSetting.addText((t) =>
      t.setValue(p.settings.repoRoot).onChange(async (v) => {
        p.settings.repoRoot = v.trim();
        await p.saveSettings();
        refreshValidity();
      }),
    );
    refreshValidity();

    if (p.settings.engine === "api") {
      new Setting(containerEl).setName("API model").addText((t) =>
        t.setValue(p.settings.apiModel).onChange(async (v) => {
          p.settings.apiModel = v.trim();
          await p.saveSettings();
        }),
      );
      this.secretSetting("API key", "api-key", KEY_DESC);
    } else {
      new Setting(containerEl).setName("Claude CLI path").addText((t) =>
        t.setValue(p.settings.cliPath).onChange(async (v) => {
          p.settings.cliPath = v.trim();
          await p.saveSettings();
        }),
      );
      new Setting(containerEl).setName("CLI model").addText((t) =>
        t.setValue(p.settings.cliModel).onChange(async (v) => {
          p.settings.cliModel = v.trim();
          await p.saveSettings();
        }),
      );
      new Setting(containerEl)
        .setName("Max budget (USD)")
        .setDesc("Optional per-run spending cap. Empty for none.")
        .addText((t) =>
          t.setValue(p.settings.maxBudgetUsd === null ? "" : String(p.settings.maxBudgetUsd)).onChange(async (v) => {
            const n = Number(v);
            p.settings.maxBudgetUsd = v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
            await p.saveSettings();
          }),
        );
      this.secretSetting(
        "Claude Code OAuth token",
        "oauth-token",
        "Run `claude setup-token` in a terminal and paste the token",
      );
      new Setting(containerEl)
        .setName("Use API key for CLI")
        .setDesc("Pass the stored API key (ANTHROPIC_API_KEY) to the CLI as well.")
        .addToggle((t) =>
          t.setValue(p.settings.useApiKeyForCli).onChange(async (v) => {
            p.settings.useApiKeyForCli = v;
            await p.saveSettings();
            this.display();
          }),
        );
      if (p.settings.useApiKeyForCli) this.secretSetting("API key", "api-key", KEY_DESC);
    }

    new Setting(containerEl).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        b.setDisabled(true);
        try {
          new Notice(await this.testConnection(), 8000);
        } finally {
          b.setDisabled(false);
        }
      }),
    );
  }

  /** Password input that writes only to Secrets (SecretStorage); never to plugin data. */
  private secretSetting(name: string, id: SecretId, desc: string): void {
    const has = this.plugin.secrets.get(id) !== null;
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(has ? `${desc} (a value is stored)` : desc)
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(has ? "stored; type to replace" : "").onChange((v) => {
          if (v) this.plugin.secrets.set(id, v);
        });
      });
  }

  private async testConnection(): Promise<string> {
    const p = this.plugin;
    const s = p.settings;
    try {
      if (s.engine === "api") {
        const key = p.secrets.get("api-key");
        if (!key) return "No API key set.";
        await createAnthropicClient(key).models.list({ limit: 1 });
        return "API connection OK.";
      }
      const version = await cliVersion(s.cliPath);
      const built = createEngine(s, p.getRepoRoot(), p.secrets);
      if (!(built instanceof ClaudeCodeEngine)) return "error" in built ? built.error : "Unexpected engine.";
      let text = "";
      const signal = AbortSignal.timeout(120000);
      for await (const ev of built.run({ kind: "chat", prompt: "Reply with OK", signal })) {
        if (ev.type === "error") return `CLI ${version}: ${ev.message}`;
        if (ev.type === "done") text = ev.text;
      }
      return `CLI ${version} OK. Reply: ${text.slice(0, 80)}`;
    } catch (e) {
      return `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
