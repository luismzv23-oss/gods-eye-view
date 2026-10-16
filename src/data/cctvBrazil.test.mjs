import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBrazilSourcesFromCatalog,
} from '../../server/providers/cctv/sources.js';
import {
  BRAZIL_CETSP_IMAGE_ORIGIN,
  BRAZIL_RECIFE_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';

test('Brazil pack contains only the curated Recife and CETSP snapshots', () => {
  const cameras = loadBrazilSourcesFromCatalog();
  assert.equal(cameras.length, 63);
  assert.equal(
    cameras.filter((camera) => new URL(camera.url).hostname === 'transito-recife.serttel.com.br').length,
    53,
  );
  assert.equal(
    cameras.filter((camera) => new URL(camera.url).hostname === 'cameras.cetsp.com.br').length,
    10,
  );

  for (const camera of cameras) {
    assert.ok(camera.id.startsWith('br-'));
    assert.equal(camera.cityId, 'brazil');
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.sourceKind, 'brazil-public-traffic');
    assert.ok(Number.isFinite(camera.lat) && Number.isFinite(camera.lon));
    assert.ok(camera.lat >= -34 && camera.lat <= 6.5);
    assert.ok(camera.lon >= -74 && camera.lon <= -34);
    assert.equal(camera.snapshotUrl, camera.url);

    const url = new URL(camera.url);
    assert.equal(url.protocol, 'https:');
    if (url.hostname === 'transito-recife.serttel.com.br') {
      assert.equal(url.origin, BRAZIL_RECIFE_IMAGE_ORIGIN);
      assert.equal(url.pathname, '/Index');
      assert.equal(url.searchParams.get('handler'), 'Snapshot');
      assert.match(url.searchParams.get('Codigo') || '', /^\d+$/);
      assert.equal(url.searchParams.size, 2);
    } else {
      assert.equal(url.origin, BRAZIL_CETSP_IMAGE_ORIGIN);
      assert.match(url.pathname, /^\/Cams\/\d+\/1\.jpg$/);
      assert.equal(url.search, '');
    }
  }
});

test('Brazil loader rejects signed, insecure, off-host and off-path feeds', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brazil-cctv-'));
  const configDirectory = path.join(sourceRoot, 'config');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory, 'cctv_sources.brazil.json'),
    JSON.stringify([
      {
        id: 'valid-recife',
        url: 'https://transito-recife.serttel.com.br/Index?handler=Snapshot&Codigo=183',
        lat: -8.0379,
        lon: -34.9323,
      },
      {
        id: 'valid-cetsp',
        url: 'https://cameras.cetsp.com.br/Cams/225/1.jpg',
        lat: -23.5975,
        lon: -46.6508,
      },
      {
        id: 'signed-s3',
        url: 'https://cavsnapshots.s3.amazonaws.com/frame.jpg?X-Amz-Signature=secret',
        lat: -4.957,
        lon: -47.4994,
      },
      {
        id: 'http-recife',
        url: 'http://transito-recife.serttel.com.br/Index?handler=Snapshot&Codigo=184',
        lat: -8.04,
        lon: -34.93,
      },
      {
        id: 'wrong-host',
        url: 'https://evil.example/Index?handler=Snapshot&Codigo=185',
        lat: -8.04,
        lon: -34.93,
      },
      {
        id: 'wrong-path',
        url: 'https://cameras.cetsp.com.br/Cams/225/2.jpg',
        lat: -23.5975,
        lon: -46.6508,
      },
      {
        id: 'outside-brazil',
        url: 'https://cameras.cetsp.com.br/Cams/226/1.jpg',
        lat: 40.7128,
        lon: -74.006,
      },
    ]),
  );

  try {
    const cameras = loadBrazilSourcesFromCatalog({ sourceRoot });
    assert.deepEqual(
      cameras.map((camera) => camera.id),
      ['br-valid-recife', 'br-valid-cetsp'],
    );
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});