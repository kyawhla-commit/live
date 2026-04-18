const test = require('node:test');
const assert = require('node:assert/strict');

const {
    attachImageManifests,
    buildImageManifest,
    getImageManifestRelativeUrl,
    getImagePagesRelativeDir
} = require('../scripts/result-image-pilot.js');

test('image pilot path helpers use the source page slug and file stem', () => {
    const result = {
        fileName: 'YGN-001.pdf',
        sourcePage: 'https://2025.myanmarexam.org/ygn.html'
    };

    assert.equal(getImageManifestRelativeUrl(result), 'image-manifests/ygn/YGN-001.json');
    assert.equal(getImagePagesRelativeDir(result), 'image-pages/ygn/YGN-001');
});

test('buildImageManifest summarizes generated page images', () => {
    const result = {
        name: 'တိုက်ကြီး',
        url: 'pdfs/ygn/YGN-001.pdf',
        fileName: 'YGN-001.pdf',
        examCenter: 'အထက၊တိုက်ကြီး(စက်၊စိုက်၊မွေး)',
        sourcePage: 'https://2025.myanmarexam.org/ygn.html',
        sourcePageTitle: '၂၀၂၅ - တက္ကသိုလ်ဝင် စာမေးပွဲအောင်စာရင်း (ရန်ကုန်တိုင်းဒေသကြီး)'
    };
    const pages = [
        { index: 1, width: 1200, height: 1697, url: 'image-pages/ygn/YGN-001/page-001.webp' },
        { index: 2, width: 1200, height: 1697, url: 'image-pages/ygn/YGN-001/page-002.webp' }
    ];

    const manifest = buildImageManifest(result, pages);

    assert.equal(manifest.metadata.pageCount, 2);
    assert.equal(manifest.metadata.pdfUrl, 'pdfs/ygn/YGN-001.pdf');
    assert.equal(manifest.metadata.title, 'အထက၊တိုက်ကြီး(စက်၊စိုက်၊မွေး)');
    assert.deepEqual(manifest.pages, pages);
});

test('attachImageManifests adds manifest urls and page counts to result payloads', () => {
    const payload = {
        metadata: {
            year: '2025'
        },
        results: [
            {
                name: 'တိုက်ကြီး',
                url: 'pdfs/ygn/YGN-001.pdf',
                fileName: 'YGN-001.pdf',
                sourcePage: 'https://2025.myanmarexam.org/ygn.html'
            },
            {
                name: 'လှည်းကူး',
                url: 'pdfs/ygn/YGN-002.pdf',
                fileName: 'YGN-002.pdf',
                sourcePage: 'https://2025.myanmarexam.org/ygn.html'
            }
        ]
    };
    const manifestMap = new Map([
        [
            'pdfs/ygn/YGN-001.pdf',
            {
                metadata: {
                    pageCount: 3
                }
            }
        ]
    ]);

    const nextPayload = attachImageManifests(payload, manifestMap);

    assert.equal(nextPayload.results[0].imageManifest, 'image-manifests/ygn/YGN-001.json');
    assert.equal(nextPayload.results[0].imagePageCount, 3);
    assert.equal(nextPayload.results[1].imageManifest, null);
    assert.equal(nextPayload.results[1].imagePageCount, null);
});
