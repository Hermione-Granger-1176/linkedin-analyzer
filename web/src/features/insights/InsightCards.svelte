<!--
    The Insights card grid. The screen controller owns the worker and the
    filters, and hands this component the cards from each worker reply.
-->
<script>
    import { flushSync } from "svelte";

    import { insightIcon, resolveAccentClass } from "./insight-cards.js";
    import { buildInsightReaction } from "./reactions.js";

    /** @typedef {{id: string, title: string, body: string, icon: string, accent: string}} InsightCard */

    const MAX_CARDS = 6;
    const SKELETON_CARDS = [0, 1, 2];

    /** @type {"empty"|"loading"|"cards"} */
    let mode = $state("empty");
    /** @type {InsightCard[]} */
    let cards = $state.raw([]);

    // The controller reads the grid right after it calls these, so each one
    // updates the DOM before it returns.

    /** Show placeholder cards while the first view loads. */
    export function showSkeleton() {
        mode = "loading";
        flushSync();
    }

    /**
     * Show the worker's insight cards.
     * @param {InsightCard[]} list - Cards from the worker reply
     */
    export function showCards(list) {
        cards = list.slice(0, MAX_CARDS);
        mode = "cards";
        flushSync();
    }
</script>

{#if mode === "loading"}
    {#each SKELETON_CARDS as _}
        <div class="insight-card skeleton-insight">
            <div class="skeleton-block skeleton-icon"></div>
            <div class="skeleton-body">
                <div class="skeleton-block skeleton-title"></div>
                <div class="skeleton-block skeleton-meta skeleton-meta--wide"></div>
                <div class="skeleton-block skeleton-meta skeleton-meta--mid"></div>
            </div>
        </div>
    {/each}
{:else if mode === "cards"}
    {#each cards as insight}
        {@const accent = resolveAccentClass(insight.accent)}
        <!-- Pip reacts to what the card says from its bottom-right corner. He is
        decoration on top of the card, not part of it: the PDF export is built
        from these same insight objects rather than from the DOM, so nothing
        about him reaches the document. The icon and reaction markup are fixed
        drawings from this repository, never worker text. -->
        <div class="insight-card" data-accent={accent}>
            <div class="insight-icon {accent}">{@html insightIcon(insight.icon)}</div>
            <div class="insight-body">
                <h3>{insight.title}</h3>
                <p>{insight.body}</p>
            </div>
            {@html buildInsightReaction(insight.id)}
        </div>
    {/each}
{/if}
