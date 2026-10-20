/**
 * Save a Blob through a temporary download link.
 * The link and its object URL are released even if clicking the link fails.
 * @param {Blob} blob - File content
 * @param {string} filename - Download file name
 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    try {
        document.body.appendChild(link);
        link.click();
    } finally {
        if (link.parentNode) {
            link.remove();
        }
        URL.revokeObjectURL(url);
    }
}
