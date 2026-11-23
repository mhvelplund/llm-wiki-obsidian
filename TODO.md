# TODO

## Security: Claude Code save/ingest hardening

Found in the final whole-branch review (2026-11-23). Not yet fixed. All of these predate the last fix wave.

**Threat model:** Save and Ingest runs read wiki and `sources/` content. During ingest that includes third-party repos, so text in those repos could steer Claude (prompt injection). The permission rules are built in `buildClaudeArgs` in `src/engine/ClaudeCodeEngine.ts`. They are meant to limit writes to `wiki/` (and `sha.log` for ingest) and to forbid commits.

Wildcard behaviour on Claude Code CLI 2.1.330:
- The `*` in Bash rules matches across spaces.
- A `:*` suffix only works as a plain prefix match, not mid-pattern. So `Bash(git -C sources/* log:*)` never matches, and the engine uses the form `Bash(git -C sources/* log *)` instead.

### High: code execution

1. **`git log` / `git diff --output=<file>` writes files anywhere.**
   - Reachable through the allowed root `Bash(git log:*)` / `Bash(git diff:*)` rules and the `git -C sources/* log|diff *` rules.
   - With `--format`, the content is fully attacker-controlled, for example `--output=.git/hooks/pre-commit`. That gives code execution on your next commit.
   - It bypasses every `Edit(...)` deny rule, `.git/**` included.
   - Fix: deny `Bash(git * --output*)`. Spell out `--output` in full.
2. **`git -C sources/x config … # log x` matches the allow rule because the wildcard spans spaces.**
   - It can write the superproject config, for example `core.fsmonitor`. The next allowed `git status` then runs the command.
   - The existing `-c` denies don't cover the `config` subcommand.
   - Fix: deny `Bash(git -C * config *)`.
3. **`Bash(node --experimental-strip-types tools/*)` also accepts `tools/../wiki/evil.mjs`.**
   - Claude may write under `wiki/`, so it can write a script there and then run it.
   - Fix: deny `Bash(node --experimental-strip-types tools/*..*)`. Better: allow only the specific scripts (`tools/find-orphans.mts`, `tools/fix-separators.mts`, `tools/sort-related-pages.mts`).

### Medium / low: data loss in submodule checkouts

4. Commands such as `git -C sources/x clean -fdx … log x` match the allow rules. The same goes for `rm`, `stash`, `restore`, `switch`, `branch -D`, `tag`, `update-ref` and `worktree`. These can destroy data in the `sources/` checkouts, which can usually be fetched again.
   - Fix: deny `Bash(git -C * clean *)`, and optionally `Bash(git -C * <sub> *)` for each of the subcommands above, plus `Bash(git * --config-env*)`.

### To verify

5. Check whether Claude Code treats shell output redirection, for example `git log … > CLAUDE.md`, as a write that `Edit(...)` deny rules govern. Run one real CLI run with the ingest args to find out.

### How to fix and verify

- Add the deny rules to the save + ingest deny list (`NO_COMMIT` / protected list) in `src/engine/ClaudeCodeEngine.ts`, and update the argv tests in `tests/claudeCodeEngine.test.ts`.
- Verify each new rule once with the real CLI (`--model haiku`) in a throwaway temp repo, never in a real wiki repo. Feed the prompt on stdin with the exact args from `buildClaudeArgs`. Each crafted command must be denied, and the legitimate `git -C sources/x log -1` must still work.
- Update the stale rule text (the `:*` mid-pattern forms) in the plan's Global Constraints, `docs/superpowers/plans/2026-11-23-llm-wiki-obsidian.md`.

## Other known issues (low)

- "Save synthesis" submitted while a settings change swaps the engine returns with only a "Settings changed — new conversation." note. Nothing says the save didn't happen (`src/main.ts`, `startRun`).
- Closing one chat pane resets the shared engine session, which also resets the conversation in a second open pane.
- MCP connector tools from the user's Claude account load into every CLI run. `dontAsk` denies them, but they use context. Consider `--strict-mcp-config`.
- Not yet checked in the Obsidian GUI: the chat pane, links, the Save modal, opening the new page, and Test connection.
