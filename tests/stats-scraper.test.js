const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    buildLatestPayload,
    buildYearPayload,
    normalizeMyanmarDigits,
    parseStatsPage
} = require('../scripts/stats-scraper.js');

const fixturePath = path.join(__dirname, 'fixtures', 'stats.html');
const statsHtml = fs.readFileSync(fixturePath, 'utf8');

test('parseStatsPage extracts statistics pdf metadata', () => {
    const pageUrl = 'https://2025.myanmarexam.org/';
    const documents = parseStatsPage(statsHtml, pageUrl, '2025');

    assert.equal(documents.length, 5);
    assert.deepEqual(documents[0], {
        id: '2025-01',
        order: 1,
        title: 'အောင်ချက်ရာခိုင်နှုန်း',
        url: 'https://example.com/data/stats/01.pdf',
        fileName: '01.pdf',
        sourcePage: pageUrl
    });
    assert.equal(documents[4].title, 'ဝိဇ္ဇာတွဲ Top Ten (ပြည်နယ်နှင့်တိုင်း ဒေသကြီးအလိုက်)');
});

test('buildYearPayload and buildLatestPayload summarize stats documents', () => {
    const documents = parseStatsPage(statsHtml, 'https://2025.myanmarexam.org/', '2025').map((document) => ({
        ...document,
        mirrored: true,
        sourceUrl: document.url,
        url: `stats/pdfs/2025/${document.fileName}`
    }));
    const yearPayload = buildYearPayload('2025', documents, ['https://2025.myanmarexam.org/']);
    const latestPayload = buildLatestPayload([yearPayload]);

    assert.equal(yearPayload.metadata.documentCount, 5);
    assert.equal(yearPayload.metadata.mirroredCount, 5);
    assert.equal(latestPayload.metadata.yearCount, 1);
    assert.equal(latestPayload.metadata.documentCount, 5);
    assert.deepEqual(latestPayload.metadata.sourcePages, ['https://2025.myanmarexam.org/']);
    assert.equal(latestPayload.years[0].dataFile, 'stats/years/2025.json');
    assert.equal(latestPayload.years[0].documents[0].title, 'အောင်ချက်ရာခိုင်နှုန်း');
});

test('stats text helpers normalize Myanmar digits', () => {
    assert.equal(normalizeMyanmarDigits('၂၀၂၅'), '2025');
});
