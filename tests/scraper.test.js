const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
    attachExistingImageManifests,
    buildExistingImageManifestMap,
    buildLatestPayload,
    buildPublicPayload,
    ensureTrackedDirectory,
    parseResultRow,
    parsePage
} = require('../scripts/scraper.js');

const fixturePath = path.join(__dirname, 'fixtures', 'root-with-stats.html');
const rootWithStatsHtml = fs.readFileSync(fixturePath, 'utf8');

test('parsePage excludes stats child pages and stats pdf links', () => {
    const rootUrl = 'https://2026.myanmarexam.org/';
    const pageUrl = 'https://2026.myanmarexam.org/index.html';
    const page = parsePage(rootWithStatsHtml, pageUrl, rootUrl);

    assert.equal(page.title, 'ရန်ကုန်တိုင်းဒေသကြီး အောင်စာရင်း');
    assert.deepEqual(page.childPages, [
        {
            title: 'Yangon',
            url: 'https://2026.myanmarexam.org/ygn.html'
        }
    ]);
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0].name, 'YGN-001');
    assert.equal(page.results[0].url, 'https://2026.myanmarexam.org/docs/YGN-001.pdf');
    assert.equal(page.results[0].fileName, 'YGN-001.pdf');
    assert.equal(page.results[0].serialNo, '001');
    assert.equal(page.results[0].sourcePage, pageUrl);
    assert.equal(page.results[0].sourcePageTitle, 'ရန်ကုန်တိုင်းဒေသကြီး အောင်စာရင်း');
});

test('buildPublicPayload rewrites mirrored urls and latest payload only includes populated regions', () => {
    const payload = {
        metadata: {
            year: '2026',
            sourceUrl: 'https://2026.myanmarexam.org/',
            scrapedAt: '2026-04-17T00:00:00.000Z',
            resultCount: 1,
            pagesVisited: 2,
            maxCrawlDepth: 1
        },
        pages: [
            {
                url: 'https://2026.myanmarexam.org/ygn.html',
                title: 'ရန်ကုန်တိုင်းဒေသကြီး အောင်စာရင်း',
                resultCount: 1
            },
            {
                url: 'https://2026.myanmarexam.org/mdy.html',
                title: 'မန္တလေးတိုင်းဒေသကြီး အောင်စာရင်း',
                resultCount: 0
            }
        ],
        results: [
            {
                name: 'YGN-001',
                url: 'https://blocked-source.example/YGN-001.pdf',
                fileName: 'YGN-001.pdf',
                serialNo: '001',
                examCode: '(YGN)',
                examCenter: 'Yangon Center',
                township: 'ရန်ကုန်',
                district: 'ရန်ကုန်',
                sourcePage: 'https://2026.myanmarexam.org/ygn.html',
                sourcePageTitle: 'ရန်ကုန်တိုင်းဒေသကြီး အောင်စာရင်း',
                __mirror: {
                    publicUrl: 'pdfs/ygn/YGN-001.pdf'
                }
            }
        ]
    };

    const publicPayload = buildPublicPayload(payload);
    const latestPayload = buildLatestPayload(publicPayload);

    assert.equal(publicPayload.results[0].url, 'pdfs/ygn/YGN-001.pdf');
    assert.equal(publicPayload.results[0].township, 'ရန်ကုန်');
    assert.equal(publicPayload.results[0].district, 'ရန်ကုန်');
    assert.equal(latestPayload.regions.length, 1);
    assert.deepEqual(latestPayload.regions[0], {
        slug: 'ygn',
        name: 'YGN-001',
        sourcePage: 'https://2026.myanmarexam.org/ygn.html',
        resultCount: 1,
        dataFile: 'regions/ygn.json'
    });
    assert.deepEqual(latestPayload.pages, publicPayload.pages);
});

test('attachExistingImageManifests preserves existing image metadata by public url', () => {
    const nextPayload = {
        metadata: {},
        pages: [],
        results: [
            {
                name: 'YGN-001',
                url: 'pdfs/ygn/YGN-001.pdf',
                fileName: 'YGN-001.pdf',
                sourcePage: 'https://2026.myanmarexam.org/ygn.html'
            }
        ]
    };
    const existingPayload = {
        results: [
            {
                url: 'pdfs/ygn/YGN-001.pdf',
                fileName: 'YGN-001.pdf',
                sourcePage: 'https://2026.myanmarexam.org/ygn.html',
                imageManifest: 'image-manifests/ygn/YGN-001.json',
                imagePageCount: 8
            }
        ]
    };

    const nextPayloadWithImages = attachExistingImageManifests(
        nextPayload,
        buildExistingImageManifestMap(existingPayload)
    );

    assert.equal(nextPayloadWithImages.results[0].imageManifest, 'image-manifests/ygn/YGN-001.json');
    assert.equal(nextPayloadWithImages.results[0].imagePageCount, 8);
});

test('buildLatestPayload normalizes multi-result region titles', () => {
    const payload = {
        metadata: {
            year: '2025',
            sourceUrl: 'https://2025.myanmarexam.org/',
            scrapedAt: '2026-04-18T00:00:00.000Z',
            resultCount: 2,
            pagesVisited: 1,
            maxCrawlDepth: 1
        },
        pages: [
            {
                url: 'https://2025.myanmarexam.org/ygn.html',
                title: '၂၀၂၅ - တက္ကသိုလ်ဝင် စာမေးပွဲအောင်စာရင်း (ရန်ကုန်တိုင်းဒေသကြီး)',
                resultCount: 2
            }
        ],
        results: [
            {
                name: 'တိုက်ကြီး',
                url: 'https://blocked-source.example/YGN-001.pdf',
                fileName: 'YGN-001.pdf',
                serialNo: '၁',
                examCode: 'ဆတက',
                examCenter: 'အထက၊တိုက်ကြီး(စက်၊စိုက်၊မွေး)',
                township: 'တိုက်ကြီး',
                district: 'တိုက်ကြီး',
                sourcePage: 'https://2025.myanmarexam.org/ygn.html',
                sourcePageTitle: '၂၀၂၅ - တက္ကသိုလ်ဝင် စာမေးပွဲအောင်စာရင်း (ရန်ကုန်တိုင်းဒေသကြီး)'
            },
            {
                name: 'လှည်းကူး',
                url: 'https://blocked-source.example/YGN-002.pdf',
                fileName: 'YGN-002.pdf',
                serialNo: '၂',
                examCode: 'ဆလက',
                examCenter: 'အထက၊လှည်းကူး',
                township: 'လှည်းကူး',
                district: 'လှည်းကူး',
                sourcePage: 'https://2025.myanmarexam.org/ygn.html',
                sourcePageTitle: '၂၀၂၅ - တက္ကသိုလ်ဝင် စာမေးပွဲအောင်စာရင်း (ရန်ကုန်တိုင်းဒေသကြီး)'
            }
        ]
    };

    const latestPayload = buildLatestPayload(payload);

    assert.equal(latestPayload.regions[0].name, 'ရန်ကုန်တိုင်းဒေသကြီး');
});

test('ensureTrackedDirectory creates a tracked placeholder file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exam-results-dir-'));
    const targetDir = path.join(tempDir, 'regions');

    await ensureTrackedDirectory(targetDir);

    const stat = await fsp.stat(targetDir);
    assert.equal(stat.isDirectory(), true);
    assert.equal(fs.existsSync(path.join(targetDir, '.gitkeep')), true);

    await fsp.rm(tempDir, { recursive: true, force: true });
});

test('parseResultRow keeps district, township, exam center, and compact code for 2025-style rows', () => {
    const parsed = parseResultRow(
        'Download',
        ['၁', 'တိုက်ကြီး', 'တိုက်ကြီး', 'အထက၊တိုက်ကြီး(စက်၊စိုက်၊မွေး)', 'ဆတက'],
        'https://2025.myanmarexam.org/docs/YGN-001.pdf'
    );

    assert.deepEqual(parsed, {
        name: 'တိုက်ကြီး',
        serialNo: '၁',
        examCode: 'ဆတက',
        examCenter: 'အထက၊တိုက်ကြီး(စက်၊စိုက်၊မွေး)',
        township: 'တိုက်ကြီး',
        district: 'တိုက်ကြီး'
    });
});
