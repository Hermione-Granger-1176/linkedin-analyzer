/**
 * DOM construction for the guided tutorial shell.
 *
 * Builds the overlay, spotlight, pointer SVG, popover, and mini-tip layer once
 * and mounts them on document.body. The module returns the element handles and
 * reads no tutorial flow state.
 */

import { buildTutorialMascot } from "./mascot.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @typedef {object} TutorialUi
 * @property {HTMLDivElement} root
 * @property {HTMLDivElement} overlay
 * @property {HTMLDivElement} spotlight
 * @property {SVGSVGElement} pointer
 * @property {SVGPathElement} pointerMainPath
 * @property {SVGPathElement} pointerEchoPath
 * @property {SVGPathElement} pointerHeadPath
 * @property {HTMLElement} popover
 * @property {HTMLHeadingElement} title
 * @property {HTMLParagraphElement} body
 * @property {HTMLSpanElement} counter
 * @property {HTMLDivElement} dots
 * @property {HTMLButtonElement} backButton
 * @property {HTMLButtonElement} nextButton
 * @property {HTMLButtonElement} skipButton
 * @property {SVGSVGElement} mascot
 * @property {HTMLDivElement} miniTipsLayer
 */

/**
 * Create an element with a class name.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag - Element tag name
 * @param {string} className - Class name to set
 * @returns {HTMLElementTagNameMap[K]} The new element
 */
function createElement(tag, className) {
    const element = document.createElement(tag);
    element.className = className;
    return element;
}

/**
 * Create a tutorial control button.
 * @param {string} variant - Button variant, which names its `tutorial-btn-*` class
 * @param {string} label - Button text
 * @returns {HTMLButtonElement} The new button
 */
function createButton(variant, label) {
    const button = createElement("button", `tutorial-btn tutorial-btn-${variant}`);
    button.type = "button";
    button.textContent = label;
    return button;
}

/**
 * Create an empty SVG path with a class name.
 * @param {string} className - Class name to add
 * @returns {SVGPathElement} The new path
 */
function createPointerPath(className) {
    const path = document.createElementNS(SVG_NS, "path");
    path.classList.add(className);
    return path;
}

/**
 * Build the pointer SVG and its three paths.
 * @returns {Pick<TutorialUi, "pointer" | "pointerMainPath" | "pointerEchoPath" | "pointerHeadPath">}
 */
function buildPointer() {
    const pointer = document.createElementNS(SVG_NS, "svg");
    pointer.classList.add("tutorial-pointer");
    pointer.setAttribute("aria-hidden", "true");
    pointer.setAttribute("viewBox", "0 0 96 96");
    pointer.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const pointerMainPath = createPointerPath("tutorial-pointer-path-main");
    const pointerEchoPath = createPointerPath("tutorial-pointer-path-echo");
    const pointerHeadPath = createPointerPath("tutorial-pointer-head");

    pointer.appendChild(pointerEchoPath);
    pointer.appendChild(pointerMainPath);
    pointer.appendChild(pointerHeadPath);
    return { pointer, pointerMainPath, pointerEchoPath, pointerHeadPath };
}

/**
 * Build the popover footer: the step counter and dots, then the Back, Next, and Skip buttons.
 * @returns {{footer: HTMLDivElement} & Pick<TutorialUi, "counter" | "dots" | "backButton" | "nextButton" | "skipButton">}
 */
function buildFooter() {
    const footer = createElement("div", "tutorial-footer");

    const progress = createElement("div", "tutorial-progress");
    const counter = createElement("span", "tutorial-counter");
    const dots = createElement("div", "tutorial-dots");
    progress.appendChild(counter);
    progress.appendChild(dots);

    const controls = createElement("div", "tutorial-controls");
    const backButton = createButton("back", "Back");
    const nextButton = createButton("next", "Next");
    const skipButton = createButton("skip", "Skip");
    controls.appendChild(backButton);
    controls.appendChild(nextButton);
    controls.appendChild(skipButton);

    footer.appendChild(progress);
    footer.appendChild(controls);
    return { footer, counter, dots, backButton, nextButton, skipButton };
}

/**
 * Build the popover dialog with its mascot, title, text, and footer.
 * @returns {Pick<TutorialUi, "popover" | "title" | "body" | "mascot" | "counter" | "dots" | "backButton" | "nextButton" | "skipButton">}
 */
function buildPopover() {
    const popover = createElement("section", "tutorial-popover");
    popover.hidden = true;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "true");
    popover.setAttribute("aria-labelledby", "tutorialPopoverTitle");
    popover.setAttribute("aria-describedby", "tutorialPopoverBody");
    popover.tabIndex = -1;

    const title = createElement("h3", "tutorial-title");
    title.id = "tutorialPopoverTitle";

    const body = createElement("p", "tutorial-text");
    body.id = "tutorialPopoverBody";

    const { footer, ...footerParts } = buildFooter();

    // Pip is the first popover child and is positioned out of flow, so he adds
    // nothing to the card's size. He is not focusable. The stylesheet moves the
    // title's side gutter when Pip flips.
    const mascot = buildTutorialMascot();

    popover.appendChild(mascot);
    popover.appendChild(title);
    popover.appendChild(body);
    popover.appendChild(footer);
    return { popover, title, body, mascot, ...footerParts };
}

/**
 * Build the tutorial and mini-tip DOM layers and mount them on the page.
 * @returns {TutorialUi} Every element the tutorial drives
 */
export function buildTutorialShell() {
    const root = createElement("div", "tutorial-layer");
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");

    const overlay = createElement("div", "tutorial-overlay");
    const spotlight = createElement("div", "tutorial-spotlight");

    const pointerParts = buildPointer();
    const popoverParts = buildPopover();

    root.appendChild(overlay);
    root.appendChild(spotlight);

    const miniTipsLayer = createElement("div", "tutorial-mini-layer");

    document.body.appendChild(root);
    document.body.appendChild(popoverParts.popover);
    document.body.appendChild(pointerParts.pointer);
    document.body.appendChild(miniTipsLayer);
    return { root, overlay, spotlight, miniTipsLayer, ...pointerParts, ...popoverParts };
}
