import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTING_URL = 'https://opencctv.org/cameras/argentina';
const OUTPUT_FILE = path.join(ROOT, 'config/cctv_sources.argentina.json');
const PAGE_DELAY_MS = 250;
const IMAGE_ORIGINS = new Set([
  'https://imgproxy.windy.com',
  'https://images-webcams.windy.com',
  'https://phenocam.nau.edu',
  'https://varitech.ar',
  'https://cams.opensnow.com',
  'https://images.opentopia.com',
]);
const HLS_ORIGINS = new Set([
  'https://cam104.gesell.com.ar',
  'https://cambsasyplaya.gesell.com.ar',
  'https://cammuelle.gesell.com.ar',
  'https://cammuelle2.gesell.com.ar',
]);
const OUT_OF_COUNTRY_IDS = new Set(['81380', '129626']);

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
      // Ignore unrelated or malformed structured-data blocks.
    }
  }
  return null;
}

function cameraFeed(html) {
  const labelIndex = html.indexOf('Open feed URL');
  if (labelIndex < 0) return '';
  const anchorIndex = html.lastIndexOf('<a href=', labelIndex);
  return html.slice(anchorIndex, labelIndex).match(/href="([^"]+)"/)?.[1] || '';
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

function makeSource(html, cameraPath) {
  const id = cameraPath.match(/-(\d+)$/)?.[1] || '';
  if (!id || OUT_OF_COUNTRY_IDS.has(id)) return null;
  const location = cameraLocation(html);
  if (location?.address?.addressCountry !== 'Argentina') return null;

  const lat = Number(location.geo.latitude);
  const lon = Number(location.geo.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -55.2 ||
    lat > -21.5 ||
    lon < -73.8 ||
    lon > -53.4
  ) {
    return null;
  }

  const kind = html.match(
    />\s*Feed Type\s*<\/div>\s*<div[^>]*>([^<]+)/i,
  )?.[1]
    ?.trim()
    .toUpperCase();
  if (kind !== 'IMAGE' && kind !== 'M3U8') return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(cameraFeed(html));
  } catch {
    return null;
  }
  if (
    kind === 'M3U8' &&
    parsedUrl.protocol === 'http:' &&
    parsedUrl.hostname === 'cambsasyplaya.gesell.com.ar'
  ) {
    parsedUrl.protocol = 'https:';
  }
  if (parsedUrl.protocol !== 'https:') return null;
  if (kind === 'IMAGE' && !IMAGE_ORIGINS.has(parsedUrl.origin)) return null;
  if (
    kind === 'M3U8' &&
    (!HLS_ORIGINS.has(parsedUrl.origin) ||
      parsedUrl.pathname !== '/playlist.m3u8' ||
      parsedUrl.search ||
      parsedUrl.hash)
  ) {
    return null;
  }

  const nameMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = nameMatch ? decodeHtml(nameMatch[1]) : `Argentina camera ${id}`;
  const city =
    location.address.addressLocality ||
    location.name?.split(',')[0]?.trim() ||
    'Argentina';
  const feedType = kind === 'M3U8' ? 'hls' : 'image';
  const url = parsedUrl.toString();
  return {
    id,
    name,
    city,
    cityId: 'argentina',
    provider: `OpenCCTV / ${parsedUrl.hostname}`,
    lat,
    lon,
    feedType,
    url,
    snapshotUrl: feedType === 'image' ? url : '',
    sourceKind: 'argentina-public',
    license: `Public feed listed by OpenCCTV; source-host terms apply (${parsedUrl.hostname})`,
  };
}

async function main() {
  const firstPage = await getHtml(LISTING_URL);
  const pageCount = Number(firstPage.match(/Page 1 of (\d+)/i)?.[1] || 1);
  const paths = new Set();
  const collectPaths = (html) => {
    for (const match of html.matchAll(
      /href="(\/cameras\/argentina\/[^\"]+-\d+)"/g,
    )) {
      paths.add(match[1].split('?')[0]);
    }
  };
  collectPaths(firstPage);
  for (let page = 2; page <= pageCount; page += 1) {
    await wait(PAGE_DELAY_MS);
    collectPaths(await getHtml(`${LISTING_URL}?page=${page}`));
  }

  const sources = [];
  for (const [index, cameraPath] of [...paths].entries()) {
    if (index > 0) await wait(PAGE_DELAY_MS);
    const html = await getHtml(`https://opencctv.org${cameraPath}`);
    const source = makeSource(html, cameraPath);
    if (source) sources.push(source);
  }
  if (sources.length < 80) {
    throw new Error(
      `Only found ${sources.length} eligible feeds; refusing to write an incomplete pack`,
    );
  }
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(sources, null, 2)}\n`);
  console.log(
    `Wrote ${sources.length} Argentina sources to ${path.relative(ROOT, OUTPUT_FILE)}`,
  );
}

main().catch((error) => {
  console.error('[Argentina CCTV pack]', error?.message || error);
  process.exitCode = 1;
});