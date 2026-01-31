/* RoughJS background decorations */

(function() {
    'use strict';

    function init() {
        const canvas = document.getElementById('roughCanvas');
        if (!canvas || typeof rough === 'undefined') return;

        // Fixed position canvas covers viewport
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const rc = rough.canvas(canvas);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const colors = {
            blue: isDark ? 'rgba(127, 179, 213, 0.15)' : 'rgba(91, 155, 213, 0.1)',
            yellow: isDark ? 'rgba(247, 220, 111, 0.1)' : 'rgba(244, 208, 63, 0.08)',
            purple: isDark ? 'rgba(187, 143, 206, 0.1)' : 'rgba(155, 89, 182, 0.08)'
        };

        // Top-right decoration
        rc.circle(canvas.width - 120, 180, 220, {
            fill: colors.blue,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        // Bottom-left decoration
        rc.circle(80, canvas.height - 100, 190, {
            fill: colors.purple,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        // Bottom-right decoration
        rc.circle(canvas.width - 240, canvas.height - 80, 120, {
            fill: colors.yellow,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });
    }

    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(init, 250);
    });

    document.addEventListener('themechange', init);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
