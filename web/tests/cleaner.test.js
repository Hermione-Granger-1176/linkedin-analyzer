const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LinkedInCleaner = require(path.join(__dirname, '..', 'js', 'cleaner.js'));

test('auto-detects and cleans messages CSV', () => {
    const csv = [
        'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS',
        'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"He said ""hello""",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob'
    ].join('\n');

    const result = LinkedInCleaner.process(csv, 'auto');

    assert.equal(result.success, true);
    assert.equal(result.fileType, 'messages');
    assert.equal(result.rowCount, 1);
    assert.equal(result.cleanedData[0].CONTENT, 'He said "hello"');
});

test('auto-detects and cleans connections CSV with preamble', () => {
    const csv = [
        'Notes:',
        'Export metadata',
        '',
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
        'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026'
    ].join('\n');

    const result = LinkedInCleaner.process(csv, 'auto');

    assert.equal(result.success, true);
    assert.equal(result.fileType, 'connections');
    assert.equal(result.rowCount, 1);
    assert.equal(result.cleanedData[0]['Connected On'], '2026-01-30');
});

test('cleans connections long month names', () => {
    const csv = [
        'Notes:',
        'Export metadata',
        '',
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
        'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 January 2026'
    ].join('\n');

    const result = LinkedInCleaner.process(csv, 'connections');

    assert.equal(result.success, true);
    assert.equal(result.cleanedData[0]['Connected On'], '2026-01-30');
});
