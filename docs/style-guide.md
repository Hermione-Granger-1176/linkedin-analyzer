# Style guide

Keep code, tests, docs, and repository automation consistent with the names already used in the codebase. Prefer the smallest change that makes behavior clearer or safer.

## Name code consistently

- Use nouns for data and verbs for actions.
- Use `snake_case` for Python functions, variables, and modules.
- Use `camelCase` for JavaScript functions and local variables.
- Use PascalCase for JavaScript classes and exported module namespaces such as `AppRouter`.
- Use `UPPER_SNAKE_CASE` for constants.
- Use lowercase file names. Use underscores in Python names and hyphens for new documentation file names.
- Use the existing symbol name in docs, comments, tests, and error messages.

## Format code

- Run Ruff through `make format-py-check` and `make lint-py`.
- Keep Python lines at 100 characters and use type hints for new code.
- Run Prettier and ESLint through `make format-js-check` and `make lint-js`.
- Use explicit semicolons in JavaScript.
- Group imports by standard library, third-party, and local modules.
- Use four spaces in Python, JavaScript, CSS, and HTML. Use two spaces in JSON and YAML.
- Keep Markdown paragraphs on one line. Use `make align-tables-check` for Markdown tables.
- Follow `.editorconfig` for line endings, final newlines, character encoding, and trailing whitespace.

## Write comments that explain a reason

Let the code explain what it does. Add a comment when the reason would otherwise be hard to infer from the code or from a test. Do not restate the next line.

Keep comments short, direct, and near the code they explain. Name the real constraint, such as a browser API limitation, a privacy rule, or a compatibility requirement.

Mascot SVG and CSS comments can describe the pose because path coordinates do not show what the drawing represents.

## Keep control flow readable

Validate inputs early and return on invalid state. Prefer guard clauses over nested conditionals. Keep one decision in each branch.

Use a `for` loop when the collection and stopping point are clear. Use a `while` loop only when the stopping point depends on work performed inside the loop. Extract a helper when a loop body carries more than one responsibility.

Use a comprehension for a simple transform. Use a normal loop when it contains branching, error handling, or side effects.

## Handle errors deliberately

Raise `ValueError` for user-facing validation errors in Python. Catch narrow exception types when the caller can recover. Include the input or operation in the error message when that helps the user fix it.

Do not swallow an exception without a reason. If a fallback is intentional, record the fallback in a log, return value, or user-visible state.

In browser code, keep worker failures, timeouts, and storage failures distinct when the caller needs different recovery. Use `captureError` only with the fixed context values that the observability layer accepts.

## Test changes

Add a focused test for new behavior and an edge case for each new branch. Keep tests deterministic and independent of the local timezone, current time, network, and private exports.

Maintain 100 percent statement and branch coverage over `src/linkedin_analyzer/` and `scripts/`. Maintain the JavaScript thresholds in `web/vitest.config.mjs`.

Update parity fixtures when a cleaner rule changes intentionally. Run `make gen-parity-corpus` only when the expected behavior changed, and review the generated diff.

## Update documentation

Update docs when a command, option, route, output file, limit, workflow, or privacy rule changes. Put user actions in the user guide, lookup facts in a reference page, design reasons in an explanation, and multi-step tasks in a how-to page.

Use sentence case headings. Use one H1 per page and do not skip heading levels. Use numbered lists for sequences and bullets for non-sequential facts. Put conditions before the step they guard.

Write paths, symbols, flags, and Make targets exactly as they appear in the repository. Use code formatting for commands and symbols. Keep one name for each concept across all docs.

Run these checks after a documentation change:

```bash
make lint-doc-commands
make lint-make-targets
make align-tables-check
```

## Keep the runtimes aligned

The Python and JavaScript cleaners must agree on cleaned values, required columns, dropped rows, date handling, and formula protection. Workbook formatting can differ when the two libraries expose different APIs.

If a behavior differs intentionally, document the difference in [data formats](data-formats.md) and add a parity test that protects the boundary.

## Review a refactor

Refactor only when the change improves clarity, reduces duplication, or lowers a known risk without changing behavior. Read the complete control flow before flattening conditionals. Do not replace a clear branch with a shorter expression that hides the fallback.

Keep unrelated documentation, formatting, and feature changes out of the same patch. Run the narrow test for the changed module, then the full gate that covers its runtime.
