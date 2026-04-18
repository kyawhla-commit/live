const axios = require('axios');
const cheerio = require('cheerio');
const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');

const SOURCE_URL = normalizePageUrl(process.env.SOURCE_URL || 'https://2026.myanmarexam.org');
const OUTPUT_FILE = path.resolve(process.env.OUTPUT_FILE || path.join(__dirname, '..', 'data', 'all_results.json'));
const OUTPUT_DIR = path.dirname(OUTPUT_FILE);
const LATEST_FILE = path.resolve(process.env.LATEST_FILE || path.join(OUTPUT_DIR, 'latest.json'));
const REGIONS_DIR = path.resolve(process.env.REGIONS_DIR || path.join(OUTPUT_DIR, 'regions'));
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === 'true';
const MAX_CRAWL_DEPTH = Number.parseInt(process.env.MAX_CRAWL_DEPTH || '1', 10);
const MAX_PAGES = Number.parseInt(process.env.MAX_PAGES || '40', 10);
const INCLUDE_STATS = process.env.INCLUDE_STATS === 'true';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10);
const ALLOW_PARTIAL_RESULTS = process.env.ALLOW_PARTIAL_RESULTS === 'true';
const WRITE_EMPTY_FEED = process.env.WRITE_EMPTY_FEED === 'true';
const VALIDATE_PDF_LINKS = process.env.VALIDATE_PDF_LINKS === 'true';
const MIRROR_PDFS = process.env.MIRROR_PDFS === 'true';
const SCRAPE_SUMMARY_FILE = process.env.SCRAPE_SUMMARY_FILE ? path.resolve(process.env.SCRAPE_SUMMARY_FILE) : null;
const PDF_VALIDATION_CONCURRENCY = Math.max(
    1,
    Number.parseInt(process.env.PDF_VALIDATION_CONCURRENCY || '8', 10)
);
const PDF_MIRROR_CONCURRENCY = Math.max(
    1,
    Number.parseInt(process.env.PDF_MIRROR_CONCURRENCY || '4', 10)
);
const PDF_MIRROR_DIR = path.resolve(process.env.PDF_MIRROR_DIR || path.join(OUTPUT_DIR, 'pdfs'));
const PDF_MIRROR_BASE_PATH = (process.env.PDF_MIRROR_BASE_PATH || path.relative(OUTPUT_DIR, PDF_MIRROR_DIR) || 'pdfs')
    .replace(/\\/g, '/')
    .replace(/^\.\/?/, '');

function normalizePageUrl(url) {
    const normalized = new URL(url);
    normalized.hash = '';
    return normalized.href;
}

function isPdfLink(href) {
    return /\.pdf(?:[?#].*)?$/i.test(href);
}

function isHtmlPageLink(url) {
    return !path.extname(url.pathname) || /\.html?$/i.test(url.pathname);
}

function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
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

function getFallbackName(url) {
    const fileName = path.basename(new URL(url).pathname);
    return decodeURIComponent(fileName || 'exam-result.pdf');
}

function getMirrorRelativeUrl(result) {
    const safeFileName = path.basename(result.fileName || getFallbackName(result.url));
    return [PDF_MIRROR_BASE_PATH, getPageSlug(result.sourcePage), safeFileName]
        .filter(Boolean)
        .join('/');
}

function getMirrorOutputPath(result) {
    return path.resolve(OUTPUT_DIR, getMirrorRelativeUrl(result));
}

function getPageSlug(pageUrl) {
    const url = new URL(pageUrl);
    const fileName = path.basename(url.pathname);

    if (!fileName) {
        return 'home';
    }

    return fileName.replace(/\.[^.]+$/, '').toLowerCase();
}

function inferYear(sourceUrl) {
    const envYear = process.env.YEAR;

    if (envYear) {
        return envYear;
    }

    return new URL(sourceUrl).hostname.match(/\b(\d{4})\b/)?.[1] || null;
}

function getPageTitle($, pageUrl) {
    const headings = $('h4.page-header')
        .map((index, heading) => cleanText($(heading).text()))
        .get()
        .filter(Boolean);
    const resultHeading = headings.find((heading) => heading.includes('အောင်စာရင်း') && !heading.includes('အထူးအစီအစဉ်'));

    return resultHeading || headings.find((heading) => heading.includes('အောင်စာရင်း')) || cleanText($('title').first().text()) || pageUrl;
}

function shouldFollowPageLink($, element, url, rootUrl) {
    if (url.origin !== new URL(rootUrl).origin || !isHtmlPageLink(url)) {
        return false;
    }

    if (!INCLUDE_STATS && (/stats/i.test(url.pathname) || $(element).closest('#statistics').length > 0)) {
        return false;
    }

    return true;
}

function shouldIncludePdfLink($, element, url) {
    if (INCLUDE_STATS) {
        return true;
    }

    if (/\/stats(?:\/|$)/i.test(url.pathname) || /stats/i.test(url.pathname)) {
        return false;
    }

    return $(element).closest('#statistics').length === 0;
}

function getRowCells($, row) {
    return row
        .find('td')
        .map((index, cell) => cleanText($(cell).text()))
        .get()
        .filter(Boolean)
        .filter((cell) => cell.toLowerCase() !== 'download');
}

function isWrappedCode(value) {
    return /^\(.+\)$/.test(String(value || '').trim());
}

function isCompactCode(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/[()]/g, '');

    return Boolean(normalized) && normalized.length <= 8 && !/\s/.test(normalized);
}

function parseResultRow(linkText, rowCells, url) {
    const serialNo = rowCells[0] || null;
    const wrappedCode = rowCells.length >= 3 ? rowCells.at(-2) : null;
    const compactCode = rowCells.length >= 4 ? rowCells.at(-1) : null;

    if (isWrappedCode(wrappedCode)) {
        const examCenter = rowCells.at(-1) || null;

        return {
            name: linkText && linkText.toLowerCase() !== 'download' ? linkText : examCenter || getFallbackName(url),
            serialNo,
            examCode: wrappedCode,
            examCenter,
            township: rowCells.length >= 4 ? rowCells.at(-3) || null : null,
            district: rowCells.length >= 5 ? rowCells.at(-4) || null : null
        };
    }

    if (isCompactCode(compactCode)) {
        const examCenter = rowCells.at(-2) || null;
        const township = rowCells.length >= 4 ? rowCells.at(-3) || null : null;
        const district = rowCells.length >= 5 ? rowCells.at(-4) || null : null;

        return {
            name: linkText && linkText.toLowerCase() !== 'download' ? linkText : township || examCenter || compactCode,
            serialNo,
            examCode: compactCode,
            examCenter,
            township,
            district
        };
    }

    const examCenter = rowCells.at(-1) || null;

    return {
        name: linkText && linkText.toLowerCase() !== 'download' ? linkText : examCenter || getFallbackName(url),
        serialNo,
        examCode: null,
        examCenter,
        township: null,
        district: null
    };
}

function getResultName(linkText, rowCells, url) {
    if (linkText && linkText.toLowerCase() !== 'download') {
        return linkText;
    }

    return rowCells.at(-1) || getFallbackName(url);
}

function getExamCode(rowCells) {
    if (rowCells.length < 3) {
        return null;
    }

    const possibleCode = rowCells.at(-2);
    return /^\(.+\)$/.test(possibleCode) ? possibleCode : null;
}

function parsePage(html, pageUrl, rootUrl) {
    const $ = cheerio.load(html);
    const pageTitle = getPageTitle($, pageUrl);
    const results = [];
    const childPages = [];

    $('a[href]').each((index, element) => {
        const href = $(element).attr('href');

        if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(href)) {
            return;
        }

        const absoluteUrl = new URL(href, pageUrl);
        absoluteUrl.hash = '';

        if (isPdfLink(absoluteUrl.href)) {
            if (!shouldIncludePdfLink($, element, absoluteUrl)) {
                return;
            }

            const rowCells = getRowCells($, $(element).closest('tr'));
            const linkText = cleanText($(element).text());
            const parsedRow = parseResultRow(linkText, rowCells, absoluteUrl.href);

            results.push({
                name: parsedRow.name,
                url: absoluteUrl.href,
                fileName: getFallbackName(absoluteUrl.href),
                serialNo: parsedRow.serialNo,
                examCode: parsedRow.examCode,
                examCenter: parsedRow.examCenter,
                township: parsedRow.township,
                district: parsedRow.district,
                sourcePage: pageUrl,
                sourcePageTitle: pageTitle
            });
            return;
        }

        if (shouldFollowPageLink($, element, absoluteUrl, rootUrl)) {
            childPages.push({
                title: cleanText($(element).text()) || absoluteUrl.pathname,
                url: normalizePageUrl(absoluteUrl.href)
            });
        }
    });

    return {
        title: pageTitle,
        results,
        childPages
    };
}

function createHttpClient() {
    return axios.create({
        headers: {
            'User-Agent': '2026-exam-results-scraper/1.0'
        },
        httpsAgent: ALLOW_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined,
        timeout: REQUEST_TIMEOUT_MS
    });
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

async function validatePdfLink(client, result, cache) {
    if (!VALIDATE_PDF_LINKS) {
        return { ok: true, status: null, reason: null };
    }

    if (!cache.has(result.url)) {
        cache.set(result.url, (async () => {
            try {
                // Validate as a direct client request. The app opens these URLs directly,
                // so links that only work behind the official site's Referer should be skipped.
                const response = await client.get(result.url, {
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
        })());
    }

    return cache.get(result.url);
}

async function validateMirroredPdfLink(client, result, cache) {
    if (!MIRROR_PDFS) {
        return { ok: false, status: null, reason: null };
    }

    if (!cache.has(result.url)) {
        cache.set(result.url, (async () => {
            try {
                const response = await client.get(result.url, {
                    headers: {
                        Accept: 'application/pdf,*/*;q=0.8',
                        Range: 'bytes=0-1023',
                        Referer: result.sourcePage
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
        })());
    }

    return cache.get(result.url);
}

async function filterAccessibleResults(client, results, validationCache, mirrorValidationCache) {
    if (!VALIDATE_PDF_LINKS || results.length === 0) {
        return {
            accessibleResults: results,
            mirroredCount: 0,
            rejectedCount: 0
        };
    }

    let nextIndex = 0;
    let mirroredCount = 0;
    let rejectedCount = 0;
    const validations = new Array(results.length);
    const workerCount = Math.min(PDF_VALIDATION_CONCURRENCY, results.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < results.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            const result = results[currentIndex];
            const validation = await validatePdfLink(client, result, validationCache);
            if (validation.ok) {
                validations[currentIndex] = {
                    ok: true,
                    result
                };
                continue;
            }

            const mirrorValidation = await validateMirroredPdfLink(client, result, mirrorValidationCache);

            if (mirrorValidation.ok) {
                mirroredCount += 1;
                validations[currentIndex] = {
                    ok: true,
                    result: {
                        ...result,
                        __mirror: {
                            outputPath: getMirrorOutputPath(result),
                            publicUrl: getMirrorRelativeUrl(result),
                            referer: result.sourcePage,
                            sourceUrl: result.url
                        }
                    }
                };
                console.log(`Mirroring blocked PDF through GitHub Pages: ${result.url}`);
                continue;
            }

            validations[currentIndex] = {
                ok: false
            };
            rejectedCount += 1;
            const detail = validation.status ? `${validation.status}` : validation.reason || 'unreachable';
            console.log(`Skipping inaccessible PDF (${detail}): ${result.url}`);
        }
    }));

    return {
        accessibleResults: validations
            .filter((entry) => entry?.ok)
            .map((entry) => entry.result),
        mirroredCount,
        rejectedCount
    };
}

async function crawlResults() {
    const client = createHttpClient();
    const queue = [{ url: SOURCE_URL, depth: 0 }];
    const visitedPages = new Set();
    const resultUrls = new Set();
    const results = [];
    const pages = [];
    const validationCache = new Map();
    const mirrorValidationCache = new Map();
    let mirroredPdfLinks = 0;
    let rejectedPdfLinks = 0;

    while (queue.length > 0 && visitedPages.size < MAX_PAGES) {
        const current = queue.shift();

        if (visitedPages.has(current.url)) {
            continue;
        }

        visitedPages.add(current.url);
        console.log(`Scraping ${current.url}`);

        let data;

        try {
            const response = await client.get(current.url);
            data = response.data;
        } catch (error) {
            if (current.depth === 0) {
                throw error;
            }

            console.warn(`Skipping ${current.url}: ${error.message}`);
            pages.push({
                url: current.url,
                title: null,
                resultCount: 0,
                error: error.message
            });
            continue;
        }

        const page = parsePage(data, current.url, SOURCE_URL);
        const { accessibleResults, mirroredCount, rejectedCount } = await filterAccessibleResults(
            client,
            page.results,
            validationCache,
            mirrorValidationCache
        );
        mirroredPdfLinks += mirroredCount;
        rejectedPdfLinks += rejectedCount;

        for (const result of accessibleResults) {
            if (resultUrls.has(result.url)) {
                continue;
            }

            resultUrls.add(result.url);
            results.push(result);
        }

        pages.push({
            url: current.url,
            title: page.title,
            resultCount: accessibleResults.length
        });

        if (current.depth >= MAX_CRAWL_DEPTH) {
            continue;
        }

        for (const childPage of page.childPages) {
            if (visitedPages.has(childPage.url) || queue.some((queued) => queued.url === childPage.url)) {
                continue;
            }

            queue.push({
                url: childPage.url,
                depth: current.depth + 1
            });
        }
    }

    return { results, pages, mirroredPdfLinks, rejectedPdfLinks };
}

function buildPayload(results, pages) {
    return {
        metadata: {
            year: inferYear(SOURCE_URL),
            sourceUrl: SOURCE_URL,
            scrapedAt: new Date().toISOString(),
            resultCount: results.length,
            pagesVisited: pages.length,
            maxCrawlDepth: MAX_CRAWL_DEPTH
        },
        pages,
        results
    };
}

function buildPublicPayload(payload) {
    return {
        metadata: payload.metadata,
        pages: payload.pages,
        results: payload.results.map((result) => ({
            name: result.name,
            url: result.__mirror?.publicUrl || result.url,
            fileName: result.fileName,
            serialNo: result.serialNo,
            examCode: result.examCode,
            examCenter: result.examCenter,
            township: result.township,
            district: result.district,
            sourcePage: result.sourcePage,
            sourcePageTitle: result.sourcePageTitle
        }))
    };
}

function getPageResults(payload, page) {
    return payload.results.filter((result) => result.sourcePage === page.url);
}

function getNormalizedRegionTitle(value) {
    const normalized = cleanText(String(value || ''));

    if (!normalized) {
        return '';
    }

    if (/^[0-9၀-၉]{4}\s*-\s*တက္ကသိုလ်ဝင်\s+စာမေးပွဲအောင်စာရင်း$/.test(normalized)) {
        return 'နိုင်ငံခြား';
    }

    const parentheticalMatch = normalized.match(/\(([^()]+)\)\s*$/);

    if (parentheticalMatch?.[1]) {
        return cleanText(parentheticalMatch[1]);
    }

    return normalized;
}

function getRegionDisplayName(payload, page) {
    const results = getPageResults(payload, page);

    if (results.length === 1) {
        return results[0].name;
    }

    return getNormalizedRegionTitle(page.title) || getPageSlug(page.url);
}

function getRegionDataFile(slug) {
    return path.relative(OUTPUT_DIR, path.join(REGIONS_DIR, `${slug}.json`)).split(path.sep).join('/');
}

function buildLatestPayload(payload) {
    const regions = payload.pages
        .filter((page) => page.resultCount > 0)
        .map((page) => {
            const slug = getPageSlug(page.url);

            return {
                slug,
                name: getRegionDisplayName(payload, page),
                sourcePage: page.url,
                resultCount: page.resultCount,
                dataFile: getRegionDataFile(slug)
            };
        });

    return {
        metadata: payload.metadata,
        regions,
        pages: payload.pages
    };
}

function buildRegionPayload(payload, page) {
    const slug = getPageSlug(page.url);
    const results = getPageResults(payload, page);

    return {
        metadata: {
            ...payload.metadata,
            regionSlug: slug,
            regionName: getRegionDisplayName(payload, page),
            sourcePage: page.url,
            resultCount: results.length
        },
        results
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

async function writeRunSummary(summary) {
    if (!SCRAPE_SUMMARY_FILE) {
        return;
    }

    const payload = {
        year: inferYear(SOURCE_URL),
        sourceUrl: SOURCE_URL,
        generatedAt: new Date().toISOString(),
        outputFile: OUTPUT_FILE,
        latestFile: LATEST_FILE,
        regionsDir: REGIONS_DIR,
        mirrorDir: PDF_MIRROR_DIR,
        ...summary
    };

    await fs.mkdir(path.dirname(SCRAPE_SUMMARY_FILE), { recursive: true });
    await fs.writeFile(SCRAPE_SUMMARY_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}

async function mirrorPdfResult(client, result) {
    if (!result.__mirror) {
        return;
    }

    const tmpPath = `${result.__mirror.outputPath}.tmp`;

    try {
        await fs.mkdir(path.dirname(result.__mirror.outputPath), { recursive: true });
        const response = await client.get(result.__mirror.sourceUrl, {
            headers: {
                Accept: 'application/pdf,*/*;q=0.8',
                Referer: result.__mirror.referer
            },
            responseType: 'stream',
            validateStatus: () => true
        });

        if (response.status !== 200) {
            response.data.destroy();
            throw new Error(`Mirror download failed with status ${response.status} for ${result.__mirror.sourceUrl}`);
        }

        const contentType = getContentType(response);

        if (contentType.includes('xml') || contentType.includes('html') || /^text\//.test(contentType)) {
            response.data.destroy();
            throw new Error(`Mirror download returned ${contentType || 'unexpected content'} for ${result.__mirror.sourceUrl}`);
        }

        await pipeline(response.data, createWriteStream(tmpPath));
        await fs.rename(tmpPath, result.__mirror.outputPath);
    } catch (error) {
        await fs.rm(tmpPath, { force: true });
        throw error;
    }
}

async function mirrorPdfResults(results) {
    if (!MIRROR_PDFS) {
        return 0;
    }

    const client = createHttpClient();
    const mirroredResults = results.filter((result) => result.__mirror);

    if (mirroredResults.length === 0) {
        return 0;
    }

    let nextIndex = 0;
    const workerCount = Math.min(PDF_MIRROR_CONCURRENCY, mirroredResults.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < mirroredResults.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            await mirrorPdfResult(client, mirroredResults[currentIndex]);
        }
    }));

    return mirroredResults.length;
}

async function saveResults(payload) {
    await fs.rm(PDF_MIRROR_DIR, { recursive: true, force: true });
    const mirroredCount = await mirrorPdfResults(payload.results);
    const publicPayload = buildPublicPayload(payload);
    const populatedPages = publicPayload.pages.filter((item) => item.resultCount > 0);

    await writeJson(OUTPUT_FILE, publicPayload);
    await writeJson(LATEST_FILE, buildLatestPayload(publicPayload));
    if (mirroredCount === 0) {
        await ensureTrackedDirectory(PDF_MIRROR_DIR);
    }

    await fs.rm(REGIONS_DIR, { recursive: true, force: true });
    if (populatedPages.length === 0) {
        await ensureTrackedDirectory(REGIONS_DIR);
    }

    for (const page of populatedPages) {
        const regionFile = path.join(REGIONS_DIR, `${getPageSlug(page.url)}.json`);
        await writeJson(regionFile, buildRegionPayload(publicPayload, page));
    }

    return mirroredCount;
}

async function scrapeResults() {
    try {
        if (ALLOW_INSECURE_TLS) {
            console.warn('ALLOW_INSECURE_TLS=true is enabled. Certificate validation is disabled for this scrape.');
        }

        const { results, pages, mirroredPdfLinks, rejectedPdfLinks } = await crawlResults();

        const failedPages = pages.filter((page) => page.error);

        if (failedPages.length > 0 && !ALLOW_PARTIAL_RESULTS) {
            console.error(`Skipped ${failedPages.length} page(s). Existing data was left unchanged.`);
            await writeRunSummary({
                status: 'unchanged',
                reason: 'partial_results_blocked',
                resultCount: results.length,
                pagesVisited: pages.length,
                failedPages: failedPages.length,
                filteredCount: rejectedPdfLinks,
                preparedMirrorCount: mirroredPdfLinks,
                mirroredCount: 0
            });

            if (process.env.SCRAPER_FAIL_ON_ERROR === 'true') {
                process.exitCode = 1;
            }

            return;
        }

        if (results.length === 0 && !WRITE_EMPTY_FEED) {
            console.log(`No PDF result links found at ${SOURCE_URL}. Existing data was left unchanged.`);
            if (VALIDATE_PDF_LINKS && rejectedPdfLinks > 0) {
                console.log(`Filtered out ${rejectedPdfLinks} inaccessible PDF link(s).`);
            }
            await writeRunSummary({
                status: 'unchanged',
                reason: 'no_publishable_results',
                resultCount: 0,
                pagesVisited: pages.length,
                failedPages: failedPages.length,
                filteredCount: rejectedPdfLinks,
                preparedMirrorCount: mirroredPdfLinks,
                mirroredCount: 0
            });
            return;
        }

        const savedPayload = buildPayload(results, pages);
        const mirroredCount = await saveResults(savedPayload);
        await writeRunSummary({
            status: 'saved',
            reason: results.length === 0 ? 'empty_feed' : 'results_saved',
            resultCount: results.length,
            pagesVisited: pages.length,
            failedPages: failedPages.length,
            filteredCount: rejectedPdfLinks,
            preparedMirrorCount: mirroredPdfLinks,
            mirroredCount
        });

        if (results.length === 0) {
            console.log(`Saved empty feed to ${OUTPUT_FILE} and cleared stale result links.`);
        } else {
            console.log(`Saved ${results.length} result link(s) to ${OUTPUT_FILE}.`);
        }

        if (mirroredCount > 0) {
            console.log(`Mirrored ${mirroredCount} PDF file(s) into ${PDF_MIRROR_DIR}.`);
        } else if (mirroredPdfLinks > 0) {
            console.log(`Prepared ${mirroredPdfLinks} mirrored PDF link(s).`);
        }

        if (VALIDATE_PDF_LINKS && rejectedPdfLinks > 0) {
            console.log(`Filtered out ${rejectedPdfLinks} inaccessible PDF link(s).`);
        }
    } catch (error) {
        console.error(`Scrape failed for ${SOURCE_URL}: ${error.message}`);
        await writeRunSummary({
            status: 'failed',
            reason: error.message,
            resultCount: 0,
            pagesVisited: 0,
            failedPages: 0,
            filteredCount: 0,
            preparedMirrorCount: 0,
            mirroredCount: 0
        });

        if (process.env.SCRAPER_FAIL_ON_ERROR === 'true') {
            process.exitCode = 1;
        }
    }
}

if (require.main === module) {
    scrapeResults();
}

module.exports = {
    buildLatestPayload,
    buildPayload,
    buildPublicPayload,
    buildRegionPayload,
    ensureTrackedDirectory,
    getPageSlug,
    parseResultRow,
    parsePage,
    scrapeResults,
    shouldFollowPageLink,
    shouldIncludePdfLink
};
