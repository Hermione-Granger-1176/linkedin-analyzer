import { describe, expect, it } from 'vitest';

import { AppRouter } from '../src/router.js';

describe('AppRouter build/parse', () => {
    it('round-trips hash parameters', () => {
        const hash = AppRouter.buildHash('analytics', { range: '3m', topic: 'ai' });
        const parsed = AppRouter.parseHash(hash);
        expect(parsed.name).toBe('analytics');
        expect(parsed.params.range).toBe('3m');
        expect(parsed.params.topic).toBe('ai');
    });
});
