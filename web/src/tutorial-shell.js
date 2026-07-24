/**
 * DOM construction for the guided tutorial shell.
 *
 * Builds the overlay, spotlight, pointer SVG, popover, and mini-tip layer once
 * and mounts them on document.body. The caller owns the `ui` handle object and
 * passes it in, so this module only decides what the shell looks like and never
 * reads tutorial flow state.
 */

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
 * @property {HTMLDivElement | null} miniTipsLayer
 */

/**
 * Build tutorial and mini-tip DOM layers into the given handle object.
 * @param {TutorialUi} ui - Handle object populated with the built elements
 */
export function buildTutorialShell(ui) {
    ui.root = document.createElement("div");
    ui.root.className = "tutorial-layer";
    ui.root.hidden = true;
    ui.root.setAttribute("aria-hidden", "true");

    ui.overlay = document.createElement("div");
    ui.overlay.className = "tutorial-overlay";

    ui.spotlight = document.createElement("div");
    ui.spotlight.className = "tutorial-spotlight";

    ui.pointer = document.createElementNS(SVG_NS, "svg");
    ui.pointer.classList.add("tutorial-pointer");
    ui.pointer.setAttribute("aria-hidden", "true");
    ui.pointer.setAttribute("viewBox", "0 0 96 96");
    ui.pointer.setAttribute("preserveAspectRatio", "xMidYMid meet");

    ui.pointerMainPath = document.createElementNS(SVG_NS, "path");
    ui.pointerMainPath.classList.add("tutorial-pointer-path-main");

    ui.pointerEchoPath = document.createElementNS(SVG_NS, "path");
    ui.pointerEchoPath.classList.add("tutorial-pointer-path-echo");

    ui.pointerHeadPath = document.createElementNS(SVG_NS, "path");
    ui.pointerHeadPath.classList.add("tutorial-pointer-head");

    ui.pointer.appendChild(ui.pointerEchoPath);
    ui.pointer.appendChild(ui.pointerMainPath);
    ui.pointer.appendChild(ui.pointerHeadPath);

    ui.popover = document.createElement("section");
    ui.popover.className = "tutorial-popover";
    ui.popover.hidden = true;
    ui.popover.setAttribute("role", "dialog");
    ui.popover.setAttribute("aria-modal", "true");
    ui.popover.setAttribute("aria-labelledby", "tutorialPopoverTitle");
    ui.popover.setAttribute("aria-describedby", "tutorialPopoverBody");
    ui.popover.tabIndex = -1;

    ui.title = document.createElement("h3");
    ui.title.className = "tutorial-title";
    ui.title.id = "tutorialPopoverTitle";

    ui.body = document.createElement("p");
    ui.body.className = "tutorial-text";
    ui.body.id = "tutorialPopoverBody";

    const footer = document.createElement("div");
    footer.className = "tutorial-footer";

    const progress = document.createElement("div");
    progress.className = "tutorial-progress";

    ui.counter = document.createElement("span");
    ui.counter.className = "tutorial-counter";

    ui.dots = document.createElement("div");
    ui.dots.className = "tutorial-dots";

    progress.appendChild(ui.counter);
    progress.appendChild(ui.dots);

    const controls = document.createElement("div");
    controls.className = "tutorial-controls";

    ui.backButton = document.createElement("button");
    ui.backButton.type = "button";
    ui.backButton.className = "tutorial-btn tutorial-btn-back";
    ui.backButton.textContent = "Back";

    ui.nextButton = document.createElement("button");
    ui.nextButton.type = "button";
    ui.nextButton.className = "tutorial-btn tutorial-btn-next";
    ui.nextButton.textContent = "Next";

    ui.skipButton = document.createElement("button");
    ui.skipButton.type = "button";
    ui.skipButton.className = "tutorial-btn tutorial-btn-skip";
    ui.skipButton.textContent = "Skip";

    controls.appendChild(ui.backButton);
    controls.appendChild(ui.nextButton);
    controls.appendChild(ui.skipButton);

    footer.appendChild(progress);
    footer.appendChild(controls);

    ui.popover.appendChild(ui.title);
    ui.popover.appendChild(ui.body);
    ui.popover.appendChild(footer);

    ui.root.appendChild(ui.overlay);
    ui.root.appendChild(ui.spotlight);

    ui.miniTipsLayer = document.createElement("div");
    ui.miniTipsLayer.className = "tutorial-mini-layer";

    document.body.appendChild(ui.root);
    document.body.appendChild(ui.popover);
    document.body.appendChild(ui.pointer);
    document.body.appendChild(ui.miniTipsLayer);
}
