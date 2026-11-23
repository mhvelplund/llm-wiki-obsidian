# LLM Wiki Chat

An Obsidian plugin that adds a Claude chat sidebar to an [llm-wiki](https://github.com/mhvelplund/llm-wiki) vault. Ask questions about your wiki, then save good answers back as wiki pages or ingest new sources.

Requires Obsidian 1.11.4 or newer, on desktop only (it runs local processes and reads your files).

## How it fits together

An llm-wiki repo has a `CLAUDE.md` at the root and a `wiki/` folder. You open `wiki/` as your Obsidian vault. The plugin treats the vault's parent folder as the repo root, so it can find `CLAUDE.md` and the `sources/` folder next to `wiki/`.

If your layout differs, set **Repository root** in the plugin settings. The settings page shows whether the chosen folder is a valid repo (it needs `CLAUDE.md` and `wiki/`).

## What it does

- **Chat.** Open the sidebar from the ribbon icon or the command "Open wiki chat". Chat is read-only: Claude can read and search the repo but cannot edit anything.
- **Save last answer / Save synthesis.** Writes a new wiki page from the last answer, or from the whole conversation. You pick the folder and file name. Writes go only under `wiki/`.
- **Ingest sources.** Runs the ingest workflow described in your `CLAUDE.md`. It can update pages under `wiki/`, pull the `sources/` submodules, and update `sha.log`. Ingest works only with the Claude Code engine.

Commands: "Open wiki chat", "Save last answer", "Save synthesis", "Ingest sources".

The plugin never commits. It blocks `git commit`, `push`, `reset` and `checkout`. Review changes with git and commit them yourself.

## Engines

Pick one in the settings.

- **Claude Code CLI** (default). Runs your installed `claude` program. Use this if you have a Claude subscription, and it is the only engine that can Ingest. Set **Claude CLI path** if `claude` is not on your PATH. It must point to a real executable such as `claude.exe`. Windows `.cmd` shims are not supported. Optional **Max budget (USD)** caps spending per run.
- **Anthropic API.** Calls the API directly with your API key. Use this if you have no Claude Code installation. Chat and Save work. Ingest does not.

## Authentication

For the Claude Code engine, any one of these works:

1. Be logged in already: run `claude` once in a terminal and sign in.
2. Run `claude setup-token` in a terminal and paste the token into **Claude Code OAuth token** in the settings.
3. Paste an API key and turn on **Use API key for CLI**.

For the API engine, paste an API key into **API key**.

Subscription sign-in works only through Claude Code. The Anthropic API accepts API keys, not subscription logins, so the API engine cannot use your subscription.

The API key and the OAuth token are stored in Obsidian's secret storage. They are never written to the plugin's `data.json`.

**Test connection** in the settings sends one short real request, so it uses a small amount of quota or credit.

## Install

Build from source:

```
mise install
pnpm install
pnpm build
pnpm test
```

`mise install` sets up the Node and pnpm versions from `mise.toml`. `pnpm build` produces `main.js`.

Then put `main.js`, `manifest.json` and `styles.css` in `<vault>/.obsidian/plugins/llm-wiki-chat/`. Copy them, or link the folder so rebuilds show up right away. On Windows, from a Command Prompt:

```
mklink /J "C:\path\to\repo\wiki\.obsidian\plugins\llm-wiki-chat" "C:\path\to\llm-wiki-obsidian"
```

Restart Obsidian (or reload plugins) and enable "LLM Wiki Chat" under Community plugins. For development, `pnpm dev` rebuilds on change.
