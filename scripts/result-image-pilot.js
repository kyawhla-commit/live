const axios = require('axios');
const { execFile } = require('child_process');
const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const YEAR = String(process.env.YEAR || '2025');
const ARCHIVE_DIR = path.resolve(
    process.env.IMAGE_ARCHIVE_DIR || path.join(__dirname, '..', 'data', 'archive', YEAR)
);
const OUTPUT_FILE = path.resolve(process.env.IMAGE_OUTPUT_FILE || path.join(ARCHIVE_DIR, 'all_results.json'));
const REGIONS_DIR = path.resolve(process.env.IMAGE_REGIONS_DIR || path.join(ARCHIVE_DIR, 'regions'));
const IMAGE_MANIFEST_DIR = path.resolve(
    process.env.IMAGE_MANIFEST_DIR || path.join(ARCHIVE_DIR, 'image-manifests')
);
const IMAGE_PAGES_DIR = path.resolve(
    process.env.IMAGE_PAGES_DIR || path.join(ARCHIVE_DIR, 'image-pages')
);
const IMAGE_FORMAT = String(process.env.IMAGE_FORMAT || 'webp').toLowerCase();
const IMAGE_QUALITY = Math.max(1, Number.parseInt(process.env.IMAGE_QUALITY || '80', 10));
const IMAGE_DPI = Math.max(72, Number.parseInt(process.env.IMAGE_DPI || '144', 10));
const IMAGE_CONCURRENCY = Math.max(1, Number.parseInt(process.env.IMAGE_CONCURRENCY || '2', 10));
const IMAGE_FORCE = process.env.IMAGE_FORCE === 'true';
const IMAGE_MAX_RESULTS = Math.max(0, Number.parseInt(process.env.IMAGE_MAX_RESULTS || '0', 10));
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === 'true';
const REQUEST_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10));

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isRemoteUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function createHttpClient() {
    return axios.create({
        timeout: REQUEST_TIMEOUT_MS,
        httpsAgent: ALLOW_INSECURE_TLS
            ? new https.Agent({
                rejectUnauthorized: false
            })
            : undefined
    });
}

function getContentType(response) {
    return String(response.headers?.['content-type'] || '').toLowerCase();
}

function getPageSlug(pageUrl) {
    const url = new URL(pageUrl);
    const fileName = path.basename(url.pathname);

    if (!fileName) {
        return 'home';
    }

    return fileName.replace(/\.[^.]+$/, '').toLowerCase();
}

function getImageFileStem(result) {
    return path.basename(result.fileName || result.url, '.pdf');
}

function getImageManifestRelativeUrl(result) {
    return ['image-manifests', getPageSlug(result.sourcePage), `${getImageFileStem(result)}.json`].join('/');
}

function getImagePagesRelativeDir(result) {
    return ['image-pages', getPageSlug(result.sourcePage), getImageFileStem(result)].join('/');
}

function getPdfInputPath(result) {
    return path.resolve(ARCHIVE_DIR, result.url);
}

function getImageOutputDir(result) {
    return path.resolve(ARCHIVE_DIR, getImagePagesRelativeDir(result));
}

function getImageManifestPath(result) {
    return path.resolve(ARCHIVE_DIR, getImageManifestRelativeUrl(result));
}

function getImageRelativePagePath(result, index) {
    return `${getImagePagesRelativeDir(result)}/page-${String(index).padStart(3, '0')}.${IMAGE_FORMAT}`;
}

function sortPageFiles(fileNames) {
    return [...fileNames].sort((left, right) => {
        const leftMatch = left.match(/page-(\d+)/i);
        const rightMatch = right.match(/page-(\d+)/i);
        const leftNumber = leftMatch ? Number.parseInt(leftMatch[1], 10) : Number.MAX_SAFE_INTEGER;
        const rightNumber = rightMatch ? Number.parseInt(rightMatch[1], 10) : Number.MAX_SAFE_INTEGER;

        return leftNumber - rightNumber;
    });
}

async function writeJson(filePath, payload) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(`${filePath}.tmp`, filePath);
}

async function runTool(command, args) {
    await execFileAsync(command, args, {
        maxBuffer: 16 * 1024 * 1024
    });
}

async function ensureRequiredTools() {
    await runTool('pdftocairo', ['-v']);
    await runTool('identify', ['-version']);
    await runTool('convert', ['-version']);
}

async function downloadRemotePdf(result, outputPath) {
    const client = createHttpClient();
    const response = await client.get(result.url, {
        headers: {
            Accept: 'application/pdf,*/*;q=0.8',
            Referer: result.sourcePage
        },
        responseType: 'stream',
        validateStatus: () => true
    });

    const contentType = getContentType(response);

    if (response.status !== 200) {
        response.data.destroy();
        throw new Error(`Remote PDF download failed with status ${response.status}`);
    }

    if (contentType.includes('xml') || contentType.includes('html') || /^text\//.test(contentType)) {
        response.data.destroy();
        throw new Error(`Remote PDF download returned ${contentType || 'unexpected content'}`);
    }

    await pipeline(response.data, createWriteStream(outputPath));
}

async function preparePdfInput(result, tempDir) {
    if (!isRemoteUrl(result.url)) {
        const pdfPath = getPdfInputPath(result);
        await fs.access(pdfPath);
        return pdfPath;
    }

    const pdfPath = path.join(tempDir, `${getImageFileStem(result)}.pdf`);
    await downloadRemotePdf(result, pdfPath);
    return pdfPath;
}

async function getImageDimensions(filePath) {
    const { stdout } = await execFileAsync('identify', ['-format', '%w %h', filePath], {
        maxBuffer: 1024 * 1024
    });
    const [width, height] = stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));

    return {
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0
    };
}

function buildImageManifest(result, pages) {
    return {
        metadata: {
            version: 1,
            year: YEAR,
            generatedAt: new Date().toISOString(),
            format: IMAGE_FORMAT,
            dpi: IMAGE_DPI,
            quality: IMAGE_QUALITY,
            pageCount: pages.length,
            pdfUrl: result.url,
            fileName: result.fileName,
            sourcePage: result.sourcePage,
            sourcePageTitle: result.sourcePageTitle,
            title: cleanText(result.examCenter || result.name || result.fileName)
        },
        pages
    };
}

async function readExistingManifest(result, options = {}) {
    const { respectForce = true } = options;

    if (respectForce && IMAGE_FORCE) {
        return null;
    }

    try {
        const manifestPath = getImageManifestPath(result);
        const payload = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const missingPage = (payload.pages || []).find((page) => !page.url);

        if (!payload?.metadata?.pageCount || missingPage) {
            return null;
        }

        await Promise.all(
            payload.pages.map((page) => fs.access(path.resolve(ARCHIVE_DIR, page.url)))
        );
        return payload;
    } catch {
        return null;
    }
}

async function loadAvailableManifestMap(results) {
    const entries = await mapWithConcurrency(results, async (result) => {
        const manifest = await readExistingManifest(result, { respectForce: false });
        return manifest ? [result.url, manifest] : null;
    });

    return new Map(entries.filter(Boolean));
}

async function renderPdfToImageManifest(result) {
    const cachedManifest = await readExistingManifest(result);

    if (cachedManifest) {
        return cachedManifest;
    }

    const outputDir = getImageOutputDir(result);
    const manifestPath = getImageManifestPath(result);
    const tempDir = path.resolve(ARCHIVE_DIR, '.image-render-tmp', `${getImageFileStem(result)}-${Date.now()}`);
    const tempPrefix = path.join(tempDir, 'page');

    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    try {
        const pdfPath = await preparePdfInput(result, tempDir);
        await runTool('pdftocairo', ['-png', '-r', String(IMAGE_DPI), pdfPath, tempPrefix]);
        const pngFiles = sortPageFiles(
            (await fs.readdir(tempDir)).filter((fileName) => /^page-\d+\.png$/i.test(fileName))
        );

        if (pngFiles.length === 0) {
            throw new Error(`No page images were generated for ${result.fileName}`);
        }

        const pages = [];

        for (const [index, pngFileName] of pngFiles.entries()) {
            const pageNumber = index + 1;
            const pngPath = path.join(tempDir, pngFileName);
            const outputPath = path.join(outputDir, `page-${String(pageNumber).padStart(3, '0')}.${IMAGE_FORMAT}`);

            await runTool('convert', [pngPath, '-quality', String(IMAGE_QUALITY), outputPath]);
            const dimensions = await getImageDimensions(outputPath);

            pages.push({
                index: pageNumber,
                width: dimensions.width,
                height: dimensions.height,
                url: getImageRelativePagePath(result, pageNumber)
            });
        }

        const manifest = buildImageManifest(result, pages);
        await writeJson(manifestPath, manifest);
        return manifest;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

function attachImageManifests(payload, manifestMap) {
    return {
        ...payload,
        results: payload.results.map((result) => {
            const manifest = manifestMap.get(result.url);

            if (!manifest) {
                return {
                    ...result,
                    imageManifest: null,
                    imagePageCount: null
                };
            }

            return {
                ...result,
                imageManifest: getImageManifestRelativeUrl(result),
                imagePageCount: manifest.metadata.pageCount
            };
        })
    };
}

async function mapWithConcurrency(items, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(IMAGE_CONCURRENCY, items.length);

    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const currentIndex = nextIndex;
                nextIndex += 1;
                results[currentIndex] = await worker(items[currentIndex], currentIndex);
            }
        })
    );

    return results;
}

async function generateImagePilot() {
    await ensureRequiredTools();

    const payload = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8'));
    const sourceResults = IMAGE_MAX_RESULTS > 0 ? payload.results.slice(0, IMAGE_MAX_RESULTS) : payload.results;
    const manifestEntries = [];
    const failures = [];

    await mapWithConcurrency(sourceResults, async (result) => {
        try {
            const manifest = await renderPdfToImageManifest(result);
            manifestEntries.push([result.url, manifest]);
            process.stdout.write(`Generated image manifest for ${result.fileName} (${manifest.metadata.pageCount} pages)\n`);
        } catch (error) {
            failures.push({
                fileName: result.fileName,
                message: error instanceof Error ? error.message : String(error)
            });
            process.stderr.write(`Failed to generate image manifest for ${result.fileName}: ${failures.at(-1).message}\n`);
        }
    });

    const manifestMap = await loadAvailableManifestMap(sourceResults);
    const nextPayload = attachImageManifests(payload, manifestMap);
    await writeJson(OUTPUT_FILE, nextPayload);

    const regionFileNames = (await fs.readdir(REGIONS_DIR)).filter((fileName) => fileName.endsWith('.json'));
    for (const fileName of regionFileNames) {
        const regionFilePath = path.join(REGIONS_DIR, fileName);
        const regionPayload = JSON.parse(await fs.readFile(regionFilePath, 'utf8'));
        await writeJson(regionFilePath, attachImageManifests(regionPayload, manifestMap));
    }

    process.stdout.write(
        `${YEAR} image pilot complete. Generated ${manifestEntries.length} manifest(s), attached ${manifestMap.size} manifest(s), failed ${failures.length}.\n`
    );

    if (failures.length > 0) {
        process.stdout.write(`Image pilot failures:\n${failures.map((failure) => `- ${failure.fileName}: ${failure.message}`).join('\n')}\n`);
    }
}

if (require.main === module) {
    generateImagePilot().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    attachImageManifests,
    buildImageManifest,
    generateImagePilot,
    getImageManifestRelativeUrl,
    getImagePagesRelativeDir,
    getPageSlug
};
