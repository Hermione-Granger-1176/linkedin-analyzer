# GitHub helpers

The `make pr-*`, `make issue-*`, and `make ci-*` targets wrap GitHub operations. Run `make help-pr`, `make help-issue`, or `make help-actions` for every target and argument.

## Pass input to targets

Free-text bodies come from standard input. Titles come from the `TITLE` environment variable. Do not pass a body as a Make argument.

```bash
make pr-comment < notes.md
TITLE='Fix the export error' make issue-create < issue.md
```

## Handle review threads

```bash
make pr-review-comments
make pr-address thread=PRRT_... < response.md
```

`make pr-review-comments` prints a `thread=PRRT_...` ID for each thread. `make pr-address` replies to the thread and resolves it. Use `make pr-reply` to reply without resolving, or `make pr-resolve` to resolve without replying.

## Watch Copilot reviews

`make pr-watch` shows the current Copilot review and waits for CI checks to finish. It does not request a review by default.

- After you push a correction, run `make pr-watch request=1`. It requests a fresh review and waits for it.
- Run `make pr-watch checks_only=1` to watch CI checks alone.
- Run `make pr-copilot-review` to request a review without waiting for it.
- The watcher reads both Copilot review formats. A verdict other than "Approval recommended" blocks completion, even when no review threads are open.
- Run `make pr-comments` to read the findings in the review overview.

## Inspect and rerun CI runs

`make ci-jobs`, `make ci-failures`, `make ci-watch`, and `make ci-rerun` act on the current branch's latest run. Pass `run=ID` to target another run. `make ci-watch` exits non-zero when the run fails.

```bash
make ci-failures
make ci-watch
```

For the other Actions targets, see [CI and repository automation](ci.md#inspect-and-operate-ci).

## REST fallback differences

The `make pr-*` and `make issue-*` targets try GraphQL first. When the environment refuses GraphQL, as Claude Code cloud sessions do, they switch to the REST API for the rest of the run. [ADR-012](adr/012-graphql-first-rest-fallback.md) explains the design. In REST mode:

- Review threads have no node ID. `make pr-review-comments` prints each thread as `thread=<id>`, where `<id>` is the number of the thread's first comment. Pass that number to `make pr-reply`, `make pr-resolve`, or `make pr-address`. Add `pr_num=N` when the PR is not on the current branch.
- `make pr-comments-list` prints numeric comment IDs. Pass one to `make pr-comment-delete comment_id=<id>`.
- `PRRT_` and `PRRC_` node IDs need GraphQL. The target fails and names the numeric ID to use instead.
- List, view, and checks output is tab-separated. It resembles `gh` output but is not identical.
- `make pr-create` does not push. Run `make push` first. Otherwise the target stops, because the branch on GitHub is missing or behind your local `HEAD`.
- `make pr-merge` and `make pr-close` delete the remote branch and leave your local checkout alone.
- `make pr-merge` refuses a PR that GitHub does not report as mergeable, so it cannot bypass branch protection. Use `make pr-merge-admin` to merge past protection on purpose.
- `make issue-develop` creates and checks out the branch. It cannot link the branch to the issue.
- The targets pick the repository from `GH_REPO`, then from the default that `gh repo set-default` stored, then from `origin`. If gh stored a default these targets cannot read, they stop instead of using `origin`.
- When the selected repository differs from `origin`, such as the upstream repository when you work from a fork, the targets read and write the selected repository. They push and fetch branches through `origin`. `make pr-create` opens the PR from the fork branch. `make pr-checkout` and `make issue-develop` refuse, because their fetches would come from the wrong repository. They also refuse when `origin` is not a GitHub repository.
- `make issue-list` with `SEARCH` needs the `search/issues` endpoint, which cloud sessions block. The other filters work.
