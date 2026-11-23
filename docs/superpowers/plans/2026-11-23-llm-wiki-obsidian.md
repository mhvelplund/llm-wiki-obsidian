# LLM Wiki Chat (Obsidian plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop Obsidian plugin with a right-sidebar Claude chat over an llm-wiki vault, with buttons that save answers as linked, linted wiki pages and run the CLAUDE.md ingest. It has two switchable engines: the Direct API and the local Claude Code CLI.

**Architecture:** UI code (`src/view`, `src/main.ts`, `src/settings.ts`) talks to one `Engine` interface that emits a shared event stream. `ApiEngine` runs its own tool loop over the Anthropic SDK, using repo-sandboxed fs tools. `ClaudeCodeEngine` spawns `claude -p --output-format stream-json`. Everything outside `src/view`, `src/main.ts`, `src/settings.ts` and `src/secrets.ts` must not import `obsidian`, so vitest can test it under plain Node.

**Tech Stack:** TypeScript, Obsidian API, esbuild (obsidian-sample-plugin layout), `@anthropic-ai/sdk`, vitest, pnpm, Node 24.

**Spec:** `docs/superpowers/specs/2026-11-23-llm-wiki-obsidian-design.md`

## Global Constraints

- Plugin id `llm-wiki-chat`, name "LLM Wiki Chat", `isDesktopOnly: true`. `minAppVersion` is the first Obsidian release with `app.secretStorage`; check `node_modules/obsidian/obsidian.d.ts`.
- API model default `claude-sonnet-5-5`; CLI model default `sonnet`.
- API: streaming; adaptive thinking (send no `thinking` param); `output_config.effort` = `medium` for chat and `high` for save; beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`; check `stop_reason` for `refusal` and `max_tokens`; `max_tokens: 64000`.
- Written pages: relative Markdown links with `.md`, never `[[wikilinks]]`, no YAML frontmatter. `sources/` is never written. Only Save and Ingest may write files.
- The API key and Claude Code OAuth token are stored only through `app.secretStorage`, never in `data.json`.
- Ingest is allowed only on the Claude Code engine.
- The plugin never commits. The ingest git allowlist is exactly: `Bash(git status:*)`, `Bash(git log:*)`, `Bash(git diff:*)`, `Bash(git rev-parse:*)`, `Bash(git -C sources/*)`, `Bash(git submodule update:*)`, `Bash(git submodule status:*)`.
- Exclude `.git`, `node_modules` and `wiki/.obsidian` from search and snapshots.

## Review Focus

1. **Vault is not inside an llm-wiki repo** (no `CLAUDE.md` or `wiki/` at the repo root). The chat shows a clear "configure repo root" message and starts no run. Test in Task 1 (`validateRepo`) and Task 8 (controller refuses to run).
2. **`claude` is missing from PATH or not logged in.** The run ends with an `error` event that carries the CLI's stderr, and does not hang. Test in Task 4 (spawn ENOENT, and non-zero exit with stderr).
3. **The save target already exists.** SaveModal blocks submit and shows "page exists"; the controller re-checks and never overwrites. Test in Task 8 (`planSave` rejects an existing path).
4. **Tool paths that escape the sandbox** (`../`, absolute paths, `wiki/../sources/x`, backslashes on Windows). Every such path is rejected. Test in Task 2.
5. **Send or Save pressed while a run is in progress, or Stop pressed mid-save.** A second run cannot start (`busy` error). Stop gives a `cancelled` done event, and the files changed so far still appear in the report. Test in Task 8.

---

### Task 1: Scaffold, repo helpers, wiki snapshot

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `versions.json`, `.gitignore`, `vitest.config.ts`, `src/main.ts` (an empty `Plugin` subclass for now), `styles.css`
- Create: `src/repo.ts`, `src/snapshot.ts`
- Test: `tests/repo.test.ts`, `tests/snapshot.test.ts`, `tests/helpers/tmpRepo.ts`

**Interfaces:**
- Produces:
  - `resolveDefaultRepoRoot(vaultBasePath: string): string`, which returns the parent directory.
  - `validateRepo(root: string): { ok: true } | { ok: false; reason: string }`. This is ok only when `CLAUDE.md` is a file and `wiki/` is a directory.
  - `listWikiFolders(root: string): string[]`. Returns POSIX paths relative to `wiki/` (with `""` for the root), sorted, excluding `.obsidian` and `img`.
  - `slugify(title: string): string`. Lowercase, hyphen-separated, ASCII only.
  - `snapshotWiki(root: string): Map<string, number>`, keyed by repo-relative POSIX path, with mtimeMs as the value.
  - `diffSnapshots(before, after): { created: string[]; modified: string[]; deleted: string[] }`, each list sorted.
  - `makeTmpRepo(files: Record<string,string>): string`, a test helper.

- [ ] **Step 1:** Scaffold from the obsidian-sample-plugin layout, with pnpm and devDeps `obsidian`, `typescript`, `esbuild`, `vitest`, `@types/node`, `builtin-modules`. Scripts are `dev`, `build` (`tsc --noEmit && node esbuild.config.mjs production`) and `test` (`vitest run`). Set the esbuild externals to `obsidian`, `electron` and the Node builtins. `.gitignore` covers `node_modules`, `main.js` and `data.json`.
- [ ] **Step 2: Write failing tests.** The tests:
  - `validateRepo` returns `ok:false` with a reason that mentions `CLAUDE.md` when that file is missing, and a reason that mentions `wiki` when that folder is missing.
  - `listWikiFolders` on `{wiki/index.md, wiki/a/index.md, wiki/a/b/x.md, wiki/img/p.png, wiki/.obsidian/app.json}` returns `["", "a", "a/b"]`.
  - `slugify("Archive Patterns & Co.")` returns `"archive-patterns-co"`.
  - `diffSnapshots` reports a new file, a touched file (mtime bumped) and a removed file in the right lists.
  - `snapshotWiki` ignores `wiki/.obsidian/**`.
- [ ] **Step 3:** Run `pnpm test`. Expected: FAIL, because the modules don't exist yet.
- [ ] **Step 4:** Implement `src/repo.ts` and `src/snapshot.ts` with `node:fs` and `node:path`. Normalize every returned path to `/`.
- [ ] **Step 5:** Run `pnpm test && pnpm build`. Expected: PASS, and `main.js` is produced.
- [ ] **Step 6:** Commit with message `feat: scaffold plugin with repo and snapshot helpers`.

### Task 2: Sandboxed file tools for the API engine

**Files:**
- Create: `src/engine/tools.ts`
- Test: `tests/tools.test.ts`

**Interfaces:**
- Consumes: `makeTmpRepo` from Task 1.
- Produces:
  - `type ToolMode = "read" | "write"`.
  - `toolDefinitions(mode: ToolMode): Anthropic.Tool[]`. Read mode has `list_dir`, `read_file` and `search`; write mode adds `write_file` and `edit_file`. Every definition has `strict: true` and `additionalProperties: false`, and the definitions come back in a fixed order.
  - `executeTool(root: string, mode: ToolMode, name: string, input: unknown): Promise<{ content: string; isError: boolean }>`.
  - `resolveInRepo(root: string, rel: string, access: "read" | "write"): string`. Throws `SandboxError`.
  - Readable paths are `wiki/**`, `sources/**`, `CLAUDE.md`, `sha.log` and `.gitmodules`. Writable paths are `wiki/**` only, minus `wiki/.obsidian/**`.
  - Tool inputs:
    - `list_dir{path}`
    - `read_file{path}`
    - `search{pattern, path?, regex?: boolean}`. Returns at most 200 `path:line: text` lines.
    - `write_file{path, content}`. Fails if the file exists, unless `overwrite: true`.
    - `edit_file{path, old_str, new_str}`. `old_str` must occur exactly once.

- [ ] **Step 1: Write failing tests.** The tests:
  - `resolveInRepo` throws for `../x`, for an absolute path, for `wiki/../sources/a.md` in write mode, for `sources/a.md` in write mode, for `wiki\\..\\CLAUDE.md` in write mode, and for `wiki/.obsidian/plugins/x/data.json` in write mode.
  - `read_file` of `CLAUDE.md` works.
  - `write_file` in read mode returns `isError: true` with the message `"tool not available"`.
  - `edit_file` with a zero-match or two-match `old_str` returns `isError`.
  - `search` finds `foo` in `wiki/a.md` and skips `wiki/.obsidian`.
- [ ] **Step 2:** Run `pnpm test tests/tools.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `tools.ts`. Before checking prefixes, resolve every path with `path.resolve(root, rel)` and then `fs.realpathSync` on the nearest existing ancestor.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat: repo-sandboxed file tools`.

### Task 3: Prompt builders

**Files:**
- Create: `src/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Produces:
  - `type RunKind = "chat" | "save" | "ingest"`.
  - `pluginPreamble(kind: RunKind): string`.
  - `apiSystemPrompt(claudeMd: string, kind: RunKind): string`, which is the preamble followed by `"\n\n# Repository instructions (CLAUDE.md)\n\n"` and the CLAUDE.md text.
  - `savePrompt(opts: { source: "last" | "synthesis"; lastAnswer?: string; targetPath: string; newFolder: boolean; today: string }): string`. `targetPath` is repo-relative, for example `wiki/stl-browser/concepts/x.md`.
  - `INGEST_PROMPT = "Update the wiki and lint it."`

- [ ] **Step 1: Write failing tests.** The tests:
  - For every kind, the preamble contains `"never [[wikilinks]]"`, `"no YAML frontmatter"` and `"Never modify sources/"`.
  - The chat preamble contains `"Do not modify any files"`.
  - `savePrompt` for `"last"` embeds `lastAnswer` verbatim and contains the target path.
  - `savePrompt` for `"synthesis"` contains `"synthesize the conversation so far"`.
  - With `newFolder: true`, the prompt contains `"create its index.md"`.
  - The prompt contains numbered steps 1–5 from the spec (write page, link both ways or from `wiki/index.md`, update folder index and `wiki/index.md`, lint the whole wiki, end with a summary of files and lint findings).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the builders. Use the spec's "Prompts" section as the copy.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat: prompt builders`.

### Task 4: Engine interface and Claude Code engine

**Files:**
- Create: `src/engine/Engine.ts`, `src/engine/streamJson.ts`, `src/engine/ClaudeCodeEngine.ts`
- Test: `tests/streamJson.test.ts`, `tests/claudeCodeEngine.test.ts`, `tests/fixtures/stream-chat.jsonl`, `tests/fixtures/fake-claude.mjs`

**Interfaces:**
- Consumes: `RunKind` and `pluginPreamble` from Task 3.
- Produces (in `Engine.ts`):
  ```ts
  type EngineEvent =
    | { type: "text-delta"; text: string }
    | { type: "tool-activity"; label: string }        // e.g. "Read wiki/index.md"
    | { type: "done"; text: string; cancelled?: boolean; costUsd?: number }
    | { type: "error"; message: string };
  interface RunRequest { kind: RunKind; prompt: string; signal: AbortSignal }
  interface Engine {
    readonly id: "api" | "claude-code";
    run(req: RunRequest): AsyncIterable<EngineEvent>;   // exactly one terminal done|error
    reset(): void;                                       // forget conversation
  }
  ```
- Produces (in `streamJson.ts`): `parseStreamLine(line: string): EngineEvent[] | { sessionId: string }`. It maps:
  - the `system/init` event to `sessionId`;
  - `stream_event` text deltas to `text-delta`;
  - assistant `tool_use` blocks to `tool-activity`, with the label `"<ToolName> <file_path|pattern|command>"`;
  - `result` to `done`, with `text = result` and `costUsd = total_cost_usd`;
  - `result` with `is_error: true` to `error`.
  - Unknown lines produce `[]`.
- Produces (in `ClaudeCodeEngine.ts`):
  - `buildClaudeArgs(opts: { kind: RunKind; prompt: string; model: string; sessionId?: string; maxBudgetUsd?: number }): string[]`.
  - `class ClaudeCodeEngine implements Engine`, with constructor `(opts: { cliPath: string; repoRoot: string; model: string; maxBudgetUsd?: number; env: Record<string,string> })`. `env` carries `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` only when they are set.

- [ ] **Step 1:** Record a real fixture by running `claude -p "say hi" --output-format stream-json --verbose --include-partial-messages` once and saving the output to `tests/fixtures/stream-chat.jsonl`. Write `fake-claude.mjs`, which replays a fixture file named by the env var `FAKE_FIXTURE`, honours `FAKE_EXIT` and `FAKE_STDERR`, and sleeps on `FAKE_HANG=1`.
- [ ] **Step 2: Write failing tests.** The tests:
  - Parsing the fixture yields `sessionId`, at least one `text-delta` and exactly one `done`.
  - Every `buildClaudeArgs` result includes `-p`, the prompt, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--model <model>` and `--append-system-prompt <pluginPreamble(kind)>`.
  - For `chat`: `--allowedTools Read Glob Grep` and `--disallowedTools Edit Write Bash`.
  - For `save`: `--allowedTools Read Glob Grep Edit Write "Bash(node --experimental-strip-types tools/*)"` and `--permission-mode acceptEdits`.
  - For `ingest`: the save tools plus exactly the git allowlist from Global Constraints.
  - When there is a `sessionId`, the args include `--resume <id>`.
  - When there is a `maxBudgetUsd`, the args include `--max-budget-usd`.
  - An engine using `node fake-claude.mjs` as the CLI:
    - a second `run` passes `--resume` with the captured session id;
    - `reset()` drops the session id;
    - a missing CLI path yields a single `error` event that mentions the path;
    - `FAKE_EXIT=1` with `FAKE_STDERR=not logged in` yields an `error` containing `not logged in`;
    - aborting the signal during `FAKE_HANG` yields `done` with `cancelled: true` within 2 s.
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4:** Implement both files. Spawn with `child_process.spawn(cliPath, args, { cwd: repoRoot, env: {...process.env, ...env}, windowsHide: true })` and split stdout on `\n`. To kill the process on Windows, use `taskkill /pid <pid> /T /F`; elsewhere, `child.kill()`. Allow `cliPath` to be `"node path/to/fake-claude.mjs"` only through a test-only `argsPrefix` constructor option.
- [ ] **Step 5:** Run the tests. Expected: PASS.
- [ ] **Step 6:** Commit with message `feat: Claude Code engine over stream-json`.

### Task 5: API engine

**Files:**
- Create: `src/engine/ApiEngine.ts`
- Test: `tests/apiEngine.test.ts`

**Interfaces:**
- Consumes: `Engine`, `EngineEvent` and `RunRequest` from Task 4; `toolDefinitions` and `executeTool` from Task 2; `apiSystemPrompt` from Task 3.
- Produces: `class ApiEngine implements Engine`, with constructor `(opts: { client: Pick<Anthropic, "beta">; repoRoot: string; model: string })`. A factory `createAnthropicClient(apiKey: string)` returns `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.

Behaviour:
- `run` reads `CLAUDE.md` fresh on each run.
- It builds `system` as a single text block with `cache_control: {type:"ephemeral"}`.
- It keeps `history: Anthropic.Beta.BetaMessageParam[]` across runs and appends the full `message.content` each turn.
- It runs a manual tool loop with `client.beta.messages.stream({ model, max_tokens: 64000, system, tools: toolDefinitions(kind==="chat"?"read":"write"), messages: history, output_config:{effort}, betas:["server-side-fallback-2026-07-01"], fallbacks:"default" }, { signal })`.
- It yields `text-delta` from text deltas, then calls `finalMessage()`. On `tool_use`, it yields `tool-activity`, runs all tools, and appends every `tool_result` in one user message.
- On `stop_reason` `refusal` it yields an error with the message `"Claude declined this request"`.
- On `max_tokens` with a pending `tool_use`, it yields an error.
- `kind === "ingest"` yields the error `"Ingest requires the Claude Code engine"` immediately.

- [ ] **Step 1: Write failing tests.** Use a fake `client.beta.messages.stream` that replays scripted messages. The tests:
  - A one-turn text answer streams deltas and ends with `done.text`.
  - A turn with two `tool_use` blocks gets back one user message with two `tool_result` entries, and then the final answer.
  - A chat run never offers `write_file`. Assert on the `tools` names passed in.
  - `refusal` produces an `error` event.
  - The request has `fallbacks: "default"` and that beta.
  - A second `run` sends the earlier history.
  - `reset()` clears the history.
  - `ingest` produces an immediate error.
  - Aborting the signal produces `done` with `cancelled: true`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Run `pnpm add @anthropic-ai/sdk` and implement the engine.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then `pnpm build`, which must bundle the SDK without errors.
- [ ] **Step 5:** Commit with message `feat: direct API engine with sandboxed tool loop`.

### Task 6: Settings, secrets, engine factory

**Files:**
- Create: `src/settings.ts`, `src/secrets.ts`, `src/engine/createEngine.ts`
- Modify: `src/main.ts` (load and save settings, register the settings tab)
- Test: `tests/createEngine.test.ts`

**Interfaces:**
- Produces:
  - `interface LlmWikiSettings { engine: "api" | "claude-code"; repoRoot: string; apiModel: string; cliPath: string; cliModel: string; maxBudgetUsd: number | null; useApiKeyForCli: boolean }`. Defaults are `claude-code`, `""` (meaning the vault parent at runtime), `claude-sonnet-5-5`, `claude`, `sonnet`, `null` and `false`.
  - `interface Secrets { get(id: "api-key" | "oauth-token"): string | null; set(id, value: string): void }`. It wraps `app.secretStorage`, under ids prefixed `llm-wiki-chat-`.
  - `createEngine(s: LlmWikiSettings, repoRoot: string, secrets: Pick<Secrets,"get">): Engine | { error: string }`. It is a pure function, apart from constructing the engine.
  - `LlmWikiSettingTab`:
    - fields for each setting;
    - password-style inputs for the API key and OAuth token that write to `Secrets` only;
    - a live validity line for the repo root, using `validateRepo`;
    - help text for the OAuth token: "Run `claude setup-token` in a terminal and paste the token";
    - a **Test connection** button. For the API engine it calls `client.models.list` (limit 1). For the CLI engine it runs `cliPath --version` and then a one-turn `-p "Reply with OK"`. It shows a Notice with the result or the stderr.

- [ ] **Step 1: Write failing tests.** The tests:
  - `createEngine` with `api` and no key returns `{error}` mentioning the API key.
  - With `claude-code` and an OAuth token, the engine env includes `CLAUDE_CODE_OAUTH_TOKEN`.
  - With `useApiKeyForCli: false`, `ANTHROPIC_API_KEY` is not set even when a key exists.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Check the exact `secretStorage` method names in `obsidian.d.ts`. `saveData` must never receive a secret field.
- [ ] **Step 4:** Run `pnpm test && pnpm build`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat: settings, secret storage, engine factory`.

### Task 7: Chat view, ribbon and commands

**Files:**
- Create: `src/view/ChatView.ts`, `src/view/render.ts`
- Modify: `src/main.ts`, `styles.css`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `Engine` and `EngineEvent` (Task 4), and `createEngine` (Task 6).
- Produces:
  - `VIEW_TYPE = "llm-wiki-chat-view"`.
  - `class ChatView extends ItemView` with these public members: `transcript: { role: "user" | "assistant" | "report"; text: string }[]`, `lastAnswer(): string | null`, `appendReport(md: string)`, `setBusy(b: boolean)`, `onAction: (a: "save-last" | "save-synthesis" | "ingest") => void`.
  - `rewriteLinkForVault(href: string, wikiRelSourcePath: string): string | null`, in `render.ts`. It maps a relative `.md` href, or a `wiki/...` href, to a vault path, and returns null for external links.
  - Commands: `open-chat` ("Open wiki chat"), `save-last-answer`, `save-synthesis` and `ingest-sources`. The ribbon icon `message-square` opens the view in the right leaf.

- [ ] **Step 1: Write failing tests** for `rewriteLinkForVault`:
  - `("../operations/stlx-cli.md", "stl-browser/concepts/a.md")` returns `"stl-browser/operations/stlx-cli.md"`.
  - `("wiki/stl-browser/index.md", "index.md")` returns `"stl-browser/index.md"`.
  - `("https://github.com/x", …)` returns `null`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the view to match the spec's chat pane:
  - **Header:** a "New chat" button that calls `engine.reset()` and clears the transcript, and an engine badge.
  - **Messages:** user bubbles. Assistant markdown goes through `MarkdownRenderer.render`, re-rendered at most every 100 ms while streaming.
  - **Tool activity:** a collapsed `<details>` element ("Used N tools").
  - **Footer:** the three action buttons and a textarea. Enter sends; Shift+Enter adds a newline.
  - **Send/Stop:** a single button. Stop aborts the current `AbortController`.
  - **Links:** a click handler on links uses `rewriteLinkForVault` and `workspace.openLinkText`.
  - **Ingest button:** disabled, with a tooltip, when the engine is `api`.
  - **Styling:** CSS uses only Obsidian variables.
- [ ] **Step 4:** Run `pnpm test && pnpm build`. Expected: PASS.
- [ ] **Step 5:** Manual check. Symlink the repo into `stl-browser-wiki/wiki/.obsidian/plugins/llm-wiki-chat`, reload Obsidian and enable the plugin. On the Claude Code engine, ask "How are archives resolved?". The answer streams, cites pages, and opening a cited link opens the vault page.
- [ ] **Step 6:** Commit with message `feat: chat sidebar view, ribbon and commands`.

### Task 8: Save and ingest flows

**Files:**
- Create: `src/view/SaveModal.ts`, `src/runController.ts`
- Modify: `src/main.ts`, `src/view/ChatView.ts` (wire `onAction`)
- Test: `tests/runController.test.ts`

**Interfaces:**
- Consumes: `listWikiFolders`, `slugify`, `snapshotWiki` and `diffSnapshots` (Task 1); `savePrompt` and `INGEST_PROMPT` (Task 3); `Engine` (Task 4).
- Produces (in `runController.ts`, which has no obsidian import):
  - `planSave(root: string, folder: string, name: string): { targetPath: string; newFolder: boolean } | { error: string }`. It returns an error if the name is empty, if the slug differs from the name, or if `wiki/<folder>/<name>.md` exists. A folder that isn't in `listWikiFolders` counts as `newFolder: true`.
  - `class RunController` with constructor `(engine: Engine, root: string)` and these members:
    - `busy: boolean`.
    - `chat(prompt, signal): AsyncIterable<EngineEvent>`.
    - `save(opts: {source:"last"|"synthesis"; lastAnswer?: string; folder: string; name: string}, signal): AsyncIterable<EngineEvent | {type:"report"; markdown: string; openPath?: string}>`.
    - `ingest(signal)`, with the same yield type as `save`.
  - Calling any method while `busy` yields `{type:"error", message:"A run is already in progress"}`.
  - `save` and `ingest` snapshot the wiki before and after the run, even on cancel or error. They yield a report with `### Files created`, `### Files modified` and the engine's final text.
  - The report's `openPath` is set only when the target file exists after the run.
  - `validateRepo` failure yields an error before the engine is called.
- `SaveModal(app, folders, suggestedName, onSubmit)`:
  - a folder dropdown or suggester, plus a "New folder…" text input;
  - a name input prefilled with `slugify` of the answer's first heading, or of its first 6 words;
  - an inline "page exists" error from `planSave`, which disables Save.

- [ ] **Step 1: Write failing tests**, using a fake Engine that writes files into a tmp repo. The tests:
  - `planSave` rejects an existing page, rejects `"Bad Name"`, and returns `newFolder: true` for an unknown folder.
  - A save whose fake engine creates `wiki/a/new.md` and modifies `wiki/index.md` produces a report that lists both and has `openPath` `"a/new.md"`.
  - The prompt passed to the engine has kind `save` and contains the target path.
  - A second call while busy yields the busy error.
  - Aborting mid-run still yields a report with the files written so far.
  - With an invalid repo, the engine is never called.
  - `ingest` sends kind `ingest` with `INGEST_PROMPT`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `runController.ts` and `SaveModal.ts`, and wire them into the view and commands. Reports are rendered with `appendReport`, and `openPath` is opened in a new tab.
- [ ] **Step 4:** Run `pnpm test && pnpm build`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat: save-to-wiki and ingest flows`.

### Task 9: README and end-to-end verification

**Files:**
- Create: `README.md`

- [ ] **Step 1:** Write the README. It covers:
  - what the plugin does;
  - the two engines and when to use each;
  - auth: a logged-in `claude`, `claude setup-token`, or an API key;
  - why subscription sign-in only goes through Claude Code;
  - manual install by copying or symlinking `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/llm-wiki-chat/`;
  - the repo-root setting;
  - that the plugin never commits.
- [ ] **Step 2:** Run the spec's manual e2e list in the `stl-browser-wiki` vault on both engines (spec "Verification" items 1–7). From the repo root, check:
  - `grep -rn "\[\[" wiki/` is empty;
  - `node --experimental-strip-types tools/find-orphans.mts` does not list the new page;
  - `git -C sources/stl-browser status` is clean after Save;
  - `git log -1` is unchanged after Ingest;
  - `data.json` contains no key.

  Record the results in the final report.
- [ ] **Step 3:** Commit with message `docs: README with install and auth`.
