const fs = require('fs/promises');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const ARCHIVE_RECENT_REPO_DIR = path.resolve(
    process.env.ARCHIVE_RECENT_REPO_DIR || path.join(WORKSPACE_ROOT, 'my-exam-archive-recent')
);
const ARCHIVE_LEGACY_REPO_DIR = path.resolve(
    process.env.ARCHIVE_LEGACY_REPO_DIR || path.join(WORKSPACE_ROOT, 'my-exam-archive-legacy')
);
const LIVE_REPO_DIR = path.resolve(process.env.LIVE_REPO_DIR || path.join(WORKSPACE_ROOT, 'my-exam-live'));
const OBSOLETE_ARCHIVE_REPO_DIR = path.join(WORKSPACE_ROOT, 'my-exam-archive');
const MARKER_FILE = '.split-export-marker.json';
const ARCHIVE_RECENT_YEARS = ['2025', '2024'];
const ARCHIVE_LEGACY_YEARS = ['2023', '2022'];

const LIVE_STATS_PLACEHOLDER = {
    metadata: {
        sourcePages: [],
        scrapedAt: new Date().toISOString(),
        yearCount: 0,
        documentCount: 0,
        mirroredCount: 0
    },
    years: []
};

const LIVE_SCRIPT_FILES = [
    'export-split-repos.js',
    'pdf-image-manifest-utils.js',
    'result-image-pilot.js',
    'scraper.js',
    'stats-image-builder.js',
    'stats-scraper.js'
];

const LIVE_TEST_FILES = [
    'result-image-pilot.test.js',
    'scraper.test.js',
    'stats-image-builder.test.js',
    'stats-scraper.test.js'
];

const LIVE_FIXTURE_FILES = [
    'root-with-stats.html',
    'stats.html'
];

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function ensureExportDirectory(targetDir, kind) {
    const exists = await pathExists(targetDir);

    if (exists) {
        const markerPath = path.join(targetDir, MARKER_FILE);

        if (!(await pathExists(markerPath))) {
            throw new Error(
                `${targetDir} already exists and was not created by this export script. Move it or add ${MARKER_FILE} if you want to overwrite it.`
            );
        }

        await fs.rm(targetDir, { recursive: true, force: true });
    }

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
        path.join(targetDir, MARKER_FILE),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), kind }, null, 2)}\n`
    );
}

async function removeObsoleteGeneratedDirectory(targetDir, expectedKind) {
    if (!(await pathExists(targetDir))) {
        return;
    }

    const markerPath = path.join(targetDir, MARKER_FILE);

    if (!(await pathExists(markerPath))) {
        return;
    }

    try {
        const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));

        if (marker.kind !== expectedKind) {
            return;
        }
    } catch {
        return;
    }

    await fs.rm(targetDir, { recursive: true, force: true });
}

async function copyTree(sourcePath, targetPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(sourcePath, targetPath, { recursive: true });
}

async function writeJson(filePath, payload) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeText(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value);
}

async function buildArchiveRepo(targetDir, kind, years, extraCopyOperations = []) {
    await ensureExportDirectory(targetDir, kind);

    await copyTree(path.join(REPO_ROOT, '.gitignore'), path.join(targetDir, '.gitignore'));
    await writeText(path.join(targetDir, '.nojekyll'), '');
    await writeText(
        path.join(targetDir, 'README.md'),
        [
            `# ${path.basename(targetDir)}`,
            '',
            'Static archive data for Myanmar exam results.',
            '',
            'Published paths:',
            `- \`data/archive/${years.join(', ')}\``,
            ...(extraCopyOperations.some((entry) => entry.target.startsWith('data/questions'))
                ? ['- `data/questions/...`']
                : []),
            ...(extraCopyOperations.some((entry) => entry.target.startsWith('data/stats'))
                ? ['- `data/stats/...`']
                : []),
            '',
            'This repo is intended for GitHub Pages static hosting only.',
            ''
        ].join('\n')
    );

    for (const year of years) {
        await copyTree(
            path.join(REPO_ROOT, 'data', 'archive', year),
            path.join(targetDir, 'data', 'archive', year)
        );
    }

    for (const entry of extraCopyOperations) {
        await copyTree(path.join(REPO_ROOT, entry.source), path.join(targetDir, entry.target));
    }
}

async function buildLiveRepo() {
    await ensureExportDirectory(LIVE_REPO_DIR, 'live');

    await copyTree(path.join(REPO_ROOT, '.gitignore'), path.join(LIVE_REPO_DIR, '.gitignore'));
    await copyTree(
        path.join(REPO_ROOT, '.github', 'workflows', 'scrape.yml'),
        path.join(LIVE_REPO_DIR, '.github', 'workflows', 'scrape.yml')
    );

    const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    delete packageJson.scripts['scrape:questions'];
    delete packageJson.scripts['build:image-questions'];
    await writeJson(path.join(LIVE_REPO_DIR, 'package.json'), packageJson);
    await copyTree(path.join(REPO_ROOT, 'package-lock.json'), path.join(LIVE_REPO_DIR, 'package-lock.json'));

    for (const fileName of LIVE_SCRIPT_FILES) {
        await copyTree(
            path.join(REPO_ROOT, 'scripts', fileName),
            path.join(LIVE_REPO_DIR, 'scripts', fileName)
        );
    }

    for (const fileName of LIVE_TEST_FILES) {
        await copyTree(
            path.join(REPO_ROOT, 'tests', fileName),
            path.join(LIVE_REPO_DIR, 'tests', fileName)
        );
    }

    for (const fileName of LIVE_FIXTURE_FILES) {
        await copyTree(
            path.join(REPO_ROOT, 'tests', 'fixtures', fileName),
            path.join(LIVE_REPO_DIR, 'tests', 'fixtures', fileName)
        );
    }

    await writeText(path.join(LIVE_REPO_DIR, '.nojekyll'), '');
    await writeText(
        path.join(LIVE_REPO_DIR, 'README.md'),
        [
            '# my-exam-live',
            '',
            'Live scraper repo for the current exam year.',
            '',
            'Published paths:',
            '- `data/latest.json`',
            '- `data/all_results.json`',
            '- `data/regions/...`',
            '- `data/pdfs/...`',
            '- `data/stats/...` for the live year',
            '',
            'This repo keeps the scheduled GitHub Actions workflow.',
            ''
        ].join('\n')
    );

    await copyTree(path.join(REPO_ROOT, 'data', 'latest.json'), path.join(LIVE_REPO_DIR, 'data', 'latest.json'));
    await copyTree(path.join(REPO_ROOT, 'data', 'all_results.json'), path.join(LIVE_REPO_DIR, 'data', 'all_results.json'));
    await copyTree(path.join(REPO_ROOT, 'data', 'regions'), path.join(LIVE_REPO_DIR, 'data', 'regions'));
    await copyTree(path.join(REPO_ROOT, 'data', 'pdfs'), path.join(LIVE_REPO_DIR, 'data', 'pdfs'));

    await writeJson(path.join(LIVE_REPO_DIR, 'data', 'stats', 'latest.json'), LIVE_STATS_PLACEHOLDER);
    await writeText(path.join(LIVE_REPO_DIR, 'data', 'stats', 'years', '.gitkeep'), '');
    await writeText(path.join(LIVE_REPO_DIR, 'data', 'stats', 'pdfs', '.gitkeep'), '');
    await writeText(path.join(LIVE_REPO_DIR, 'data', 'stats', 'pdfs', '2026', '.gitkeep'), '');
}

async function exportSplitRepos() {
    await removeObsoleteGeneratedDirectory(OBSOLETE_ARCHIVE_REPO_DIR, 'archive');
    await buildArchiveRepo(
        ARCHIVE_RECENT_REPO_DIR,
        'archive-recent',
        ARCHIVE_RECENT_YEARS,
        [
            { source: path.join('data', 'questions'), target: path.join('data', 'questions') },
            { source: path.join('data', 'stats'), target: path.join('data', 'stats') }
        ]
    );
    await buildArchiveRepo(ARCHIVE_LEGACY_REPO_DIR, 'archive-legacy', ARCHIVE_LEGACY_YEARS);
    await buildLiveRepo();

    console.log(`Exported recent archive repo to ${ARCHIVE_RECENT_REPO_DIR}`);
    console.log(`Exported legacy archive repo to ${ARCHIVE_LEGACY_REPO_DIR}`);
    console.log(`Exported live repo to ${LIVE_REPO_DIR}`);
}

if (require.main === module) {
    exportSplitRepos().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    exportSplitRepos
};
