import { describe, expect, it } from 'vitest';

import { setupDom } from './helpers/dom.js';
import { LoadingOverlay } from '../src/loading-overlay.js';

describe('LoadingOverlay', () => {
    it('shows and hides overlay sources', () => {
        setupDom('<div id="contentLoadingOverlay" hidden></div><div id="contentLoadingTitle"></div><div id="contentLoadingText"></div>');
        LoadingOverlay.show('analytics');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.hide('analytics');
        expect(LoadingOverlay.isActive()).toBe(false);
    });
});
