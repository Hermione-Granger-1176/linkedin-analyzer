export function setupDom(html = '') {
    document.body.innerHTML = html;
}

export function mockMatchMedia() {
    if (!window.matchMedia) {
        window.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {}
        });
    }
}
