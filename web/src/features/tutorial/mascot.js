/**
 * Pip, the guide who stands on the tutorial callout card.
 *
 * One drawing carries both poses: everything except the right arm is shared,
 * and the two arm groups are switched by CSS off the `data-pose` attribute.
 * That keeps a step change to two attribute writes, which is all the variety
 * the tour needs. He is decoration, so the SVG is aria-hidden and unfocusable
 * and the stylesheet keeps him out of the pointer's way.
 *
 * Both hands are inked fingers first and palm last, so the palm covers where
 * they join it. The card renders him at 40px, 34px on a phone, which is why the
 * hands are drawn as large as they are: a hand in real proportions would be a
 * few pixels of mush, and the pose it is meant to be reading would go with it.
 *
 * Everything from the hood down to the drawstrings is the shared Pip in
 * shared/ui/pip-parts.js; the extra wisp, the arms and the legs are his own.
 */

import {
    PIP_BROWS_HAPPY,
    PIP_BUST,
    PIP_EYES,
    PIP_HAIR,
    PIP_MOUTH_GRIN,
    PIP_NOSE,
    PIP_TORSO,
} from "../../shared/ui/pip-parts.js";

const MASCOT_MARKUP = `
<svg
    class="tutorial-mascot"
    data-pose="present"
    data-facing="right"
    viewBox="38 4 92 152"
    aria-hidden="true"
    focusable="false"
>
    <g filter="url(#pipWobble)">${PIP_BUST}${PIP_BROWS_HAPPY}
        <g class="pip-blink">${PIP_EYES}
        </g>${PIP_NOSE}${PIP_MOUTH_GRIN}${PIP_HAIR}
        <path class="pip-wisp" d="M53 33 q-2 4 -1 7" />${PIP_TORSO}
        <path class="pip-ink" d="M58 100 Q70 106 82 100 L81 108 Q70 112 59 108 Z" />
        <path class="pip-ink" d="M55 84 Q44 96 43 108" />
        <circle class="pip-ink pip-paper" cx="42" cy="111" r="4" />
        <g class="tutorial-mascot-arm" data-pose="present">
            <path class="pip-ink" d="M86 84 Q99 83 107 78" />
            <path
                class="pip-ink pip-paper"
                d="M111.1 72.6 L123.1 68.1 Q126.5 66.8 127.4 69.2 Q128.3 71.7 124.9 72.9 L112.9 77.4 Z"
            />
            <path
                class="pip-ink pip-paper"
                d="M108.3 72.1 L112.3 65.6 Q114.2 62.6 116.4 63.9 Q118.6 65.3 116.7 68.4 L112.7 74.9 Z"
            />
            <circle class="pip-ink pip-paper" cx="111.5" cy="75.5" r="6.6" />
        </g>
        <g class="tutorial-mascot-arm" data-pose="wave">
            <path class="pip-ink" d="M85 84 Q101 79 106 65" />
            <path
                class="pip-ink pip-paper"
                d="M101.3 55.7 L97.8 42.7 Q96.8 39.1 99.5 38.3 Q102.2 37.6 103.2 41.3 L106.7 54.3 Z"
            />
            <path
                class="pip-ink pip-paper"
                d="M106.7 54.1 L106.2 38.6 Q106.1 34.8 108.9 34.7 Q111.7 34.6 111.8 38.4 L112.3 53.9 Z"
            />
            <path
                class="pip-ink pip-paper"
                d="M112.3 54.3 L115.8 41.3 Q116.8 37.6 119.5 38.3 Q122.2 39.1 121.2 42.7 L117.7 55.7 Z"
            />
            <path
                class="pip-ink pip-paper"
                d="M108.8 59.4 L120.8 62.9 Q124.3 63.9 123.6 66.5 Q122.8 69.1 119.2 68.1 L107.2 64.6 Z"
            />
            <circle class="pip-ink pip-paper" cx="110" cy="57" r="8.4" />
        </g>
        <path class="pip-ink" d="M62 115 Q58 129 59 145" />
        <path class="pip-ink" d="M79 115 Q83 129 82 145" />
        <path class="pip-ink pip-solid" d="M59 145 Q50 146 50 150 L61 150 Z" />
        <path class="pip-ink pip-solid" d="M82 145 Q91 146 91 150 L80 150 Z" />
    </g>
</svg>
`;

/**
 * Build the decorative tutorial mascot.
 * @returns {SVGSVGElement}
 */
export function buildTutorialMascot() {
    const holder = document.createElement("div");
    holder.innerHTML = MASCOT_MARKUP.trim();
    return /** @type {SVGSVGElement} */ (/** @type {unknown} */ (holder.firstElementChild));
}

/**
 * Pick the pose for the step being shown.
 * @param {SVGSVGElement | null} mascot - Mascot element
 * @param {boolean} isLastStep - Whether the tour ends on this step
 */
export function setTutorialMascotPose(mascot, isLastStep) {
    if (!mascot) {
        return;
    }
    mascot.dataset.pose = isLastStep ? "wave" : "present";
}

/**
 * Turn Pip toward the highlighted target so he gestures the way the arrow does.
 * @param {SVGSVGElement | null} mascot - Mascot element
 * @param {boolean} facesLeft - Whether the target sits left of the card
 */
export function setTutorialMascotFacing(mascot, facesLeft) {
    if (!mascot) {
        return;
    }
    mascot.dataset.facing = facesLeft ? "left" : "right";
}
