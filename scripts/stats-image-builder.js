const fs = require('fs/promises');
const path = require('path');

const {
    cleanText,
    ensureRequiredTools,
    loadAvailableManifestMap,
    mapWithConcurrency,
    renderPdfToImageManifest,
    writeJson
} = require('./pdf-image-manifest-utils.js');

const OUTPUT_DIR = path.resolve(process.env.STATS_OUTPUT_DIR || path.join(__dirname, '..', 'data', 'stats'));
const YEARS_DIR = path.resolve(process.env.STATS_YEARS_DIR || path.join(OUTPUT_DIR, 'years'));
const IMAGE_FORMAT = String(process.env.IMAGE_FORMAT || 'webp').toLowerCase();
const IMAGE_QUALITY = Math.max(1, Number.parseInt(process.env.IMAGE_QUALITY || '80', 10));
const IMAGE_DPI = Math.max(72, Number.parseInt(process.env.IMAGE_DPI || '144', 10));
const IMAGE_CONCURRENCY = Math.max(1, Number.parseInt(process.env.STATS_IMAGE_CONCURRENCY || process.env.IMAGE_CONCURRENCY || '2', 10));
const IMAGE_FORCE = process.env.STATS_IMAGE_FORCE === 'true' || process.env.IMAGE_FORCE === 'true';
const IMAGE_MAX_DOCUMENTS = Math.max(0, Number.parseInt(process.env.STATS_IMAGE_MAX_DOCUMENTS || '0', 10));

function getImageFileStem(fileName) {
    return path.basename(fileName, path.extname(fileName));
}

function getDocumentKey(item) {
    return item.document.url;
}

function getImageManifestRelativeUrl(item) {
    return ['stats', 'image-manifests', item.year, `${getImageFileStem(item.document.fileName)}.json`].join('/');
}

function getImagePagesRelativeDir(item) {
    return ['stats', 'image-pages', item.year, getImageFileStem(item.document.fileName)].join('/');
}

function getImageManifestPath(item) {
    return path.resolve(OUTPUT_DIR, 'image-manifests', item.year, `${getImageFileStem(item.document.fileName)}.json`);
}

function getImageOutputDir(item) {
    return path.resolve(OUTPUT_DIR, 'image-pages', item.year, getImageFileStem(item.document.fileName));
}

function getPdfInputPath(item) {
    return path.resolve(path.dirname(OUTPUT_DIR), item.document.url);
}

function buildImageManifest(item, pages) {
    return {
        metadata: {
            version: 1,
            kind: 'stats',
            year: item.year,
            generatedAt: new Date().toISOString(),
            format: IMAGE_FORMAT,
            dpi: IMAGE_DPI,
            quality: IMAGE_QUALITY,
            pageCount: pages.length,
            pdfUrl: item.document.url,
            fileName: item.document.fileName,
            sourcePage: item.document.sourcePage,
            sourcePageTitle: item.document.title,
            title: cleanText(item.document.title)
        },
        pages
    };
}

function attachStatsImageManifests(payload, manifestMap) {
    return {
        ...payload,
        documents: payload.documents.map((document) => {
            const manifest = manifestMap.get(document.url);

            if (!manifest) {
                return {
                    ...document,
                    imageManifest: null,
                    imagePageCount: null
                };
            }

            const item = { year: payload.metadata.year, document };

            return {
                ...document,
                imageManifest: getImageManifestRelativeUrl(item),
                imagePageCount: manifest.metadata.pageCount
            };
        })
    };
}

async function getYearFileNames() {
    return (await fs.readdir(YEARS_DIR))
        .filter((fileName) => fileName.endsWith('.json'))
        .sort((left, right) => Number.parseInt(right, 10) - Number.parseInt(left, 10));
}

async function generateStatsImageReader() {
    await ensureRequiredTools();

    const yearFileNames = await getYearFileNames();
    const payloadEntries = [];

    for (const fileName of yearFileNames) {
        const filePath = path.join(YEARS_DIR, fileName);
        const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
        payloadEntries.push({ fileName, filePath, payload });
    }

    const documentItems = payloadEntries.flatMap(({ payload }) =>
        payload.documents.map((document) => ({
            year: payload.metadata.year,
            document
        }))
    );

    const sourceItems = IMAGE_MAX_DOCUMENTS > 0 ? documentItems.slice(0, IMAGE_MAX_DOCUMENTS) : documentItems;
    const manifestEntries = [];
    const failures = [];

    await mapWithConcurrency(sourceItems, async (item) => {
        try {
            const manifest = await renderPdfToImageManifest({
                rootDir: path.dirname(OUTPUT_DIR),
                pdfPath: getPdfInputPath(item),
                outputDir: getImageOutputDir(item),
                manifestPath: getImageManifestPath(item),
                imageDpi: IMAGE_DPI,
                imageQuality: IMAGE_QUALITY,
                imageFormat: IMAGE_FORMAT,
                imageForce: IMAGE_FORCE,
                getPageRelativeUrl: (pageNumber) =>
                    `${getImagePagesRelativeDir(item)}/page-${String(pageNumber).padStart(3, '0')}.${IMAGE_FORMAT}`,
                buildManifest: (pages) => buildImageManifest(item, pages),
                tempKey: `${item.year}-${getImageFileStem(item.document.fileName)}`
            });

            manifestEntries.push([getDocumentKey(item), manifest]);
            process.stdout.write(`Generated stats image manifest for ${item.document.fileName} (${manifest.metadata.pageCount} pages)\n`);
        } catch (error) {
            failures.push({
                fileName: item.document.fileName,
                message: error instanceof Error ? error.message : String(error)
            });
            process.stderr.write(`Failed to generate stats image manifest for ${item.document.fileName}: ${failures.at(-1).message}\n`);
        }
    }, IMAGE_CONCURRENCY);

    const manifestMap = await loadAvailableManifestMap(sourceItems, {
        concurrency: IMAGE_CONCURRENCY,
        getManifestPath: getImageManifestPath,
        rootDir: path.dirname(OUTPUT_DIR),
        imageForce: IMAGE_FORCE,
        getKey: getDocumentKey
    });

    for (const entry of payloadEntries) {
        await writeJson(entry.filePath, attachStatsImageManifests(entry.payload, manifestMap));
    }

    process.stdout.write(
        `Stats image reader build complete. Generated ${manifestEntries.length} manifest(s), attached ${manifestMap.size} manifest(s), failed ${failures.length}.\n`
    );

    if (failures.length > 0) {
        process.stdout.write(`Stats image reader failures:\n${failures.map((failure) => `- ${failure.fileName}: ${failure.message}`).join('\n')}\n`);
    }
}

if (require.main === module) {
    generateStatsImageReader().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    attachStatsImageManifests,
    buildImageManifest,
    getImageManifestRelativeUrl,
    getImagePagesRelativeDir
};
