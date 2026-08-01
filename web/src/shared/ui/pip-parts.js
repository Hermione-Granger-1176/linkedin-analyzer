/* The pieces of Pip that more than one drawing of him is built from.

   Everything here is in the same coordinate space as the hero Pip in
   index.html, so a part drops into any drawing of him without rescaling. What
   changes from one drawing to the next is the face, the arms and how much of
   him is in frame, and that stays with whoever is drawing him. */

/* Hood, head and ears, drawn before the face so the fringe can overlap it. */
export const PIP_BUST = `
    <path
        class="pip-ink pip-hood"
        d="M53 86 C48 76 51 62 62 63 C65 68 75 68 78 63 C89 62 92 76 87 86 Q70 90 53 86 Z"
    />
    <circle class="pip-ink pip-paper" cx="70" cy="46" r="22" />
    <path class="pip-ink" d="M48 46 Q43 49 48 54" />
    <path class="pip-ink" d="M92 46 Q97 49 92 54" />`;

export const PIP_BROWS_HAPPY = `
    <path class="pip-ink pip-brow" d="M57.5 39 Q62 35.5 66.5 38.5" />
    <path class="pip-ink pip-brow" d="M82.5 38 Q78 34.5 73.5 37.5" />`;

/* The eyes on their own: each drawing wraps them in its own blinking group. */
export const PIP_EYES = `
    <circle class="pip-eye" cx="62" cy="44" r="3.6" />
    <circle class="pip-eye" cx="78" cy="44" r="3.6" />`;

export const PIP_NOSE = `
    <path class="pip-ink" d="M70 47 Q73 51 69 52" />`;

export const PIP_MOUTH_GRIN = `
    <path class="pip-ink pip-solid" d="M60 55 Q70 69 80 55 Q70 61 60 55 Z" />`;

/* The fringe and the two wisps standing off the top of it. A drawing with room
   beside his ear adds a third wisp there itself. */
export const PIP_HAIR = `
    <path
        class="pip-hair"
        d="M52 34 C48 26 50 18 60 15 C70 11 82 14 87 22 C91 28 91 33 90 39 L87 44 Q86 34 83.5 37 Q80 24 77 30 Q74 22 70 32 Q67 22 63 30 Q59.5 21 56 31 Z"
    />
    <path class="pip-wisp" d="M74 12 q5 -3 9 0" />
    <path class="pip-wisp" d="M64 13.4 q3 -3 6 -1" />`;

/* Collar, zip, jacket and drawstrings. */
export const PIP_TORSO = `
    <path class="pip-ink" d="M58 66 C62 72 78 72 82 66" />
    <path class="pip-ink" d="M70 68 L70 77" />
    <path class="pip-ink pip-jacket" d="M54 81 Q70 74 86 81 L89 112 Q70 118 51 112 Z" />
    <path class="pip-ink" d="M63 78 Q70 85 77 78" />
    <path class="pip-cord" d="M65 83 q-2 5 -1 8" />
    <ellipse class="pip-aglet" cx="64" cy="93" rx="2" ry="2.8" />
    <path class="pip-cord" d="M75 83 q2 5 1 8" />
    <ellipse class="pip-aglet" cx="76" cy="93" rx="2" ry="2.8" />`;
