# ADR-011: Svelte for screen views

**Date:** 2026-10-17 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

ADR-002 chose a vanilla JavaScript app with a hand-written hash router and no UI framework. Six screens later, each screen builds its markup with template strings and `innerHTML`, escapes text by hand, and keeps its own skeleton, empty, and loaded states in sync with the DOM. That code is the bulk of every screen module, and it is where escaping and stale-state bugs come from.

Svelte compiles components to plain DOM updates at build time. Its runtime is small, it adds no virtual DOM, and a component mounts into an existing element, so a screen can move one part at a time without a rewrite.

## Decision

- Screen views may be Svelte 5 components (`.svelte` files next to the screen module). `svelte` is a pinned dependency, since its runtime ships in the bundle, and `@sveltejs/vite-plugin-svelte` a pinned dev dependency. Vite compiles components, so only the runtime parts the components use ship.
- Hash routing stays as ADR-002 describes it. `ScreenManager`, `AppRouter`, and each screen's controller remain plain modules that own routing, workers, storage, and filters.
- Workers, storage, analytics, and the cleaner stay framework-free. A component receives results the controller already has, such as worker replies, and never holds raw datasets or reads files.
- A component mounts into the element the screen's markup in `web/index.html` already provides, and exposes the few functions the controller calls to update it. Runes stay inside `.svelte` files.
- Components never set inline `style` attributes or inject `<style>` elements, so the CSP (`style-src-attr 'none'`, `style-src-elem 'self'`) holds. Styles stay in `web/src/styles/`.
- Migrate one screen part at a time, and record the bundle size and `make bench-browser` timings before and after each move. The Insights card grid moved first.

### What changes in ADR-002

ADR-002's "no UI framework" no longer holds for screen views. Its routing decision, its static-host portability, and its preference for a small, auditable dependency tree still apply, and the size budgets in `package.json` still gate every chunk.

## Consequences

- Text in a component is escaped by the compiler, and loading, empty, and loaded states come from one template instead of separate `innerHTML` writes.
- `.svelte` files are not covered by ESLint or `tsc` yet; that needs `eslint-plugin-svelte` and `svelte-check`, which are further dependencies. Until then, keep component logic thin and put anything testable in plain modules.
- Vitest compiles components through the same plugin and runs them in jsdom with the browser build of Svelte, so component tests mount the real component.
- The Svelte runtime is its own chunk (`svelte-*.js`, about 12 kB brotli) with its own `size-limit` budget, so the per-screen budget keeps measuring screen code. It loads with the first screen that mounts a component, and later screens share it. Moving the Insights card grid grew that screen chunk by 0.4 kB gzip.

## Validation

- `make test-js` mounts the Insights component and checks its skeleton, cards, escaping, and fallbacks.
- `make web-build-size` keeps every chunk inside its budget.
- `make test-e2e` covers the Insights screen in the browser.
