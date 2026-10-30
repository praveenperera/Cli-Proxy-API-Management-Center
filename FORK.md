# Fork maintenance

This fork tracks [router-for-me/Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) (`origin/main`). It is the panel for the [CLIProxyAPI fork](https://github.com/praveenperera/CLIProxyAPI) and uses that fork's extra management endpoints. It adds:

- Ordered routing: the `ordered` routing strategy and an editor for `routing.order` in the Network config section, and routing order presets (Use first, Normal, Use last, plus an exact stepper) for an auth file's priority. The session affinity toggle is gone because the backend fork always turns session affinity on.
- Pooled quotas on the Quotas page: one pool card per provider with remaining and drain-rate charts, burn rate and projections, Claude and Codex account usage history read from the backend's `/quota/history` and refreshed every minute, per-account cards behind an Accounts toggle, and an email toggle. Auth file cards load Claude and Codex quota when they first show, and the auth file sheet sets an account's plan size (`quota_weight`).
- A Usage & Cost page (`/cache`) with cache hit ratios and API-equivalent cost by account, model, and client thread, read from `/observability/usage/cache`.

The fork is kept as a short stack of commits on top of upstream and rebased, not merged, so the fork's changes stay readable as one diff against upstream.

## Keep upstream files nearly untouched

Every line the fork changes in a file that also exists upstream can conflict on the next rebase. New files never conflict. So:

- Put fork logic in fork-owned files next to the upstream code they extend: components, hooks, modules, and SCSS modules. Leave the smallest hook in the upstream file: an import and one use, a route entry, a nav item, a prop, or a spread into a list (`ROUTING_ORDER_SEARCH_ENTRY` in the config search index).
- Never reindent or rewrap upstream code. Instead of wrapping upstream markup in a new condition, use one of these:
  - An early return. `QuotaPage` renders `QuotaPoolBody` ahead of upstream's card-grid branches, which stay byte-identical below it.
  - A wrapper that takes an upstream element's place. `AccountsOnlyDiv` stands in for the toolbar's `<div>`, and `AccountQuotaTimeline` for `<QuotaTimeline>`, so the markup inside keeps its indentation.
  - A slot prop. `QuotaHeader` takes `extraActions` for the email toggle.
- Don't let Prettier rewrap upstream lines. Adding a parameter to a `useCallback(() => { ... }, [deps])` callback makes Prettier reindent the whole callback, and renaming a call to a shorter name can collapse its wrapped arguments onto one line. Don't run `bun run format` either: it rewrites the upstream files that upstream leaves unformatted. Format only the files you touch.
- Put fork translations in `src/i18n/fork/<locale>.json`, never in `src/i18n/locales/`. Those files are deep-merged over the upstream locales at startup and may override upstream wording. `tests/forkLocales.test.ts` checks that all six cover the same keys.
- Put fork tests in fork-owned test files, not appended to upstream ones. Edit an upstream test only when a fork change breaks one of its assumptions. Three edits remain: `configFieldParity` reads the merged locale, `quotaToolbar` finds the toolbar without its `<div` tag, and `visualConfigV8` drops the session affinity case.
- When upstream code builds a state object that the fork extends, make the fork's fields optional, as the auth file editor's quota weight fields are. Upstream code and tests that build the object without them then keep working.
- Keep upstream fields and locale keys rather than deleting them, unless an upstream test forces the removal. The routing session affinity field is removed because the config parity tests require every value field to be rendered.
- Put fork preferences under their own storage keys. The Quotas page's pooled-view settings live under `quotaPage.poolUiState`, because upstream's `writeQuotaUiState` keeps only the fields it knows.

Some fork code mirrors upstream code instead of editing it. When upstream changes the original, port the change:

| Fork code | Mirrors |
| --- | --- |
| `useAutoLoadQuota` | `refreshQuotaForFile` in `AuthFileQuotaSection`, without the toasts |
| `codexPlanLabel` in `src/features/quota/planLabel.ts` | `getPlanLabel` in `CodexQuotaBody` |
| `QuotaPoolBody` | the loading, empty, and card-grid branches in `QuotaPage` |
| `baseSvgProps` in `src/components/ui/forkIcons.tsx` | `baseSvgProps` in `src/components/ui/icons.tsx` |

`scripts/fork-footprint.sh` lists the fork's changes in upstream-owned files, largest first. It exits 1 if any of those changes are whitespace-only. Run it before committing fork work, and check that its totals did not grow without a reason.

## Syncing with upstream

```bash
git fetch origin
git branch -f backup/master-pre-sync master   # cheap undo point
git rebase origin/main                        # rerere remembers past resolutions
bun install --frozen-lockfile
bunx prettier --check $(git diff --name-only --diff-filter=A origin/main -- '*.ts' '*.tsx' '*.scss')
bun run verify                                # tests, lint, type check and build
scripts/fork-footprint.sh
git push --force-with-lease fork master
```

When a test fails after a rebase, run it on a plain `origin/main` worktree before blaming the fork. Upstream sometimes ships failing or timing-sensitive tests.

When resolving a conflict, keep both sides when both sides only add lines. When upstream changes code next to a fork hook, take upstream's version and re-add the hook. Do not carry an old copy of upstream code forward. After the rebase, check the table above for upstream changes to mirrored code.

Keep the stack at a few commits. Fold fixes to fork features into the existing commits (`git commit --fixup` then `git rebase -i --autosquash origin/main`), because every extra commit is another possible rebase stop.
