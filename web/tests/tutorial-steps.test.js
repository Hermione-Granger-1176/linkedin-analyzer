import { describe, expect, it } from 'vitest';

import { TutorialMiniTips, TutorialSteps } from '../src/tutorial-steps.js';

// ---------------------------------------------------------------------------
// Expected routes
// ---------------------------------------------------------------------------

const EXPECTED_ROUTES = ['home', 'clean', 'analytics', 'connections', 'messages', 'insights'];

// ---------------------------------------------------------------------------
// Shape validators
// ---------------------------------------------------------------------------

/**
 * Assert that a single tutorial step has the required shape.
 */
function assertStepShape(step, route) {
    expect(typeof step.id).toBe('string');
    expect(step.id.length).toBeGreaterThan(0);

    expect(step.route).toBe(route);

    expect(typeof step.title).toBe('string');
    expect(step.title.length).toBeGreaterThan(0);

    expect(typeof step.body).toBe('string');
    expect(step.body.length).toBeGreaterThan(0);

    expect(typeof step.target).toBe('string');
    expect(step.target.length).toBeGreaterThan(0);

    expect(typeof step.fallbackTarget).toBe('string');
    expect(step.fallbackTarget.length).toBeGreaterThan(0);

    expect(['top', 'bottom', 'left', 'right']).toContain(step.placement);

    expect(typeof step.allowSkip).toBe('boolean');
    expect(typeof step.allowBack).toBe('boolean');
    expect(typeof step.allowNext).toBe('boolean');
}

/**
 * Assert that a single mini-tip has the required shape.
 */
function assertMiniTipShape(tip, route) {
    expect(typeof tip.id).toBe('string');
    expect(tip.id.length).toBeGreaterThan(0);

    expect(tip.route).toBe(route);

    expect(typeof tip.target).toBe('string');
    expect(tip.target.length).toBeGreaterThan(0);

    expect(typeof tip.fallbackTarget).toBe('string');
    expect(tip.fallbackTarget.length).toBeGreaterThan(0);

    expect(['top', 'bottom', 'left', 'right']).toContain(tip.placement);

    expect(typeof tip.title).toBe('string');
    expect(tip.title.length).toBeGreaterThan(0);

    expect(typeof tip.body).toBe('string');
    expect(tip.body.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// TutorialSteps — module-level
// ---------------------------------------------------------------------------

describe('TutorialSteps', () => {
    it('is importable without error', () => {
        expect(TutorialSteps).toBeDefined();
    });

    it('is a plain object (not an array or null)', () => {
        expect(typeof TutorialSteps).toBe('object');
        expect(TutorialSteps).not.toBeNull();
        expect(Array.isArray(TutorialSteps)).toBe(false);
    });

    it('is frozen (immutable)', () => {
        expect(Object.isFrozen(TutorialSteps)).toBe(true);
    });

    it('has entries for every expected route', () => {
        for (const route of EXPECTED_ROUTES) {
            expect(Object.prototype.hasOwnProperty.call(TutorialSteps, route)).toBe(true);
        }
    });

    it('has exactly the expected routes and no extras', () => {
        const actualRoutes = Object.keys(TutorialSteps).sort();
        expect(actualRoutes).toEqual([...EXPECTED_ROUTES].sort());
    });

    it('each route entry is a non-empty array', () => {
        for (const route of EXPECTED_ROUTES) {
            const steps = TutorialSteps[route];
            expect(Array.isArray(steps)).toBe(true);
            expect(steps.length).toBeGreaterThan(0);
        }
    });

    it('every step id is unique across all routes', () => {
        const allIds = EXPECTED_ROUTES.flatMap((r) => TutorialSteps[r].map((s) => s.id));
        const uniqueIds = new Set(allIds);
        expect(uniqueIds.size).toBe(allIds.length);
    });
});

// ---------------------------------------------------------------------------
// TutorialSteps — per-route entry counts
// ---------------------------------------------------------------------------

describe('TutorialSteps entry counts', () => {
    it('home has 5 steps', () => {
        expect(TutorialSteps.home.length).toBe(5);
    });

    it('clean has 4 steps', () => {
        expect(TutorialSteps.clean.length).toBe(4);
    });

    it('analytics has 4 steps', () => {
        expect(TutorialSteps.analytics.length).toBe(4);
    });

    it('connections has 4 steps', () => {
        expect(TutorialSteps.connections.length).toBe(4);
    });

    it('messages has 4 steps', () => {
        expect(TutorialSteps.messages.length).toBe(4);
    });

    it('insights has 4 steps', () => {
        expect(TutorialSteps.insights.length).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// TutorialSteps — per-route shape checks
// ---------------------------------------------------------------------------

describe('TutorialSteps step shapes', () => {
    for (const route of EXPECTED_ROUTES) {
        describe(`route: ${route}`, () => {
            it('every step has the required fields', () => {
                for (const step of TutorialSteps[route]) {
                    assertStepShape(step, route);
                }
            });

            it('every step has allowSkip, allowBack, allowNext all true', () => {
                for (const step of TutorialSteps[route]) {
                    expect(step.allowSkip).toBe(true);
                    expect(step.allowBack).toBe(true);
                    expect(step.allowNext).toBe(true);
                }
            });
        });
    }
});

// ---------------------------------------------------------------------------
// TutorialSteps — spot-check known step content
// ---------------------------------------------------------------------------

describe('TutorialSteps known content', () => {
    it('home first step is the welcome step', () => {
        const step = TutorialSteps.home[0];
        expect(step.id).toBe('home-welcome');
        expect(step.title).toContain('Welcome');
        expect(step.placement).toBe('bottom');
    });

    it('home has an upload zone step', () => {
        const step = TutorialSteps.home.find((s) => s.id === 'home-upload-zone');
        expect(step).toBeDefined();
        expect(step.target).toBe('#multiDropZone');
    });

    it('analytics has a filters step targeting the time range buttons', () => {
        const step = TutorialSteps.analytics.find((s) => s.id === 'analytics-filters');
        expect(step).toBeDefined();
        expect(step.target).toBe('#analyticsTimeRangeButtons');
    });

    it('connections has a metrics step targeting the stats grid', () => {
        const step = TutorialSteps.connections.find((s) => s.id === 'connections-metrics');
        expect(step).toBeDefined();
        expect(step.target).toBe('#connectionsStatsGrid');
    });

    it('messages has an export step', () => {
        const step = TutorialSteps.messages.find((s) => s.id === 'messages-export');
        expect(step).toBeDefined();
        expect(step.placement).toBe('left');
    });

    it('insights has a cards step targeting the insights grid', () => {
        const step = TutorialSteps.insights.find((s) => s.id === 'insights-cards');
        expect(step).toBeDefined();
        expect(step.target).toBe('#insightsGrid');
    });

    it('clean has a download step', () => {
        const step = TutorialSteps.clean.find((s) => s.id === 'clean-download');
        expect(step).toBeDefined();
        expect(step.title).toContain('Download');
    });
});

// ---------------------------------------------------------------------------
// TutorialMiniTips — module-level
// ---------------------------------------------------------------------------

describe('TutorialMiniTips', () => {
    it('is importable without error', () => {
        expect(TutorialMiniTips).toBeDefined();
    });

    it('is a plain object (not an array or null)', () => {
        expect(typeof TutorialMiniTips).toBe('object');
        expect(TutorialMiniTips).not.toBeNull();
        expect(Array.isArray(TutorialMiniTips)).toBe(false);
    });

    it('is frozen (immutable)', () => {
        expect(Object.isFrozen(TutorialMiniTips)).toBe(true);
    });

    it('has entries for every expected route', () => {
        for (const route of EXPECTED_ROUTES) {
            expect(Object.prototype.hasOwnProperty.call(TutorialMiniTips, route)).toBe(true);
        }
    });

    it('each route entry is a non-empty array', () => {
        for (const route of EXPECTED_ROUTES) {
            const tips = TutorialMiniTips[route];
            expect(Array.isArray(tips)).toBe(true);
            expect(tips.length).toBeGreaterThan(0);
        }
    });

    it('every mini-tip id is unique across all routes', () => {
        const allIds = EXPECTED_ROUTES.flatMap((r) => TutorialMiniTips[r].map((t) => t.id));
        const uniqueIds = new Set(allIds);
        expect(uniqueIds.size).toBe(allIds.length);
    });

    it('mini-tip ids are distinct from step ids', () => {
        const stepIds = new Set(EXPECTED_ROUTES.flatMap((r) => TutorialSteps[r].map((s) => s.id)));
        const tipIds = EXPECTED_ROUTES.flatMap((r) => TutorialMiniTips[r].map((t) => t.id));
        for (const id of tipIds) {
            expect(stepIds.has(id)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// TutorialMiniTips — per-route shape checks
// ---------------------------------------------------------------------------

describe('TutorialMiniTips step shapes', () => {
    for (const route of EXPECTED_ROUTES) {
        describe(`route: ${route}`, () => {
            it('every mini-tip has the required fields', () => {
                for (const tip of TutorialMiniTips[route]) {
                    assertMiniTipShape(tip, route);
                }
            });

            it('every mini-tip title is "Tip"', () => {
                for (const tip of TutorialMiniTips[route]) {
                    expect(tip.title).toBe('Tip');
                }
            });

            it('every mini-tip placement is "top"', () => {
                for (const tip of TutorialMiniTips[route]) {
                    expect(tip.placement).toBe('top');
                }
            });
        });
    }
});

// ---------------------------------------------------------------------------
// TutorialMiniTips — spot-check known tip content
// ---------------------------------------------------------------------------

describe('TutorialMiniTips known content', () => {
    it('home tip targets the upload hint', () => {
        const tip = TutorialMiniTips.home[0];
        expect(tip.id).toBe('home-upload-tip');
        expect(tip.target).toBe('#uploadHint');
    });

    it('clean tip mentions preview', () => {
        const tip = TutorialMiniTips.clean[0];
        expect(tip.id).toBe('clean-preview-tip');
        expect(tip.body.toLowerCase()).toContain('preview');
    });

    it('analytics tip mentions clicking a chart', () => {
        const tip = TutorialMiniTips.analytics[0];
        expect(tip.id).toBe('analytics-click-tip');
        expect(tip.body.toLowerCase()).toContain('chart');
    });

    it('connections tip mentions momentum', () => {
        const tip = TutorialMiniTips.connections[0];
        expect(tip.id).toBe('connections-range-tip');
        expect(tip.body.toLowerCase()).toContain('momentum');
    });

    it('messages tip mentions follow-up', () => {
        const tip = TutorialMiniTips.messages[0];
        expect(tip.id).toBe('messages-followup-tip');
        expect(tip.body.toLowerCase()).toContain('follow');
    });

    it('insights tip mentions engagement', () => {
        const tip = TutorialMiniTips.insights[0];
        expect(tip.id).toBe('insights-action-tip');
        expect(tip.body.toLowerCase()).toContain('engagement');
    });
});
