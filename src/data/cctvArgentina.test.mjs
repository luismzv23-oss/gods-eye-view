import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadArgentinaSourcesFromCatalog } from '../../server/providers/cctv/sources.js';
import {
  ARGENTINA_HLS_ORIGINS,
  ARGENTINA_IMAGE_ORIGINS,
} from '../../server/providers/cctv/constants.js';

test('Argentina pack contains verified public image and HLS feeds only', () => {
  const cameras = loadArgentinaSourcesFromCatalog();
  assert.equal(cameras.length, 85);
  assert.equal(cameras.filter((camera) => camera.feedType === 'image').length, 81);
  assert.equal(cameras.filter((camera) => camera.feedType === 'hls').length, 4);
  assert.ok(!cameras.some((camera) => ['ar-81380', 'ar-129626'].includes(camera.id)));

  for (const camera of cameras) {
    assert.ok(camera.id.startsWith('ar-'));
    assert.equal(camera.cityId, 'argentina');
    assert.equal(camera.sourceKind, 'argentina-public');
    assert.ok(Number.isFinite(camera.lat) && Number.isFinite(camera.lon));
    const url = new URL(camera.url);
    assert.equal(url.protocol, 'https:');
    if (camera.feedType === 'image') {
      assert.ok(ARGENTINA_IMAGE_ORIGINS.includes(url.origin));
      assert.equal(camera.snapshotUrl, camera.url);
    } else {
      assert.ok(ARGENTINA_HLS_ORIGINS.includes(url.origin));
      assert.equal(url.pathname, '/playlist.m3u8');
      assert.equal(camera.snapshotUrl, '');
    }
  }
});