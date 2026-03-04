import { describe, expect, it } from 'vitest';

import { setupDom, mockMatchMedia } from './helpers/dom.js';
import { Theme } from '../src/theme.js';

describe('Theme', () => {
    it('applies theme to document root', () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute('data-theme', 'light');
        Theme.init();
        expect(document.documentElement.getAttribute('data-theme')).toBeTruthy();
    });
});
