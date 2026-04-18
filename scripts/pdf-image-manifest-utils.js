const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
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

async function readExistingManifest({
    manifestPath,
    rootDir,
    imageForce,
    respectForce = true
}) {
    if (respectForce && imageForce) {
        return null;
    }

    try {
        const payload = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const missingPage = (payload.pages || []).find((page) => !page.url);

        if (!payload?.metadata?.pageCount || missingPage) {
            return null;
        }

        await Promise.all(
            payload.pages.map((page) => fs.access(path.resolve(rootDir, page.url)))
        );
        return payload;
    } catch {
        return null;
    }
}

async function renderPdfToImageManifest({
    rootDir,
    pdfPath,
    outputDir,
    manifestPath,
    imageDpi,
    imageQuality,
    imageFormat,
    imageForce,
    getPageRelativeUrl,
    buildManifest,
    tempKey
}) {
    const cachedManifest = await readExistingManifest({
        manifestPath,
        rootDir,
        imageForce
    });

    if (cachedManifest) {
        return cachedManifest;
    }

    const safeTempKey = String(tempKey || path.basename(pdfPath, path.extname(pdfPath))).replace(/[^a-z0-9._-]+/gi, '-');
    const tempDir = path.resolve(rootDir, '.image-render-tmp', `${safeTempKey}-${Date.now()}`);
    const tempPrefix = path.join(tempDir, 'page');

    await fs.access(pdfPath);
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    try {
        await runTool('pdftocairo', ['-png', '-r', String(imageDpi), pdfPath, tempPrefix]);
        const pngFiles = sortPageFiles(
            (await fs.readdir(tempDir)).filter((fileName) => /^page-\d+\.png$/i.test(fileName))
        );

        if (pngFiles.length === 0) {
            throw new Error(`No page images were generated for ${path.basename(pdfPath)}`);
        }

        const pages = [];

        for (const [index, pngFileName] of pngFiles.entries()) {
            const pageNumber = index + 1;
            const pngPath = path.join(tempDir, pngFileName);
            const outputPath = path.join(outputDir, `page-${String(pageNumber).padStart(3, '0')}.${imageFormat}`);

            await runTool('convert', [pngPath, '-quality', String(imageQuality), outputPath]);
            const dimensions = await getImageDimensions(outputPath);

            pages.push({
                index: pageNumber,
                width: dimensions.width,
                height: dimensions.height,
                url: getPageRelativeUrl(pageNumber)
            });
        }

        const manifest = buildManifest(pages);
        await writeJson(manifestPath, manifest);
        return manifest;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function mapWithConcurrency(items, worker, concurrency) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);

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

async function loadAvailableManifestMap(items, {
    concurrency,
    getManifestPath,
    rootDir,
    imageForce,
    getKey
}) {
    const entries = await mapWithConcurrency(items, async (item) => {
        const manifest = await readExistingManifest({
            manifestPath: getManifestPath(item),
            rootDir,
            imageForce,
            respectForce: false
        });

        return manifest ? [getKey(item), manifest] : null;
    }, concurrency);

    return new Map(entries.filter(Boolean));
}

module.exports = {
    cleanText,
    ensureRequiredTools,
    loadAvailableManifestMap,
    mapWithConcurrency,
    renderPdfToImageManifest,
    writeJson
};
