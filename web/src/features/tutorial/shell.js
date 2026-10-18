/**
 * DOM construction for the guided tutorial shell.
 *
 * Builds the overlay, spotlight, pointer SVG, popover, and mini-tip layer once
 * and mounts them on document.body. The caller owns the `ui` handle object and
 * passes it in, so this module only decides what the shell looks like and never
 * reads tutorial flow state.
 */

import { buildTutorialMascot } from "./mascot.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @typedef {object} TutorialUi
 * @property {HTMLDivElement | null} root
 * @property {HTMLDivElement | null} overlay
 * @property {HTMLDivElement | null} spotlight
 * @property {SVGSVGElement | null} pointer
 * @property {SVGPathElement | null} pointerMainPath
 * @property {SVGPathElement | null} pointerEchoPath
 * @property {SVGPathElement | null} pointerHeadPath
 * @property {HTMLElement | null} popover
 * @property {HTMLHeadingElement | null} title
 * @property {HTMLParagraphElement | null} body
 * @property {HTMLSpanElement | null} counter
 * @property {HTMLDivElement | null} dots
 * @property {HTMLButtonElement | null} backButton
 * @property {HTMLButtonElement | null} nextButton
 * @property {HTMLButtonElement | null} skipButton
 * @property {SVGSVGElement | null} mascot
 * @property {HTMLDivElement | null} miniTipsLayer
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
 * Build the pointer SVG and its three paths into the handle object.
 * @param {TutorialUi} ui - Handle object populated with the built elements
 * @returns {SVGSVGElement} The pointer
 */
function buildPointer(ui) {
    const pointer = document.createElementNS(SVG_NS, "svg");
    pointer.classList.add("tutorial-pointer");
    pointer.setAttribute("aria-hidden", "true");
    pointer.setAttribute("viewBox", "0 0 96 96");
    pointer.setAttribute("preserveAspectRatio", "xMidYMid meet");

    ui.pointer = pointer;
    ui.pointerMainPath = createPointerPath("tutorial-pointer-path-main");
    ui.pointerEchoPath = createPointerPath("tutorial-pointer-path-echo");
    ui.pointerHeadPath = createPointerPath("tutorial-pointer-head");

    pointer.appendChild(ui.pointerEchoPath);
    pointer.appendChild(ui.pointerMainPath);
    pointer.appendChild(ui.pointerHeadPath);
    return pointer;
}

/**
 * Build the popover footer: the step counter and dots, then the Back, Next, and Skip buttons.
 * @param {TutorialUi} ui - Handle object populated with the built elements
 * @returns {HTMLDivElement} The footer
 */
function buildFooter(ui) {
    const footer = createElement("div", "tutorial-footer");

    const progress = createElement("div", "tutorial-progress");
    ui.counter = createElement("span", "tutorial-counter");
    ui.dots = createElement("div", "tutorial-dots");
    progress.appendChild(ui.counter);
    progress.appendChild(ui.dots);

    const controls = createElement("div", "tutorial-controls");
    ui.backButton = createButton("back", "Back");
    ui.nextButton = createButton("next", "Next");
    ui.skipButton = createButton("skip", "Skip");
    controls.appendChild(ui.backButton);
    controls.appendChild(ui.nextButton);
    controls.appendChild(ui.skipButton);

    footer.appendChild(progress);
    footer.appendChild(controls);
    return footer;
}

/**
 * Build the popover dialog with its mascot, title, text, and footer.
 * @param {TutorialUi} ui - Handle object populated with the built elements
 * @returns {HTMLElement} The popover
 */
function buildPopover(ui) {
    const popover = createElement("section", "tutorial-popover");
    popover.hidden = true;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "true");
    popover.setAttribute("aria-labelledby", "tutorialPopoverTitle");
    popover.setAttribute("aria-describedby", "tutorialPopoverBody");
    popover.tabIndex = -1;
    ui.popover = popover;

    ui.title = createElement("h3", "tutorial-title");
    ui.title.id = "tutorialPopoverTitle";

    ui.body = createElement("p", "tutorial-text");
    ui.body.id = "tutorialPopoverBody";

    const footer = buildFooter(ui);

    // Pip leads the popover children and is positioned out of flow, so he adds
    // nothing to the card's own size and the focus trap never sees him. The
    // title does give up a gutter beside him, and the stylesheet moves that
    // gutter from one side to the other when he flips, so the card measures the
    // same whichever way he faces. Ahead of the title on purpose: the corner he
    // stands in changes with the step.
    ui.mascot = buildTutorialMascot();

    popover.appendChild(ui.mascot);
    popover.appendChild(ui.title);
    popover.appendChild(ui.body);
    popover.appendChild(footer);
    return popover;
}

/**
 * Build tutorial and mini-tip DOM layers into the given handle object.
 * @param {TutorialUi} ui - Handle object populated with the built elements
 */
export function buildTutorialShell(ui) {
    const root = createElement("div", "tutorial-layer");
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    ui.root = root;

    ui.overlay = createElement("div", "tutorial-overlay");
    ui.spotlight = createElement("div", "tutorial-spotlight");

    const pointer = buildPointer(ui);
    const popover = buildPopover(ui);

    root.appendChild(ui.overlay);
    root.appendChild(ui.spotlight);

    ui.miniTipsLayer = createElement("div", "tutorial-mini-layer");

    document.body.appendChild(root);
    document.body.appendChild(popover);
    document.body.appendChild(pointer);
    document.body.appendChild(ui.miniTipsLayer);
}
