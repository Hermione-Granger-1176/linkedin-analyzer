const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* LinkedInCleaner must be a global before the worker module loads */
globalThis.LinkedInCleaner = require(path.join(__dirname, '..', 'js', 'cleaner.js'));

const { processPayload } = require(path.join(__dirname, '..', 'js', 'messages-worker.js'));

const VALID_MESSAGES_CSV = [
    'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS',
    'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"Hello there",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob'
].join('\n');

const VALID_CONNECTIONS_CSV = [
    'Notes:',
    'Export metadata',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024'
].join('\n');

test('processPayload parses valid messages CSV', () => {
    const result = processPayload({ messagesCsv: VALID_MESSAGES_CSV });

    assert.equal(result.success, true);
    assert.equal(result.messagesData.length, 1);
    assert.equal(result.messagesData[0].CONTENT, 'Hello there');
    assert.deepEqual(result.connectionsData, []);
    assert.equal(result.connectionError, null);
});

test('processPayload returns error for invalid messages CSV', () => {
    const result = processPayload({ messagesCsv: 'not,a,valid,csv' });

    assert.equal(result.success, false);
    assert.ok(result.error);
});

test('processPayload parses both messages and connections', () => {
    const result = processPayload({
        messagesCsv: VALID_MESSAGES_CSV,
        connectionsCsv: VALID_CONNECTIONS_CSV
    });

    assert.equal(result.success, true);
    assert.equal(result.messagesData.length, 1);
    assert.equal(result.connectionsData.length, 1);
    assert.equal(result.connectionError, null);
});

test('processPayload handles connections failure gracefully', () => {
    const result = processPayload({
        messagesCsv: VALID_MESSAGES_CSV,
        connectionsCsv: 'bad,csv,data'
    });

    assert.equal(result.success, true);
    assert.equal(result.messagesData.length, 1);
    assert.deepEqual(result.connectionsData, []);
    assert.ok(result.connectionError);
});

test('processPayload handles missing connectionsCsv', () => {
    const result = processPayload({ messagesCsv: VALID_MESSAGES_CSV });

    assert.equal(result.success, true);
    assert.deepEqual(result.connectionsData, []);
    assert.equal(result.connectionError, null);
});
