/* Lets JavaScript modules import Svelte components; tsc does not read .svelte files. */

declare module "*.svelte" {
    import type { Component } from "svelte";

    const component: Component<Record<string, unknown>, Record<string, unknown>>;
    export default component;
}
