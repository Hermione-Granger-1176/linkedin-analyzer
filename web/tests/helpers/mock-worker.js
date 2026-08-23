/**
 * Shared Worker stand-in for the export transport suites.
 *
 * It records posted requests, exposes attached listeners so tests can dispatch
 * events, and can throw from its constructor or `postMessage`.
 */

import { vi } from "vitest";

/**
 * @typedef {object} MockWorkerInstance
 * @property {string} url - Stringified URL the transport constructed it with
 * @property {Map<string, Function[]>} listeners - Listeners by event type, as attached
 * @property {import("vitest").Mock} terminate - Records termination
 * @property {import("vitest").Mock} postMessage - Records each posted request
 * @property {(type: string, event: object) => void} emit - Dispatch one event to its listeners
 */

/**
 * @typedef {object} WorkerHarness
 * @property {MockWorkerInstance|null} instance - Most recently constructed worker
 * @property {MockWorkerInstance[]} created - Every worker constructed, in order
 * @property {Error|null} constructorError - Set to make construction throw
 * @property {Error|null} postMessageError - Set to make posting throw
 * @property {() => void} install - Install the class and clear recorded state
 * @property {() => void} uninstall - Remove the class from the global scope
 */

/**
 * Build a Worker stand-in and return the harness a suite uses to drive it.
 * @returns {WorkerHarness} Harness containing workers and test controls
 */
export function createWorkerHarness() {
    class MockWorker {
        constructor(url) {
            if (harness.constructorError) {
                throw harness.constructorError;
            }
            this.url = String(url);
            this.listeners = new Map();
            this.terminate = vi.fn();
            this.postMessage = vi.fn(() => {
                if (harness.postMessageError) {
                    throw harness.postMessageError;
                }
            });
            harness.instance = this;
            harness.created.push(this);
        }

        addEventListener(type, callback) {
            const existing = this.listeners.get(type) || [];
            existing.push(callback);
            this.listeners.set(type, existing);
        }

        removeEventListener(type, callback) {
            const existing = this.listeners.get(type) || [];
            this.listeners.set(
                type,
                existing.filter((entry) => entry !== callback),
            );
        }

        emit(type, event) {
            // Copied first: a listener that detaches itself while this runs
            // must not shorten the list being walked.
            for (const callback of [...(this.listeners.get(type) || [])]) {
                callback(event);
            }
        }
    }

    /** @type {WorkerHarness} */
    const harness = {
        instance: null,
        created: [],
        constructorError: null,
        postMessageError: null,
        install: () => {
            harness.instance = null;
            harness.created = [];
            harness.constructorError = null;
            harness.postMessageError = null;
            globalThis.Worker = MockWorker;
        },
        uninstall: () => {
            delete globalThis.Worker;
        },
    };

    return harness;
}
