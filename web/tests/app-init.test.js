import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DomEvents } from '../src/dom-events.js';
import { AppRouter } from '../src/router.js';
import { ScreenManager } from '../src/screen-manager.js';
import { Session } from '../src/session.js';
import { Tutorial } from '../src/tutorial.js';

vi.mock('../src/analytics-ui.js', () => ({ AnalyticsPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock('../src/clean.js', () => ({ CleanPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock('../src/connections-ui.js', () => ({ ConnectionsPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock('../src/decorations.js', () => ({ initDecorations: vi.fn() }));
vi.mock('../src/dom-events.js', () => ({ DomEvents: { closest: vi.fn() } }));
vi.mock('../src/insights-ui.js', () => ({ InsightsPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock('../src/messages-insights.js', () => ({ MessagesPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock('../src/router.js', () => ({
    AppRouter: {
        registerRoute: vi.fn(),
        start: vi.fn(),
        navigate: vi.fn(),
        subscribe: vi.fn()
    }
}));
vi.mock('../src/runtime.js', () => ({ initRuntime: vi.fn() }));
vi.mock('../src/screen-manager.js', () => ({ ScreenManager: { register: vi.fn(), activate: vi.fn() } }));
vi.mock('../src/sentry.js', () => ({ initSentry: vi.fn() }));
vi.mock('../src/session.js', () => ({ Session: { cleanIfStale: vi.fn(() => Promise.resolve(false)), touch: vi.fn() } }));
vi.mock('../src/telemetry.js', () => ({ initTelemetry: vi.fn() }));
vi.mock('../src/theme.js', () => ({ Theme: { init: vi.fn() } }));
vi.mock('../src/tutorial.js', () => ({ Tutorial: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock('../src/upload.js', () => ({ UploadPage: { init: vi.fn(), onRouteChange: vi.fn() } }));

describe('app init wiring', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <a data-route="analytics" href="#analytics"></a>
        `;
        vi.clearAllMocks();
    });

    it('registers routes and activates on router change', async () => {
        DomEvents.closest.mockImplementation(() => null);

        await import('../src/app.js');

        expect(AppRouter.registerRoute).toHaveBeenCalled();
        expect(ScreenManager.register).toHaveBeenCalled();
        expect(AppRouter.start).toHaveBeenCalledWith('home');

        const callback = AppRouter.subscribe.mock.calls[0][0];
        callback({ to: { name: 'analytics', params: { range: '12m' } } });

        expect(ScreenManager.activate).toHaveBeenCalledWith('analytics', { range: '12m' });
        expect(Tutorial.onRouteChange).toHaveBeenCalledWith('analytics');
        expect(Session.touch).toHaveBeenCalled();
    });

    it('navigates on route link click', async () => {
        const link = document.querySelector('a[data-route]');
        DomEvents.closest.mockReturnValue(link);

        await import('../src/app.js');

        const event = new MouseEvent('click', { bubbles: true, button: 0 });
        Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
        document.dispatchEvent(event);

        expect(AppRouter.navigate).toHaveBeenCalledWith('analytics', undefined, { replaceHistory: false });
    });

    it('does not navigate when no route link is found (line 132)', async () => {
        DomEvents.closest.mockReturnValue(null);

        await import('../src/app.js');

        AppRouter.navigate.mockClear();
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(AppRouter.navigate).not.toHaveBeenCalled();
    });

    it('does not navigate on modified click (ctrlKey) (line 136)', async () => {
        const link = document.querySelector('a[data-route]');
        DomEvents.closest.mockReturnValue(link);

        await import('../src/app.js');

        AppRouter.navigate.mockClear();
        const event = new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true });
        Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
        document.dispatchEvent(event);

        expect(AppRouter.navigate).not.toHaveBeenCalled();
    });

    it('does not navigate on non-primary button click (button=2) (line 136)', async () => {
        const link = document.querySelector('a[data-route]');
        DomEvents.closest.mockReturnValue(link);

        await import('../src/app.js');

        AppRouter.navigate.mockClear();
        const event = new MouseEvent('click', { bubbles: true, button: 2 });
        Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
        document.dispatchEvent(event);

        expect(AppRouter.navigate).not.toHaveBeenCalled();
    });

    it('does not navigate when data-route attribute is empty (line 141)', async () => {
        const link = document.createElement('a');
        link.setAttribute('data-route', '');
        DomEvents.closest.mockReturnValue(link);

        await import('../src/app.js');

        AppRouter.navigate.mockClear();
        const event = new MouseEvent('click', { bubbles: true, button: 0 });
        Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
        document.dispatchEvent(event);

        expect(AppRouter.navigate).not.toHaveBeenCalled();
    });
});
