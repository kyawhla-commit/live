const axios = require('axios');
const cheerio = require('cheerio');
const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');

const SOURCE_URL = normalizePageUrl(process.env.SOURCE_URL || 'https://2026.myanmarexam.org');
const YEAR = inferYear(SOURCE_URL);
const OUTPUT_DIR = path.resolve(process.env.STATS_OUTPUT_DIR || path.join(__dirname, '..', 'data', 'stats'));
const DATA_ROOT_DIR = path.resolve(process.env.STATS_DATA_ROOT_DIR || path.dirname(OUTPUT_DIR));
const YEARS_DIR = path.resolve(process.env.STATS_YEARS_DIR || path.join(OUTPUT_DIR, 'years'));
const LATEST_FILE = path.resolve(process.env.STATS_LATEST_FILE || path.join(OUTPUT_DIR, 'latest.json'));
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === 'true';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10);
const VALIDATE_PDF_LINKS = process.env.STATS_VALIDATE_PDF_LINKS !== 'false';
const MIRROR_PDFS = process.env.STATS_MIRROR_PDFS !== 'false';
const PDF_CONCURRENCY = Math.max(1, Number.parseInt(process.env.STATS_PDF_CONCURRENCY || '4', 10));
const PDF_MIRROR_DIR = path.resolve(process.env.STATS_PDF_MIRROR_DIR || path.join(OUTPUT_DIR, 'pdfs'));
const PDF_MIRROR_BASE_PATH = (
    process.env.STATS_PDF_MIRROR_BASE_PATH ||
    path.relative(DATA_ROOT_DIR, PDF_MIRROR_DIR) ||
    'stats/pdfs'
)
    .replace(/\\/g, '/')
    .replace(/^\.\/?/, '');

const MYANMAR_DIGITS = new Map([
    ['၀', '0'],
    ['၁', '1'],
    ['၂', '2'],
    ['၃', '3'],
    ['၄', '4'],
    ['၅', '5'],
    ['၆', '6'],
    ['၇', '7'],
    ['၈', '8'],
    ['၉', '9']
]);

function normalizePageUrl(url) {
    const normalized = new URL(url);
    normalized.hash = '';
    return normalized.href;
}

function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeMyanmarDigits(text) {
    return String(text || '').replace(/[၀-၉]/g, (digit) => MYANMAR_DIGITS.get(digit) || digit);
}

function inferYear(sourceUrl) {
    if (process.env.YEAR) {
        return process.env.YEAR;
    }

    return new URL(sourceUrl).hostname.match(/\b(\d{4})\b/)?.[1] || null;
}

function getFileName(fileUrl) {
    const fileName = path.basename(new URL(fileUrl).pathname);
    return decodeURIComponent(fileName || 'stats.pdf');
}

function getContentType(response) {
    return String(response.headers?.['content-type'] || '').toLowerCase();
}

function isPdfResponseContent(prefixBuffer, contentType) {
    if (prefixBuffer.subarray(0, 5).toString('ascii') === '%PDF-') {
        return true;
    }

    if (contentType.includes('application/pdf')) {
        return true;
    }

    if (contentType.includes('xml') || contentType.includes('html') || /^text\//.test(contentType)) {
        return false;
    }

    const prefixText = prefixBuffer.toString('utf8').trimStart().slice(0, 32).toLowerCase();

    return !prefixText.startsWith('<?xml') && !prefixText.startsWith('<error') && !prefixText.startsWith('<!doctype');
}

async function readResponsePrefix(stream, maxBytes = 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;

        const finish = (error, buffer) => {
            if (settled) {
                return;
            }

            settled = true;
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
            stream.removeListener('close', onClose);

            if (!stream.destroyed) {
                stream.destroy();
            }

            if (error) {
                reject(error);
                return;
            }

            resolve(buffer);
        };

        const onData = (chunk) => {
            chunks.push(chunk);
            size += chunk.length;

            if (size >= maxBytes) {
                finish(null, Buffer.concat(chunks, size).subarray(0, maxBytes));
            }
        };

        const onEnd = () => {
            finish(null, Buffer.concat(chunks, size));
        };

        const onClose = () => {
            if (!settled) {
                finish(null, Buffer.concat(chunks, size));
            }
        };

        const onError = (error) => {
            finish(error);
        };

        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('close', onClose);
        stream.on('error', onError);
    });
}

function getMirrorRelativeUrl(year, document) {
    return [PDF_MIRROR_BASE_PATH, year, document.fileName]
        .filter(Boolean)
        .join('/');
}

function getMirrorOutputPath(year, document) {
    return path.join(PDF_MIRROR_DIR, year, document.fileName);
}

function parseStatsPage(html, pageUrl, year = YEAR) {
    const $ = cheerio.load(html);
    const documents = [];

    $('tr').each((index, row) => {
        const link = $(row).find('a[href$=".pdf"], a[href*=".pdf"]').first();

        if (!link.length) {
            return;
        }

        let url;

        try {
            url = new URL(link.attr('href'), pageUrl).href;
        } catch {
            return;
        }

        if (!/\/stats\/.+\.pdf(?:[?#].*)?$/i.test(url)) {
            return;
        }

        const cells = $(row)
            .find('td')
            .map((cellIndex, cell) => cleanText($(cell).text()))
            .get()
            .filter(Boolean)
            .filter((cell) => cell.toLowerCase() !== 'download');

        if (cells.length === 0) {
            return;
        }

        const orderText = cells.find((cell) => /^[0-9၀-၉]+$/.test(cell)) || String(documents.length + 1);
        const title = cells.find((cell) => !/^[0-9၀-၉]+$/.test(cell));
        const order = Number.parseInt(normalizeMyanmarDigits(orderText), 10) || documents.length + 1;

        if (!title) {
            return;
        }

        documents.push({
            id: `${year || 'stats'}-${String(order).padStart(2, '0')}`,
            order,
            title,
            url,
            fileName: getFileName(url),
            sourcePage: pageUrl
        });
    });

    return documents.sort((left, right) => left.order - right.order);
}

function buildYearPayload(year, documents, sourcePages) {
    return {
        metadata: {
            year,
            sourcePages,
            scrapedAt: new Date().toISOString(),
            documentCount: documents.length,
            mirroredCount: documents.filter((document) => document.mirrored).length
        },
        documents
    };
}

function buildLatestPayload(yearPayloads) {
    const years = yearPayloads
        .map((payload) => ({
            year: payload.metadata.year,
            dataFile: `stats/years/${payload.metadata.year}.json`,
            documentCount: payload.metadata.documentCount,
            mirroredCount: payload.metadata.mirroredCount,
            documents: payload.documents.map((document) => ({
                id: document.id,
                order: document.order,
                title: document.title,
                fileName: document.fileName
            }))
        }))
        .sort((left, right) => Number(right.year) - Number(left.year));
    const sourcePages = Array.from(
        new Set(
            yearPayloads.flatMap((payload) => payload.metadata.sourcePages || []).filter(Boolean)
        )
    );

    return {
        metadata: {
            sourcePages: sourcePages.length > 0 ? sourcePages : [SOURCE_URL],
            scrapedAt: new Date().toISOString(),
            yearCount: years.length,
            documentCount: years.reduce((total, year) => total + year.documentCount, 0),
            mirroredCount: years.reduce((total, year) => total + year.mirroredCount, 0)
        },
        years
    };
}

async function writeJson(filePath, payload) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(`${filePath}.tmp`, filePath);
}

async function ensureTrackedDirectory(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, '.gitkeep'), '');
}

async function validatePdfLink(client, document) {
    if (!VALIDATE_PDF_LINKS) {
        return { ok: true, status: null, reason: null };
    }

    try {
        const response = await client.get(document.url, {
            headers: {
                Accept: 'application/pdf,*/*;q=0.8',
                Range: 'bytes=0-1023'
            },
            responseType: 'stream',
            validateStatus: () => true
        });
        const contentType = getContentType(response);
        const prefix = await readResponsePrefix(response.data);

        if ((response.status === 200 || response.status === 206) && isPdfResponseContent(prefix, contentType)) {
            return { ok: true, status: response.status, reason: null };
        }

        return {
            ok: false,
            status: response.status,
            reason: contentType || 'unexpected response'
        };
    } catch (error) {
        return {
            ok: false,
            status: error.response?.status || null,
            reason: error.message
        };
    }
}

async function mirrorStatsPdf(client, year, document) {
    const outputPath = getMirrorOutputPath(year, document);
    const tmpPath = `${outputPath}.tmp`;

    try {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const response = await client.get(document.url, {
            headers: {
                Accept: 'application/pdf,*/*;q=0.8',
                Referer: document.sourcePage
            },
            responseType: 'stream',
            validateStatus: () => true
        });

        if (response.status !== 200) {
            response.data.destroy();
            throw new Error(`download returned ${response.status}`);
        }

        const contentType = getContentType(response);

        if (contentType.includes('xml') || contentType.includes('html') || /^text\//.test(contentType)) {
            response.data.destroy();
            throw new Error(`download returned ${contentType || 'unexpected content'}`);
        }

        await pipeline(response.data, createWriteStream(tmpPath));
        await fs.rename(tmpPath, outputPath);

        return {
            ...document,
            sourceUrl: document.url,
            url: getMirrorRelativeUrl(year, document),
            mirrored: true
        };
    } catch (error) {
        await fs.rm(tmpPath, { force: true });
        throw error;
    }
}

async function prepareDocuments(client, year, documents) {
    if (!VALIDATE_PDF_LINKS && !MIRROR_PDFS) {
        return {
            documents,
            mirroredCount: 0,
            filteredCount: 0
        };
    }

    if (MIRROR_PDFS) {
        await fs.rm(path.join(PDF_MIRROR_DIR, year), { recursive: true, force: true });
        await ensureTrackedDirectory(path.join(PDF_MIRROR_DIR, year));
    }

    const processed = new Array(documents.length);
    let nextIndex = 0;
    let mirroredCount = 0;
    let filteredCount = 0;
    const workerCount = Math.min(PDF_CONCURRENCY, documents.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < documents.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            const document = documents[currentIndex];

            try {
                const nextDocument = MIRROR_PDFS
                    ? await mirrorStatsPdf(client, year, document)
                    : await (async () => {
                        const validation = await validatePdfLink(client, document);

                        if (!validation.ok) {
                            const detail = validation.status ? `${validation.status}` : validation.reason || 'unreachable';
                            throw new Error(detail);
                        }

                        return document;
                    })();

                if (nextDocument.mirrored) {
                    mirroredCount += 1;
                }

                processed[currentIndex] = nextDocument;
            } catch (error) {
                filteredCount += 1;
                console.log(`Skipping stats PDF (${error.message}): ${document.url}`);
            }
        }
    }));

    return {
        documents: processed.filter(Boolean),
        mirroredCount,
        filteredCount
    };
}

async function loadYearPayloads() {
    try {
        const entries = await fs.readdir(YEARS_DIR);
        const yearFiles = entries.filter((entry) => entry.endsWith('.json'));
        const payloads = await Promise.all(
            yearFiles.map(async (entry) => {
                const filePath = path.join(YEARS_DIR, entry);
                const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
                return payload;
            })
        );

        return payloads.sort((left, right) => Number(right.metadata.year) - Number(left.metadata.year));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

async function scrapeStats() {
    const client = axios.create({
        headers: {
            'User-Agent': '2026-exam-results-stats-scraper/1.0'
        },
        httpsAgent: ALLOW_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined,
        timeout: REQUEST_TIMEOUT_MS
    });

    await ensureTrackedDirectory(YEARS_DIR);
    await ensureTrackedDirectory(PDF_MIRROR_DIR);
    await ensureTrackedDirectory(path.join(PDF_MIRROR_DIR, YEAR));

    console.log(`Scraping exam statistics from ${SOURCE_URL}`);
    const response = await client.get(SOURCE_URL);
    const sourceDocuments = parseStatsPage(response.data, SOURCE_URL, YEAR);
    const {
        documents,
        mirroredCount,
        filteredCount
    } = await prepareDocuments(client, YEAR, sourceDocuments);
    const yearFile = path.join(YEARS_DIR, `${YEAR}.json`);

    if (documents.length > 0) {
        await writeJson(yearFile, buildYearPayload(YEAR, documents, [SOURCE_URL]));
    } else {
        await fs.rm(yearFile, { force: true });
    }

    const yearPayloads = await loadYearPayloads();
    await writeJson(LATEST_FILE, buildLatestPayload(yearPayloads));

    console.log(`Saved ${documents.length} stats PDF link(s) for ${YEAR}.`);
    if (mirroredCount > 0) {
        console.log(`Mirrored ${mirroredCount} stats PDF file(s) into ${PDF_MIRROR_DIR}.`);
    }
    if (filteredCount > 0) {
        console.log(`Filtered out ${filteredCount} inaccessible stats PDF link(s).`);
    }
}

if (require.main === module) {
    scrapeStats().catch((error) => {
        console.error(`Stats scrape failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    buildLatestPayload,
    buildYearPayload,
    ensureTrackedDirectory,
    normalizeMyanmarDigits,
    parseStatsPage,
    prepareDocuments,
    scrapeStats
};
