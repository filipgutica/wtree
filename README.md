# wtree

A better `git worktree list`. Shows every worktree for the current repo with its
age, disk usage, and the state of the pull request its branch belongs to, then
removes the ones you no longer need.

```
$ wtree
BRANCH                  AGE   PR          SIZE  FLAGS  PATH
main                    2d    -                 M      ~/code/api
fix/token-refresh       4h    open  #4821       @      ../api-token-refresh
feat/usage-charts       3mo   merged #4502            ✓ ../api-usage-charts
chore/bump-deps         5mo   closed #4390             ../api-bump-deps
spike/flink-cdc         8mo   -                 *↑     ../api-flink-spike

flags: M main  @ current  * dirty  ↑ unpushed  L locked  P prunable  d detached  ✓ in default branch
```

## Install

```sh
npm install
npm run build
npm link      # puts `wtree` on your PATH
```

Requires git and Node 20+. [`gh`](https://cli.github.com) is optional: without it
(or offline, or on a non-GitHub remote) PR state shows as `?` and everything else
still works.

## Commands

### `wtree list` (default)

```sh
wtree                                  # every worktree, oldest first
wtree --size                           # measure disk usage with du
wtree --pr-state merged,closed         # only worktrees whose PR is done
wtree --older-than 3mo                 # only worktrees older than three months
wtree --branch 'feat/*'                # glob on branch name
wtree --prunable                       # only ones git would prune
wtree --json                           # machine readable
```

### `wtree clean`

Removes worktrees matching the filters. **Dry run by default** — nothing is
deleted until you pass `--yes`.

```sh
wtree clean --pr-state merged,closed --older-than 3mo          # show the plan
wtree clean --pr-state merged,closed --older-than 3mo --yes    # do it
wtree clean --prunable --yes                                   # drop dead ones
wtree clean --pr-state merged --yes --delete-branch            # also delete branches
```

`clean` refuses to run without a filter. Pass `--all` if you really mean every
non-main worktree.

### `wtree prune`

Wraps `git worktree prune`. Dry run unless `--yes`.

### `wtree ui`

Interactive browser: move, multi-select, filter, and delete. Refuses to start
when stdout is not a terminal, so it can never hang a script or an agent.

## What "age" means

Three timestamps are collected and all three are in `--json`:

| field | meaning |
| --- | --- |
| `lastCommitAt` | committer date of the worktree's HEAD |
| `checkoutAt` | when git last wrote the worktree's index |
| `createdAt` | directory birth time |

`--older-than` compares against **`lastCommitAt`** by default. Directory mtime
moves whenever a build runs, which makes an abandoned worktree look active.
Use `--age-by checkout` or `--age-by created` if you want the other reading.

## Safety rules

`clean` never removes:

| blocked | cleared by `--force`? |
| --- | --- |
| the main worktree | no |
| the worktree you are standing in | no |
| a worktree whose PR state could not be determined, when you filtered on PR state | no |
| a worktree with uncommitted changes | yes |
| a worktree with unpushed commits | yes |
| a locked worktree | yes |

Branch deletion is opt-in (`--delete-branch`) and uses `git branch -d`, so an
unmerged branch survives. `--force-branch-delete` switches to `-d` → `-D`.

**Fail closed on unknown PR state.** If `gh` is missing, unauthenticated, or the
network is down, `wtree clean --pr-state ...` exits **3** with an error rather
than reporting that nothing matched. "Could not check" and "nothing to clean" are
different answers, and a caller that cannot tell them apart will delete the wrong
thing or skip the right one.

Squash and rebase merges do not leave the branch's commits in the default branch,
so the `✓` flag (`mergedIntoDefault`) misses them. PR state is the signal to trust;
`✓` is a hint for repos that use merge commits.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success (including a dry run with nothing to do) |
| 1 | one or more removals failed |
| 2 | bad usage, bad filter, or not a git repository |
| 3 | a PR-state filter was requested but PR state is unavailable |

## For agents

Every read command supports `--json`, and `clean` emits its plan as JSON before
doing anything. The intended shape of "clean up my merged worktrees older than
three months" is a single composable command, not parsed prose:

```sh
wtree clean --pr-state merged,closed --older-than 3mo --json          # plan only
wtree clean --pr-state merged,closed --older-than 3mo --yes --json    # execute
```

The plan JSON gives, per worktree, `willRemove`, `blockedBy[]` (with a `forceable`
flag per block), and `overriddenByForce[]`. Show the plan, get confirmation, then
re-run with `--yes`.

Age expressions accept `12h`, `30d`, `6w`, `3mo`, `1y`, or an ISO date.

`wtree ui` exits 2 rather than starting when there is no TTY.

The PR list is fetched in one `gh` call and cached for 10 minutes per repo
(`--ttl`, `--refresh`), so repeated calls are cheap.

`gh pr list` returns newest-first, so on a busy repo the bulk fetch truncates away
exactly the old PRs that old worktrees belong to. When that happens, each
unresolved branch gets a targeted lookup, and any branch still unanswered reports
`unknown` rather than "no PR". Raise `--pr-limit` (default 500) to widen the bulk
fetch on very large repos.
