# Style Guide

## Naming Conventions
- Use descriptive nouns for data, verbs for actions.
- Python: snake_case for functions, variables, modules.
- JavaScript: camelCase for functions and local variables; PascalCase for classes and exported module namespaces (for example `AppRouter`).
- Constants: UPPER_SNAKE_CASE.
- File names: lowercase; Python uses underscores. Docs prefer hyphens for new files, but existing underscores are acceptable.

## Formatting Style
- Python: Ruff formatting, 100-char lines, type hints everywhere.
- JavaScript: ESLint formatting, prefer explicit semicolons.
- Keep imports ordered and grouped by stdlib, third-party, local.
- Use blank lines to separate logical blocks, not every line.
- `.editorconfig` enforces indent style/size, charset, and line endings across editors.

## Comment Usage
- Prefer self-explanatory code; comment only non-obvious intent.
- Avoid narrating the code; explain why, not what.
- Keep comments short and aligned with nearby logic.

## Control Flow Preferences
- Avoid deeply nested if statements.
- Use guard clauses and early returns.
- Prefer flat, linear flow over complex branching.
- For delegated DOM click handlers, use `DomEvents.closest(event, selector)` to avoid repeating `instanceof Element` guards.

## Loops
- Prefer for-loops over while-loops.
- Use while-loops only when the end condition is unclear at start.
- Keep loop bodies small; extract helpers when needed.

## Comprehensions
- Use list/dict/set comprehensions for simple transforms.
- Avoid multi-branch logic inside comprehensions.
- If readability drops, use a normal loop.

## Error Handling
- Validate inputs early and fail fast.
- Raise ValueError for user-facing validation errors.
- Catch narrow exceptions and log helpful context.
- Never swallow exceptions silently.

## Tests Expectations
- Cover new logic and edge cases for every change.
- Keep tests deterministic and isolated.
- Prefer small, focused tests over one large test.
- Maintain the 95% coverage threshold.

## Documentation Updates
- Update docs whenever behavior, flags, or outputs change.
- Keep docs short; link to deeper references when needed.
- Use consistent terminology across web and CLI docs.

## Refactoring Philosophy
- Refactor only when it improves clarity or reduces risk.
- Keep changes incremental and reviewable.
- Do not mix refactors with unrelated feature work.

## Cross-Runtime Parity (Python vs JS)
- Outputs must match in columns and cleaning rules.
- Formatting may differ between CLI and web; document intentional differences.
- Keep file naming and defaults aligned unless documented.
- Date handling must convert UTC to local time in both.
- If behavior differs, document it in `docs/cli.md`.
