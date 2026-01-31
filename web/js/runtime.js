/* Global runtime guards */

(function() {
    'use strict';

    const BANNER_ID = 'globalErrorBanner';
    const MESSAGE = 'Something went wrong. Refresh the page or re-upload your files.';

    function createBanner() {
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.className = 'global-error-banner';
        banner.hidden = true;

        const content = document.createElement('div');
        content.className = 'global-error-content';

        const text = document.createElement('p');
        text.className = 'global-error-text';
        text.textContent = MESSAGE;

        const actions = document.createElement('div');
        actions.className = 'global-error-actions';

        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'ghost-btn';
        reloadBtn.textContent = 'Reload';
        reloadBtn.addEventListener('click', () => window.location.reload());

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'ghost-btn';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
            banner.hidden = true;
        });

        actions.appendChild(reloadBtn);
        actions.appendChild(dismissBtn);
        content.appendChild(text);
        content.appendChild(actions);
        banner.appendChild(content);

        const container = document.body || document.documentElement;
        if (container) {
            container.appendChild(banner);
        }
        return banner;
    }

    function getBanner() {
        return document.getElementById(BANNER_ID) || createBanner();
    }

    function showBanner() {
        const banner = getBanner();
        banner.hidden = false;
    }

    function handleError(event) {
        const error = event && event.error ? event.error : event;
        if (error) {
            console.error('Unhandled error', error);
        }
        showBanner();
    }

    function handleRejection(event) {
        if (event && event.reason) {
            console.error('Unhandled rejection', event.reason);
        }
        showBanner();
    }

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
})();
