/**
 * Build a mock request whose body is delivered as an async stream of chunks.
 * @param {Array<string | Buffer>} chunks - Body chunks to yield.
 * @param {object} [options] - Overrides for method, headers, and body.
 * @returns {object} A request-like object.
 */
export function streamRequest(chunks, options = {}) {
    const { method = "POST", headers = {}, body } = options;
    return {
        method,
        headers,
        body,
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
                yield chunk;
            }
        },
    };
}

/**
 * Build a mock response capturing status, headers, and end state.
 * @returns {object} A response-like object.
 */
export function mockResponse() {
    return {
        statusCode: 0,
        headers: {},
        ended: false,
        setHeader(key, value) {
            this.headers[key] = value;
        },
        end() {
            this.ended = true;
        },
    };
}
