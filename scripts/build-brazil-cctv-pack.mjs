import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = path.join(ROOT, 'config/cctv_sources.brazil.json');
const CITY_LISTINGS = [
  'https://opencctv.org/cameras/brazil/pernambuco/recife',
  'https://opencctv.org/cameras/brazil/sao-paulo/sao-paulo',
];
const PAGE_DELAY_MS = 250;
const EXPECTED_HOSTS = new Set([
  'transito-recife.serttel.com.br',
  'cameras.cetsp.com.br',
]);

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getHtml(url) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function collectJsonObjects(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonObjects(item, result);
  } else if (value && typeof value === 'object') {
    result.push(value);
    for (const child of Object.values(value)) collectJsonObjects(child, result);
  }
  return result;
}

function cameraLocation(html) {
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(match[1]);
      const location = collectJsonObjects(parsed).find(
        (item) =>
          item.contentLocation?.geo &&
          item.contentLocation?.address?.addressCountry,
      )?.contentLocation;
      if (location) return location;
    } catch {
      // Ignore unrelated structured-data blocks.
    }
  }
  return null;
}

function cameraFeed(html) {
  const labelIndex = html.indexOf('Open feed URL');
  if (labelIndex < 0) return '';
  const anchorIndex = html.lastIndexOf('<a href=', labelIndex);
  return (
    html
      .slice(anchorIndex, labelIndex)
      .match(/href="([^"]+)"/)?.[1]
      .replace(/&amp;/g, '&') || ''
  );
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function acceptedFeed(url) {
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'transito-recife.serttel.com.br') {
    const params = [...url.searchParams.entries()];
    return (
      url.pathname === '/Index' &&
      params.length === 2 &&
      url.searchParams.get('handler') === 'Snapshot' &&
      /^\d+$/.test(url.searchParams.get('Codigo') || '')
    );
  }
  return (
    url.hostname === 'cameras.cetsp.com.br' &&
    /^\/Cams\/\d+\/1\.jpg$/.test(url.pathname) &&
    !url.search &&
    !url.hash
  );
}

function makeSource(html, cameraPath) {
  const id = cameraPath.match(/-(\d+)$/)?.[1] || '';
  if (!id) return null;
  const location = cameraLocation(html);
  if (location?.address?.addressCountry !== 'Brazil') return null;

  const lat = Number(location.geo.latitude);
  const lon = Number(location.geo.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -34 ||
    lat > 6.5 ||
    lon < -74 ||
    lon > -34
  ) {
    return null;
  }

  const feedType = html.match(
    />\s*Feed Type\s*<\/div>\s*<div[^>]*>([^<]+)/i,
  )?.[1]
    ?.trim()
    .toUpperCase();
  if (feedType !== 'IMAGE') return null;

  let url;
  try {
    url = new URL(cameraFeed(html));
  } catch {
    return null;
  }
  if (!EXPECTED_HOSTS.has(url.hostname) || !acceptedFeed(url)) return null;

  const nameMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const city = String(
    location.address.addressLocality || location.name?.split(',')[0] || '',
  ).trim();
  const name = nameMatch ? decodeHtml(nameMatch[1]) : `Brazil camera ${id}`;
  const provider =
    url.hostname === 'transito-recife.serttel.com.br'
      ? 'Recife traffic / SERTTEL'
      : 'CETSP';
  const sourceHost = url.hostname;
  const sourceUrl = url.toString();
  return {
    id,
    name,
    city: city || 'Brazil',
    cityId: 'brazil',
    provider,
    lat,
    lon,
    feedType: 'image',
    url: sourceUrl,
    snapshotUrl: sourceUrl,
    sourceKind: 'brazil-public-traffic',
    license: `Public feed listed by OpenCCTV; source-host terms apply (${sourceHost})`,
  };
}

async function main() {
  const paths = new Set();
  for (const listingUrl of CITY_LISTINGS) {
    const firstPage = await getHtml(listingUrl);
    const pageCount = Number(firstPage.match(/Page 1 of (\d+)/i)?.[1] || 1);
    for (let page = 1; page <= pageCount; page += 1) {
      if (page > 1) await wait(PAGE_DELAY_MS);
      const html =
        page === 1
          ? firstPage
          : await getHtml(`${listingUrl}?page=${page}`);
      for (const match of html.matchAll(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      )) {
        try {
          const data = JSON.parse(match[1]);
          if (data?.['@type'] !== 'ItemList' || data.url !== listingUrl)
            continue;
          for (const entry of data.itemListElement || []) {
            const itemUrl = entry.item?.url || entry.url;
            if (itemUrl) paths.add(new URL(itemUrl).pathname);
          }
        } catch {
          // Ignore other structured-data blocks.
        }
      }
    }
  }

  const sources = [];
  for (const [index, cameraPath] of [...paths].entries()) {
    if (index > 0) await wait(PAGE_DELAY_MS);
    const html = await getHtml(`https://opencctv.org${cameraPath}`);
    const source = makeSource(html, cameraPath);
    if (source) sources.push(source);
  }
  const unique = Array.from(new Map(sources.map((row) => [row.id, row])).values());
  const counts = unique.reduce(
    (result, row) => {
      const host = new URL(row.url).hostname;
      result[host] = (result[host] || 0) + 1;
      return result;
    },
    {},
  );
  if (
    unique.length < 60 ||
    counts['transito-recife.serttel.com.br'] < 50 ||
    counts['cameras.cetsp.com.br'] !== 10
  ) {
    throw new Error(
      `Unexpected candidate count ${unique.length}: ${JSON.stringify(counts)}`,
    );
  }

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(unique, null, 2)}\n`);
  console.log(
    `Wrote ${unique.length} sources (${JSON.stringify(counts)}) to ${path.relative(ROOT, OUTPUT_FILE)}`,
  );
}

main().catch((error) => {
  console.error('[Brazil CCTV pack]', error?.message || error);
  process.exitCode = 1;
});