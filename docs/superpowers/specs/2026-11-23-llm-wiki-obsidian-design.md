# LLM Wiki Obsidian plugin — design

## Context / why

The [llm-wiki] template lets Claude build and maintain a wiki from external repos (`/add-source`, the CLAUDE.md
ingest + lint workflow, scheduled GitHub workflows). The generated `wiki/` folder can be browsed as an Obsidian vault
(demo: `C:\Users\mandr\Documents\Projects\stl-browser-wiki\wiki`), but there's no way to ask Claude about the wiki, or
grow it, from inside Obsidian. This plugin adds a Claude chat to Obsidian that answers questions from the wiki and can
turn answers into new, properly linked and linted wiki pages, always following the repo's CLAUDE.md.

## Goals

- Chat pane in Obsidian (ribbon button + command palette "Open wiki chat") — Claude.ai-style conversation, streamed.
- Answers come from the wiki per CLAUDE.md "Question answering": read `wiki/index.md` first, then `wiki/`, fall back to
  `sources/`; cite pages; say when the answer isn't there.
- Buttons: **Save last answer**, **Save synthesis** (of whole conversation) → new article at a user-chosen place in
  `wiki/`, then link it into related pages (minimum: root `wiki/index.md`), update folder `index.md`s, run CLAUDE.md lint.
- Button/command: **Ingest sources** — runs the full CLAUDE.md ingest workflow ("Update the wiki and lint it.") on demand.
- Two engines, switchable in settings:
  - **Direct API** — API key, Claude Sonnet via Messages API.
  - **Claude Code** — drives the user's installed `claude` CLI, so subscription (Pro/Max) login works.

## Non-goals

- No git commits/pushes — changes are left uncommitted (matches the repo's skills).
- No mobile support (`isDesktopOnly: true`; needs Node fs/child_process).
- No `/add-source` / `/remove-source` from the plugin.
- No persistence of chats across Obsidian restarts (in-memory; "New chat" clears). *(my call)*
- Not bundled into the llm-wiki template (user: not everyone using llm-wiki wants Obsidian). The plugin lives in its own
  repo `C:\Users\mandr\Documents\Projects\llm-wiki-obsidian`; installed manually (copy/symlink build into
  `<vault>/.obsidian/plugins/llm-wiki-chat/`), documented in its README. Community-directory submission is out of scope
  for now, but the layout follows obsidian-sample-plugin conventions so it can be added later. *(my call)*

## Distribution & secrets (settled after builder check)

- **Secrets**: API key and Claude Code OAuth token are stored **only** via Obsidian `SecretStorage` (set
  `minAppVersion` accordingly); no plaintext fallback in `data.json`. *(my call)* `.obsidian` is already in the
  template's `.gitignore`. Search tool and lint prompts exclude `wiki/.obsidian/`.
- **Ingest & git**: Ingest follows CLAUDE.md, so locally it pulls submodules (no `GH_PAT`), which updates `sources/`
  checkouts and submodule pointers — accepted for ingest only. Bash allowlist is narrow: read-only git
  (`git status`, `git log`, `git diff`, `git rev-parse`, `git -C sources/* log/diff`) plus
  `git submodule update --remote --init`; **no** commit/push/reset/checkout. *(my call, from CLAUDE.md)*
- API engine sandbox: reads also allowed for `sha.log`, `.gitmodules`, `CLAUDE.md` at repo root.

## Anti-goals (would be a failure even if it "works")

- Writing `[[wikilinks]]` or YAML frontmatter — wiki uses relative Markdown links (`[name](../x/y.md)`) and the bold-label
  header format from CLAUDE.md. Must be correct in **both** engines.
- Touching `sources/` (CLAUDE.md: never modify).
- Plugin minting/using subscription OAuth tokens against the API directly (not permitted for third-party apps).
  Subscription use goes only through the official Claude Code CLI.
- Chat turns silently editing files — only Save/Ingest may write.

## Constraints found in the repos

- CLAUDE.md, `sources/`, `sha.log`, `.claude/skills/`, `tools/*.mts` live at the **repo root, one level above the vault**.
  Setting `repoRoot` defaults to the vault's parent folder; valid iff it contains `CLAUDE.md` and `wiki/`.
- "Lint" has no tool: it's a Claude procedure in CLAUDE.md (auto-fix: alphabetical link lists / Related pages; report:
  contradictions, orphans, missing concept pages, outdated claims, format breaks). Helper scripts exist and may be used
  by Claude: `node --experimental-strip-types tools/find-orphans.mts` etc. (Node 24 per `mise.toml`).
- Page format (CLAUDE.md): `# Title`, `**Summary**:`, `**Sources**:` (deep links at exact SHA), `**Last updated**:`
  (date + SHA link), `---`, body with `(source: file)` citations, `## Related pages` (alphabetical). Names
  lowercase-with-hyphens. Every folder has `index.md` (except `wiki/img/`); new folder ⇒ create its `index.md`.

## Approaches considered

1. **Claude Code engine only** — simplest, gets CLAUDE.md/tools/skills free, works with subscription; needs CLI installed.
2. **Direct API only** — no CLI dependency, but API key only and we build the agent loop/tools ourselves.
3. **Both, switchable** ← **chosen by user.** Shared UI + save/ingest flows over an `Engine` interface; most flexible,
   roughly double the backend code.

Within Claude Code mode, spawning the user's `claude` binary was chosen over the Claude Agent SDK *(my call)*: the Agent
SDK can't legitimately use subscription login inside a third-party product; running the user's own Claude Code can.

## Design

### Architecture (TypeScript, Obsidian plugin, esbuild — from obsidian-sample-plugin layout)

```
src/
  main.ts                 Plugin: register view, ribbon icon, commands, settings tab
  settings.ts             Settings model + SettingTab (incl. "Test connection")
  view/ChatView.ts        ItemView in right sidebar: message list, input, action buttons, cancel
  view/SaveModal.ts       Folder picker (wiki folders + "new folder…") + page name
  engine/Engine.ts        interface Engine { chat(), runTask(), cancel(), reset() } → async iterable of events
  engine/ApiEngine.ts     @anthropic-ai/sdk Messages API + own tool loop
  engine/ClaudeCodeEngine.ts  spawn `claude -p … --output-format stream-json`, parse events
  engine/tools.ts         Repo-sandboxed fs tools for ApiEngine
  prompts.ts              Prompt builders for chat / save-last / save-synthesis / ingest
  repo.ts                 repoRoot resolution + validation, wiki folder listing
```

Events from engines (shared): `text-delta`, `tool-activity` (e.g. "Reading wiki/…/x.md", "Editing …"), `done`
(final text, files changed), `error`. The view renders these the same regardless of engine.

### Chat pane (right sidebar ItemView; can be dragged to a main tab)

- Header: title, engine badge, **New chat**.
- Messages: user bubbles; assistant replies rendered with `MarkdownRenderer.render` (streamed, re-rendered on deltas,
  throttled). Relative `.md` links in answers open the corresponding vault file. Tool activity shown as small collapsed
  status lines (like Claude.ai's "Read 3 files").
- Footer: **Save last answer**, **Save synthesis**, **Ingest sources**, input box (Enter = send, Shift+Enter newline),
  Send/Stop button (Stop cancels the running request/process).
- Save/ingest results appear in the chat as a run report: files created/modified + numbered lint findings.
  After save, the new page opens in a new tab.

### Engines

**Direct API (`ApiEngine`)**
- `@anthropic-ai/sdk`, model setting default `claude-sonnet-5-5`, streaming, adaptive thinking (default), `effort`
  `medium` for chat / `high` for save & ingest. Enable server-side refusal fallback (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`) and tell the user it's on. Check `stop_reason` (`refusal`, `max_tokens`).
- System prompt = plugin preamble + full CLAUDE.md text (cached with `cache_control`); tools deterministic and stable.
- Own tool loop (manual loop or SDK tool runner — builder's call) with tools in `tools.ts`:
  `list_dir`, `read_file`, `search` (literal/regex over repo text files, excludes `.git`, `node_modules`),
  and for save only: `write_file`, `edit_file` (str_replace). All paths resolved inside `repoRoot`; reads allowed in
  `wiki/` and `sources/`; writes allowed **only** in `wiki/`; anything else returns a tool error.
- Chat history kept in memory as SDK `MessageParam[]` (append full `response.content`).
- **Ingest is disabled in API mode** (button greyed with tooltip "requires Claude Code engine") — it needs git
  submodule pulls/diffs and shell. *(my call)*

**Claude Code (`ClaudeCodeEngine`)**
- `spawn(claudePath, args, { cwd: repoRoot, env })`; parse newline-delimited `stream-json`
  (`--output-format stream-json --verbose --include-partial-messages` for deltas); `--model` setting default `sonnet`.
- Conversation continuity: capture `session_id` from the init event, pass `--resume <id>` on next turn; New chat drops it.
  Save/ingest run in the same session (so "last answer"/"synthesis" has context).
- Permissions per run type (non-interactive; anything not allowed is denied):
  - chat: `--allowedTools Read Glob Grep` + `--disallowedTools Edit Write Bash` (read-only).
  - save: add `Edit Write`, `--permission-mode acceptEdits`, plus `Bash(node --experimental-strip-types tools/*)`.
  - ingest: additionally the narrow git allowlist from "Distribution & secrets". Optional `--max-budget-usd` from
    settings.
  - The plugin preamble is passed via `--append-system-prompt`; Claude Code loads CLAUDE.md itself.
- Auth: whatever the CLI is logged in with. Optional setting **Claude Code OAuth token** (from `claude setup-token`) is
  passed only to the child process as `CLAUDE_CODE_OAUTH_TOKEN`. Optional API key here is passed as `ANTHROPIC_API_KEY`
  only if the user enables it.
- Cancel = kill the child process (process tree on Windows).

### Prompts (`prompts.ts`)

- Plugin preamble (both engines): "You are running inside the Obsidian plugin for this wiki. Follow CLAUDE.md. Links
  are relative Markdown links with `.md`, never `[[wikilinks]]`, no YAML frontmatter. Never modify `sources/`."
- Chat: user's text as-is (CLAUDE.md's Question answering rules apply). Chat preamble adds: "Do not modify files; if an
  answer is worth keeping, say the user can save it."
- Save last answer / Save synthesis: target path `wiki/<folder>/<name>.md` (+ "create folder index.md" if new folder),
  the content basis (last assistant message verbatim, or "synthesize the conversation so far"), then steps:
  1. Write the page in CLAUDE.md page format. Sources = source files/wiki pages actually relied on (source links at the
     SHA from `sha.log`); Last updated = today + that SHA.
  2. Add prose links + `## Related pages` entries both ways with related pages; if none fit, link from `wiki/index.md`.
  3. Update the containing folder's `index.md` and `wiki/index.md` as CLAUDE.md requires.
  4. Run the CLAUDE.md lint over the whole wiki: apply auto-fixes; report the rest as a numbered list.
  5. End with a summary: files created/modified, lint findings.
- Ingest: "Update the wiki and lint it." (the same prompt the scheduled workflow uses).

### Settings

| Setting | Default | Notes |
|---|---|---|
| Engine | Claude Code | `api` \| `claude-code` |
| Repo root | vault parent | validated (CLAUDE.md + wiki/ present), shown green/red |
| API key | — | API engine; stored only via Obsidian `SecretStorage` |
| API model | `claude-sonnet-5-5` | |
| Claude CLI path | `claude` | resolved on PATH; Browse… |
| CLI model | `sonnet` | |
| Claude Code OAuth token | — | optional; `SecretStorage`; instructions: run `claude setup-token` |
| Max budget per run (USD) | empty | CLI engine only |

"Test connection" button: API → tiny request; CLI → `claude --version` + a 1-turn `-p` ping; shows auth errors clearly.

## Left to the builder

- Manual tool loop vs SDK tool runner for ApiEngine; exact stream-json event handling details.
- Throttling/streaming render strategy; CSS (match Obsidian theme variables, light/dark).
- Windows process spawning specifics (`claude.exe` vs `.cmd` shim, tree-kill).
- How the SaveModal suggests a default page name (e.g. from first heading of the answer, slugified).

## Implementation outline (next: superpowers:writing-plans turns this into a detailed plan)

0. Save this design as `docs/superpowers/specs/2026-11-23-llm-wiki-obsidian-design.md` in
   `C:\Users\mandr\Documents\Projects\llm-wiki-obsidian` (git init that folder first), commit.
1. Scaffold plugin (manifest `isDesktopOnly: true`, esbuild, tsconfig, vitest, eslint), `pnpm` per user's mise setup.
2. `repo.ts` + `tools.ts` with sandbox tests (path traversal, write outside `wiki/`, `sources/` read-only).
3. Engine interface + `ClaudeCodeEngine` (stream-json parser unit-tested against recorded fixtures).
4. `ApiEngine` with tool loop (unit-tested with a mocked SDK client).
5. ChatView + SaveModal + commands/ribbon + settings tab.
6. Save and ingest flows; run report rendering.
7. README: what it does, both engines, auth setup (`claude` login / `claude setup-token` / API key), manual install.

## Verification

- `pnpm test` (vitest): sandbox rules, prompt builders, stream-json parsing, API tool loop with mocked client.
- `pnpm build` produces `main.js`; type-check clean.
- Manual e2e in `stl-browser-wiki/wiki` vault (copy/symlink build into `wiki/.obsidian/plugins/llm-wiki-chat/`):
  1. Both engines: ask "How are archives resolved?" → streamed answer citing `stl-browser/concepts/...` pages; links open.
  2. Chat turn asking it to edit a file → refused / no file changes (`git status` clean).
  3. Save last answer into `stl-browser/concepts/` → new page in CLAUDE.md format, no `[[`, linked from ≥1 related page
     or `wiki/index.md`, folder `index.md` updated, lint report shown; verify with `tools/find-orphans.mts` (new page not
     orphaned) and `grep -r "\[\[" wiki/` empty; `sources/` unchanged.
  4. Save synthesis into a new folder → folder `index.md` created.
  5. Ingest (CLI engine) → runs, `sha.log` updated or "no changes" reported; no new commits (`git log` unchanged);
     Stop cancels mid-run.
  7. `wiki/.obsidian/plugins/llm-wiki-chat/data.json` contains no API key or token.
  6. Subscription path: CLI logged in with Pro/Max (no API key) works; API engine with bad key shows clear error.
