import { describe, expect, it } from 'vitest';

import { DomEvents } from '../src/dom-events.js';

describe('DomEvents.closest', () => {
    it('returns closest ancestor match', () => {
        const root = document.createElement('div');
        const parent = document.createElement('div');
        parent.className = 'target';
        const child = document.createElement('span');
        parent.appendChild(child);
        root.appendChild(parent);
        document.body.appendChild(root);

        const event = { target: child };
        const match = DomEvents.closest(event, '.target');
        expect(match).toBe(parent);
    });

    it('returns null when target is not an element', () => {
        const match = DomEvents.closest({ target: null }, '.target');
        expect(match).toBe(null);
    });
});
