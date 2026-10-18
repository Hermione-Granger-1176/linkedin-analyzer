# ADR-011: Svelte for screen views

**Date:** 2026-10-17 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

ADR-002 chose a vanilla JavaScript app with a hand-written hash router and no UI framework. The app grew to six screens that built markup with template strings and `innerHTML`. Each screen escaped text manually and synchronized its loading, empty, and loaded states with the DOM. Repeating that logic increased the risk of escaping and stale-state bugs.

Svelte compiles components to DOM updates at build time without a virtual DOM. A component mounts into an existing element, allowing each screen to migrate in parts.

## Decision

- Screen views may use Svelte 5 components in `.svelte` files next to the screen module. `svelte` is a pinned runtime dependency. `@sveltejs/vite-plugin-svelte` is a pinned development dependency. Vite compiles components and includes the runtime code they use.
- Hash routing stays as ADR-002 describes it. `ScreenManager`, `AppRouter`, and each screen's controller remain plain modules that own routing, workers, storage, and filters.
- Workers, storage, analytics, and the cleaner stay framework-free. A component receives results the controller already has, such as worker replies, and never holds raw datasets or reads files.
- A component mounts into the element the screen's markup in `web/index.html` already provides, and exposes the few functions the controller calls to update it. Runes stay inside `.svelte` files.
- Components never set inline `style` attributes or inject `<style>` elements, so the CSP (`style-src-attr 'none'`, `style-src-elem 'self'`) holds. Styles stay in `web/src/styles/`.
- Migrate one screen part at a time, and record the bundle size and `make bench-browser` timings before and after each move. The Insights card grid moved first.

### What changes in ADR-002

ADR-002's "no UI framework" no longer holds for screen views. Its routing decision, its static-host portability, and its preference for a small, auditable dependency tree still apply, and the size budgets in `package.json` still gate every chunk.

## Consequences

- Text in a component is escaped by the compiler, and loading, empty, and loaded states come from one template instead of separate `innerHTML` writes.
- ESLint and `tsc` do not check `.svelte` files. Those checks require `eslint-plugin-svelte` and `svelte-check`. Component logic stays small, with testable calculations in plain modules.
- Vitest compiles components through the same plugin and runs them in jsdom with the browser build of Svelte, so component tests mount the real component.
- The Svelte runtime is its own chunk (`svelte-*.js`, about 12 kB brotli) with its own `size-limit` budget, so the per-screen budget keeps measuring screen code. It loads with the first screen that mounts a component, and later screens share it. Moving the Insights card grid grew that screen chunk by 0.4 kB gzip.

## Validation

- `make test-js` mounts the Insights component and checks its skeleton, cards, escaping, and fallbacks.
- `make web-build-size` keeps every chunk inside its budget.
- `make test-e2e` covers the Insights screen in the browser.
