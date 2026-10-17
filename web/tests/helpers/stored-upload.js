/**
 * Stored-upload stand-ins for tests that run under jsdom, whose Blob has no
 * stream(). The returned Blob streams its bytes as a browser's would, so code
 * that streams a stored upload takes the same path it takes in the browser.
 */

import { Blob as NodeBlob } from "node:buffer";

/**
 * Build a stored upload Blob that streams.
 * @param {BlobPart} content - File content
 * @returns {Blob}
 */
export function storedUpload(content) {
    const blob = new Blob([content]);
    const bytes = new NodeBlob([content]);
    Object.defineProperty(blob, "stream", { value: () => bytes.stream() });
    return blob;
}
