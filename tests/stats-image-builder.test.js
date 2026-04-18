const test = require('node:test');
const assert = require('node:assert/strict');

const {
    attachStatsImageManifests,
    buildImageManifest,
    getImageManifestRelativeUrl,
    getImagePagesRelativeDir
} = require('../scripts/stats-image-builder.js');

test('stats image builder path helpers use year and file stem', () => {
    const item = {
        year: '2025',
        document: {
            fileName: '01.pdf'
        }
    };

    assert.equal(getImageManifestRelativeUrl(item), 'stats/image-manifests/2025/01.json');
    assert.equal(getImagePagesRelativeDir(item), 'stats/image-pages/2025/01');
});

test('buildImageManifest summarizes generated stats images', () => {
    const item = {
        year: '2025',
        document: {
            title: 'အောင်ချက်ရာခိုင်နှုန်း',
            url: 'stats/pdfs/2025/01.pdf',
            fileName: '01.pdf',
            sourcePage: 'https://2025.myanmarexam.org/'
        }
    };
    const pages = [
        { index: 1, width: 1200, height: 1697, url: 'stats/image-pages/2025/01/page-001.webp' }
    ];

    const manifest = buildImageManifest(item, pages);

    assert.equal(manifest.metadata.kind, 'stats');
    assert.equal(manifest.metadata.pageCount, 1);
    assert.equal(manifest.metadata.title, item.document.title);
    assert.equal(manifest.metadata.pdfUrl, item.document.url);
});

test('attachStatsImageManifests adds image-reader fields to stats payloads', () => {
    const payload = {
        metadata: {
            year: '2025'
        },
        documents: [
            {
                url: 'stats/pdfs/2025/01.pdf',
                fileName: '01.pdf'
            }
        ]
    };
    const manifestMap = new Map([
        [
            'stats/pdfs/2025/01.pdf',
            {
                metadata: {
                    pageCount: 5
                }
            }
        ]
    ]);

    const nextPayload = attachStatsImageManifests(payload, manifestMap);
    const document = nextPayload.documents[0];

    assert.equal(document.imageManifest, 'stats/image-manifests/2025/01.json');
    assert.equal(document.imagePageCount, 5);
});
