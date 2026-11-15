/**
 * Stored-upload stand-ins for jsdom tests. jsdom's Blob has no stream(), so
 * the Blob returned here gets a stream() that yields its bytes.
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
