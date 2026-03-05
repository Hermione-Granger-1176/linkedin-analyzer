import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoadingOverlay } from '../src/loading-overlay.js';
import { ScreenManager } from '../src/screen-manager.js';

describe('ScreenManager', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <nav>
                <a class="top-link" data-route="home"></a>
                <a class="top-link" data-route="about"></a>
            </nav>
            <div id="routeAnnouncer"></div>
            <section id="screen-home" class="screen"></section>
            <section id="screen-about" class="screen"></section>
        `;
        vi.spyOn(LoadingOverlay, 'syncActiveScreen').mockImplementation(() => {});
    });

    it('activates screens and updates nav state', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        ScreenManager.register('about', { screenId: 'screen-about', controller });

        ScreenManager.activate('home', { alpha: '1' });
        expect(document.getElementById('screen-home').classList.contains('active')).toBe(true);
        expect(controller.init).toHaveBeenCalled();

        ScreenManager.activate('about', { beta: '2' });
        expect(document.getElementById('screen-about').classList.contains('active')).toBe(true);
        expect(document.querySelector('.top-link[data-route="about"]').getAttribute('aria-current')).toBe('page');
    });

    it('returns current route name', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        ScreenManager.activate('home', {});
        expect(ScreenManager.getCurrentRouteName()).toBe('home');
    });

    it('calls onRouteLeave on the previous controller when switching routes', () => {
        const homeController = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        const aboutController = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller: homeController });
        ScreenManager.register('about', { screenId: 'screen-about', controller: aboutController });

        ScreenManager.activate('home', {});
        expect(homeController.onRouteLeave).not.toHaveBeenCalled();

        ScreenManager.activate('about', {});
        expect(homeController.onRouteLeave).toHaveBeenCalledWith({ from: 'home', to: 'about' });
    });

    it('does not call onRouteLeave when activating same route twice', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });

        ScreenManager.activate('home', {});
        ScreenManager.activate('home', { x: '1' });
        expect(controller.onRouteLeave).not.toHaveBeenCalled();
    });

    it('does not call init twice for same route', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });

        ScreenManager.activate('home', {});
        ScreenManager.activate('home', { x: '1' });
        expect(controller.init).toHaveBeenCalledTimes(1);
    });

    it('gracefully handles route with missing DOM element (screenId not found)', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('ghost', { screenId: 'screen-ghost-does-not-exist', controller });

        // Should not throw even when screen element is absent
        expect(() => ScreenManager.activate('ghost', {})).not.toThrow();
        expect(controller.onRouteChange).toHaveBeenCalled();
    });

    it('ignores activate call for unregistered route', () => {
        expect(() => ScreenManager.activate('nonexistent', {})).not.toThrow();
    });

    it('ignores register call with missing screenId', () => {
        expect(() => ScreenManager.register('bad', {})).not.toThrow();
        expect(() => ScreenManager.register('bad', { controller: {} })).not.toThrow();
    });

    it('ignores register call with falsy routeName', () => {
        expect(() => ScreenManager.register('', { screenId: 'screen-home' })).not.toThrow();
        expect(() => ScreenManager.register(null, { screenId: 'screen-home' })).not.toThrow();
    });

    it('nav link without data-route attribute is not modified', () => {
        document.body.innerHTML += '<a class="top-link"></a>';
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });

        expect(() => ScreenManager.activate('home', {})).not.toThrow();
    });

    it('calls LoadingOverlay.syncActiveScreen on activate', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        ScreenManager.activate('home', {});
        expect(LoadingOverlay.syncActiveScreen).toHaveBeenCalled();
    });

    it('announces route name in routeAnnouncer element', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('analytics', { screenId: 'screen-home', controller });
        ScreenManager.activate('analytics', {});
        expect(document.getElementById('routeAnnouncer').textContent).toContain('Analytics');
    });

    it('announces custom route name when not in labels map', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('myspecialroute', { screenId: 'screen-home', controller });
        ScreenManager.activate('myspecialroute', {});
        expect(document.getElementById('routeAnnouncer').textContent).toContain('myspecialroute');
    });

    it('handles activate when controller has no onRouteLeave method', () => {
        const homeController = { init: vi.fn(), onRouteChange: vi.fn() };
        const aboutController = { init: vi.fn(), onRouteChange: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller: homeController });
        ScreenManager.register('about', { screenId: 'screen-about', controller: aboutController });

        ScreenManager.activate('home', {});
        expect(() => ScreenManager.activate('about', {})).not.toThrow();
    });

    it('handles activate when route has no controller', () => {
        ScreenManager.register('home', { screenId: 'screen-home' });
        expect(() => ScreenManager.activate('home', {})).not.toThrow();
    });

    it('removes aria-current from previously active nav links', () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        ScreenManager.register('about', { screenId: 'screen-about', controller });

        ScreenManager.activate('home', {});
        expect(document.querySelector('.top-link[data-route="home"]').getAttribute('aria-current')).toBe('page');

        ScreenManager.activate('about', {});
        expect(document.querySelector('.top-link[data-route="home"]').getAttribute('aria-current')).toBeNull();
    });

    it('transition cleanup runs after TRANSITION_DURATION_MS when switching routes', () => {
        vi.useFakeTimers();
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };

        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        ScreenManager.register('about', { screenId: 'screen-about', controller });

        ScreenManager.activate('home', {});
        ScreenManager.activate('about', {});

        const prevScreen = document.getElementById('screen-home');
        expect(prevScreen.classList.contains('exit')).toBe(true);

        vi.advanceTimersByTime(400);

        expect(prevScreen.classList.contains('exit')).toBe(false);
        expect(prevScreen.classList.contains('is-loading')).toBe(false);

        vi.useRealTimers();
    });

    it('enter class is added and then removed on next screen after transition', () => {
        vi.useFakeTimers();
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };

        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        ScreenManager.register('about', { screenId: 'screen-about', controller });

        ScreenManager.activate('home', {});
        ScreenManager.activate('about', {});

        const nextScreen = document.getElementById('screen-about');
        expect(nextScreen.classList.contains('enter')).toBe(true);

        vi.advanceTimersByTime(400);

        expect(nextScreen.classList.contains('enter')).toBe(false);

        vi.useRealTimers();
    });

    it('does not announce route when routeAnnouncer element is absent', () => {
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };
        document.getElementById('routeAnnouncer').remove();
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register('home', { screenId: 'screen-home', controller });
        expect(() => ScreenManager.activate('home', {})).not.toThrow();
    });
});
