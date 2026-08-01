/* Pip's stamp-sized reactions for the insight cards.

   Every card gets one small pose in its bottom-right corner, picked to match
   what the card is saying: a flex for a rising trend, a doze for a quiet
   stretch, a trophy for a top topic. The markup is built here rather than
   inlined in index.html because the cards themselves are built in JS, and
   because a dozen full poses in the page source would bury the content.

   Poses share one bust drawn in the same coordinate space as the hero Pip in
   index.html, so only the brows, the eyes, the mouth, and the arms change from
   one to the next. The wobble filter is the shared #pipWobble already defined
   in that document. */

/* Square crop around the bust: head and hair at the top, the jacket running off
   the bottom edge, and enough room out to the right for a raised arm and
   whatever it is holding. Props are drawn deliberately large for their owner:
   this whole box renders at 56px, so anything hand-sized in real proportions
   would be four pixels of mush. */
const REACTION_VIEWBOX = "26 4 98 98";

/* Hood, head and ears, drawn before the face so the fringe can overlap it. */
const BUST = `
    <path
        class="pip-ink pip-hood"
        d="M53 86 C48 76 51 62 62 63 C65 68 75 68 78 63 C89 62 92 76 87 86 Q70 90 53 86 Z"
    />
    <circle class="pip-ink pip-paper" cx="70" cy="46" r="22" />
    <path class="pip-ink" d="M48 46 Q43 49 48 54" />
    <path class="pip-ink" d="M92 46 Q97 49 92 54" />`;

const BROWS_HAPPY = `
    <path class="pip-ink pip-brow" d="M57.5 39 Q62 35.5 66.5 38.5" />
    <path class="pip-ink pip-brow" d="M82.5 38 Q78 34.5 73.5 37.5" />`;

/* Lifted clear of the eyes: the difference between pleased and proud. */
const BROWS_PROUD = `
    <path class="pip-ink pip-brow" d="M57.5 36.5 Q62 32.5 66.5 36" />
    <path class="pip-ink pip-brow" d="M82.5 35.5 Q78 31.5 73.5 35" />`;

/* Flat and low, for the poses where Pip is running out of steam. */
const BROWS_SLEEPY = `
    <path class="pip-ink pip-brow" d="M57 40 Q62 38.6 67 40.6" />
    <path class="pip-ink pip-brow" d="M83 40 Q78 38.6 73 40.6" />`;

const EYES_OPEN = `
    <g class="insight-reaction-blink">
        <circle class="pip-eye" cx="62" cy="44" r="3.6" />
        <circle class="pip-eye" cx="78" cy="44" r="3.6" />
    </g>`;

/* Arcs curving up: eyes squeezed shut by a grin. */
const EYES_HAPPY = `
    <path class="pip-ink" d="M57.6 45.6 Q62 40.4 66.4 45.6" />
    <path class="pip-ink" d="M73.6 45.6 Q78 40.4 82.4 45.6" />`;

/* The same arcs the other way up: lids down, fast asleep. Dropped clear of the
   sleepy brows above them, because a lid stroke that touches a brow stroke
   closes into one dark almond, and a dark almond reads as a glare. */
const EYES_ASLEEP = `
    <path class="pip-ink" d="M56.8 45 Q62 50.6 67.2 45" />
    <path class="pip-ink" d="M72.8 45 Q78 50.6 83.2 45" />`;

const NOSE = `
    <path class="pip-ink" d="M70 47 Q73 51 69 52" />`;

const MOUTH_GRIN = `
    <path class="pip-ink pip-solid" d="M60 55 Q70 69 80 55 Q70 61 60 55 Z" />`;

const MOUTH_SMILE = `
    <path class="pip-ink" d="M62 56 Q70 63 78 56" />`;

/* Doubles as a snore and a yawn. */
const MOUTH_ROUND = `
    <ellipse class="pip-ink pip-paper" cx="70" cy="58" rx="3.6" ry="2.8" />`;

const HAIR = `
    <path
        class="pip-hair"
        d="M52 34 C48 26 50 18 60 15 C70 11 82 14 87 22 C91 28 91 33 90 39 L87 44 Q86 34 83.5 37 Q80 24 77 30 Q74 22 70 32 Q67 22 63 30 Q59.5 21 56 31 Z"
    />
    <path class="pip-wisp" d="M74 12 q5 -3 9 0" />
    <path class="pip-wisp" d="M64 13.4 q3 -3 6 -1" />`;

/* Collar, zip, jacket and drawstrings. The jacket runs past the bottom of the
   crop on purpose, so Pip reads as standing behind the card's lower edge. */
const TORSO = `
    <path class="pip-ink" d="M58 66 C62 72 78 72 82 66" />
    <path class="pip-ink" d="M70 68 L70 77" />
    <path class="pip-ink pip-jacket" d="M54 81 Q70 74 86 81 L89 112 Q70 118 51 112 Z" />
    <path class="pip-ink" d="M63 78 Q70 85 77 78" />
    <path class="pip-cord" d="M65 83 q-2 5 -1 8" />
    <ellipse class="pip-aglet" cx="64" cy="93" rx="2" ry="2.8" />
    <path class="pip-cord" d="M75 83 q2 5 1 8" />
    <ellipse class="pip-aglet" cx="76" cy="93" rx="2" ry="2.8" />`;

const ARM_LEFT_REST = `
    <path class="pip-ink" d="M55 84 Q44 92 43 102" />`;

const ARMS_REST = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 84 Q96 92 97 102" />`;

/* Both elbows out and both fists up by the cheeks: at 56 pixels the bent-arm
   silhouette is the whole of the flex, and the short line inside each bend is
   the only bicep there is room for. */
const ARMS_FLEX = `
    <path class="pip-ink" d="M55 84 Q34 84 36 68 Q38 58 46 56" />
    <path class="pip-ink" d="M85 84 Q106 84 104 68 Q102 58 94 56" />
    <path class="pip-ink" d="M50 77 Q44 70 45 63" />
    <path class="pip-ink" d="M90 77 Q96 70 95 63" />
    <circle class="pip-ink pip-paper" cx="48" cy="52" r="8" />
    <circle class="pip-ink pip-paper" cx="92" cy="52" r="8" />`;

/* A fist with the thumb out, drawn behind it so the two read as one hand.
   Everything here is about not reading as the other gesture at 56 pixels: the
   thumb is short and fat rather than tall and narrow, it leaves the fist at the
   top corner on a diagonal rather than straight up, and the three scallops down
   the near side of the fist are the curled fingers it is clearly attached to. */
const ARMS_THUMBS_UP = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 84 Q99 82 101 75" />
    <path class="pip-ink pip-paper" d="M99.6 54.1 L112.1 41.6 A5.5 5.5 0 0 1 119.9 49.4 L107.4 61.9 Z" />
    <path
        class="pip-ink pip-paper"
        d="M96.5 75 a3.8 3.8 0 0 1 0 -7.6 a3.8 3.8 0 0 1 0 -7.6 a3.8 3.8 0 0 1 0 -7.6 H108.5 Q114.5 52.2 114.5 58.2 V69 Q114.5 75 108.5 75 Z"
    />`;

/* A cup held up at head height, big enough to be a cup at 56 pixels. */
const ARMS_TROPHY = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 84 Q99 82 102 74" />
    <circle class="pip-ink pip-paper" cx="103" cy="68" r="7" />
    <path class="pip-ink" d="M96 60 H110" />
    <path class="pip-ink" d="M103 60 V54" />
    <path class="pip-ink" d="M96 36 Q87 36 87 43 Q87 50 95 51" />
    <path class="pip-ink" d="M110 36 Q119 36 119 43 Q119 50 111 51" />
    <path class="pip-ink pip-pencil" d="M95 34 H111 V44 Q111 54 103 54 Q95 54 95 44 Z" />`;

/* Both arms up and out in a waking-up stretch. */
const ARMS_STRETCH = `
    <path class="pip-ink" d="M55 84 Q40 74 36 60" />
    <circle class="pip-ink pip-paper" cx="35" cy="54" r="7" />
    <path class="pip-ink" d="M85 84 Q100 74 104 60" />
    <circle class="pip-ink pip-paper" cx="105" cy="54" r="7" />`;

/* A steaming mug for the hours after everyone else has logged off. */
const ARMS_MUG = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 84 Q99 82 102 74" />
    <circle class="pip-ink pip-paper" cx="103" cy="68" r="7" />
    <path class="pip-ink" d="M114 48 Q122 48 122 55 Q122 62 114 62" />
    <path class="pip-ink pip-paper" d="M97 42 H114 V58 Q114 64 105.5 64 Q97 64 97 58 Z" />
    <path class="pip-ink" d="M102 36 q5 -4 0 -9" />
    <path class="pip-ink" d="M110 36 q5 -4 0 -9" />`;

/* Arms hanging, and the two beads of sweat of a job just finished. */
const ARMS_BREATHER = `
    <path class="pip-ink" d="M55 84 Q42 94 44 104" />
    <path class="pip-ink" d="M85 84 Q98 94 96 104" />
    <ellipse class="pip-drop" cx="100" cy="30" rx="4.2" ry="5.6" />
    <ellipse class="pip-drop" cx="108" cy="45" rx="2.8" ry="3.8" />`;

/* Tucked in, with a "z" drifting off the top corner. Kept well inside the right
   edge: the lean below swings it further out, and it drifts further still. */
const ARMS_DOZE = `
    <path class="pip-ink" d="M55 84 Q47 94 53 101" />
    <path class="pip-ink" d="M85 84 Q93 94 87 101" />
    <path class="pip-ink insight-reaction-zzz" d="M92 26 h14 l-14 16 h14" />`;

/* Pointing off to one side, under an arrow bending the same way. */
const ARMS_POINT = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 84 Q101 82 108 76" />
    <circle class="pip-ink pip-paper" cx="110" cy="72" r="6" />
    <path class="pip-ink" d="M96 46 Q110 38 119 46" />
    <path class="pip-ink" d="M114 40 L120 46 L114 52" />`;

/* An open palm, held up for someone to hit. Fingers first, so the palm covers
   where they join it. */
const ARMS_HIGH_FIVE = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 84 Q102 80 105 70" />
    <path class="pip-ink pip-paper" d="M98 58 V46 Q98 42 101 42 Q104 42 104 46 V58 Z" />
    <path class="pip-ink pip-paper" d="M104 58 V42 Q104 38 107 38 Q110 38 110 42 V58 Z" />
    <path class="pip-ink pip-paper" d="M110 58 V46 Q110 42 113 42 Q116 42 116 46 V58 Z" />
    <circle class="pip-ink pip-paper" cx="106" cy="62" r="9" />`;

/* One fist punched high, with the ticks that followed it up. */
const ARMS_PUNCH = `${ARM_LEFT_REST}
    <path class="pip-ink" d="M85 85 Q101 80 101 62" />
    <circle class="pip-ink pip-paper" cx="101" cy="52" r="9" />
    <path class="pip-ink" d="M108 33 l5 -8" />
    <path class="pip-ink" d="M112 42 l8 -6" />
    <path class="pip-ink" d="M114 52 l9 -3" />`;

/* Arms down, a speech bubble mid-sentence beside his head. */
const ARMS_SPEECH = `${ARMS_REST}
    <path
        class="pip-ink pip-paper"
        d="M96 14 H116 Q121 14 121 19 V29 Q121 34 116 34 H106 L99 40 V34 H96 Q91 34 91 29 V19 Q91 14 96 14 Z"
    />
    <circle class="pip-eye" cx="99" cy="24" r="2.2" />
    <circle class="pip-eye" cx="106" cy="24" r="2.2" />
    <circle class="pip-eye" cx="113" cy="24" r="2.2" />`;

/* Upright unless the pose leans; the doze tips into the card's edge. */
const UPRIGHT = "rotate(0 70 96)";
const LEAN_RIGHT = "rotate(8 70 96)";

/**
 * Assemble one pose from its interchangeable parts.
 * @param {string} brows - Brow markup.
 * @param {string} eyes - Eye markup.
 * @param {string} mouth - Mouth markup.
 * @param {string} arms - Arm and prop markup, drawn over the jacket.
 * @param {string} [lean] - Transform for the whole figure.
 * @returns {{ body: string, lean: string }} A ready-to-stamp pose.
 */
function pose(brows, eyes, mouth, arms, lean = UPRIGHT) {
    return {
        body: `${BUST}${brows}${eyes}${NOSE}${mouth}${HAIR}${TORSO}${arms}`,
        lean,
    };
}

/* Nothing else is known about the card, so Pip just stands there pleasantly. */
const FALLBACK_POSE = pose(BROWS_HAPPY, EYES_OPEN, MOUTH_SMILE, ARMS_REST);

/**
 * Poses keyed by the insight ids generated in features/analytics/insights.js.
 * Every id that file can emit has an entry here; anything else falls back. A
 * Map rather than an object literal so a worker-supplied "constructor" or
 * "toString" misses instead of pulling something off Object.prototype.
 * @type {Map<unknown, {body: string, lean: string}>}
 */
const POSES = new Map([
    ["early-bird", pose(BROWS_HAPPY, EYES_HAPPY, MOUTH_ROUND, ARMS_STRETCH)],
    ["night-owl", pose(BROWS_SLEEPY, EYES_OPEN, MOUTH_SMILE, ARMS_MUG)],
    ["steady-pace", pose(BROWS_HAPPY, EYES_OPEN, MOUTH_SMILE, ARMS_THUMBS_UP)],
    ["trending-up", pose(BROWS_PROUD, EYES_OPEN, MOUTH_GRIN, ARMS_FLEX)],
    ["slowing", pose(BROWS_SLEEPY, EYES_HAPPY, MOUTH_SMILE, ARMS_BREATHER)],
    ["topic-shift", pose(BROWS_HAPPY, EYES_OPEN, MOUTH_SMILE, ARMS_POINT)],
    ["engagement-shift", pose(BROWS_HAPPY, EYES_OPEN, MOUTH_SMILE, ARMS_SPEECH)],
    ["quiet-stretch", pose(BROWS_SLEEPY, EYES_ASLEEP, MOUTH_ROUND, ARMS_DOZE, LEAN_RIGHT)],
    ["super-engager", pose(BROWS_HAPPY, EYES_OPEN, MOUTH_GRIN, ARMS_HIGH_FIVE)],
    ["topic-master", pose(BROWS_HAPPY, EYES_OPEN, MOUTH_GRIN, ARMS_TROPHY)],
    ["streak", pose(BROWS_PROUD, EYES_OPEN, MOUTH_GRIN, ARMS_PUNCH)],
    ["weekday", pose(BROWS_HAPPY, EYES_OPEN, MOUTH_SMILE, ARMS_THUMBS_UP)],
]);

/**
 * Build the reaction stamp for one insight card.
 *
 * The id only ever selects a pose from the table above, so an unexpected value
 * from the worker can reach the markup no more than an unexpected accent can.
 * The result is decoration: hidden from assistive technology, out of the card's
 * flow, and deaf to the pointer.
 * @param {unknown} insightId - The `id` on the insight the card was built from.
 * @returns {string} SVG markup for the card's corner.
 */
export function buildInsightReaction(insightId) {
    const chosen = POSES.get(insightId) || FALLBACK_POSE;
    return `<svg
        class="insight-reaction"
        viewBox="${REACTION_VIEWBOX}"
        aria-hidden="true"
        focusable="false"
    ><g filter="url(#pipWobble)"><g transform="${chosen.lean}"><g class="insight-reaction-bob">${chosen.body}
    </g></g></g></svg>`;
}
