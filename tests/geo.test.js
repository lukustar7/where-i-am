import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REGION_OFFSET_BOUNDARY,
  REGION_OFFSET_ZONE_A,
  REGION_OFFSET_ZONE_B,
  REGION_OFFSET_ZONE_C,
  getOffsetRegionState,
  isPointInPolygon,
  isValidCoordinate,
  wgs84ToGcj02
} from '../js/geo.js';

test('坐标合法性检查拒绝非数字和越界值', () => {
  assert.equal(isValidCoordinate(116.4, 39.9), true);
  assert.equal(isValidCoordinate(Number.NaN, 39.9), false);
  assert.equal(isValidCoordinate(181, 39.9), false);
  assert.equal(isValidCoordinate(116.4, -91), false);
});

test('多边形判断覆盖内部、外部和边界点', () => {
  assert.equal(isPointInPolygon(116.397428, 39.90923, REGION_OFFSET_BOUNDARY), true);
  assert.equal(isPointInPolygon(-0.1246, 51.5007, REGION_OFFSET_BOUNDARY), false);

  // 边界顶点和边线都必须归入区域，防止定位漂移时反复显示、隐藏 GCJ 卡片。
  assert.equal(isPointInPolygon(73.5, 39.4, REGION_OFFSET_BOUNDARY), true);
  assert.equal(isPointInPolygon(73.5, 44.0, REGION_OFFSET_BOUNDARY), true);
});

test('三个附加区域能够被分别识别', () => {
  const zoneA = getOffsetRegionState(114.173355, 22.292104);
  const zoneB = getOffsetRegionState(113.54089, 22.19762);
  const zoneC = getOffsetRegionState(121.564558, 25.033964);

  assert.equal(zoneA.isZoneA, true);
  assert.equal(zoneB.isZoneB, true);
  assert.equal(zoneC.isZoneC, true);
  assert.equal(isPointInPolygon(114.173355, 22.292104, REGION_OFFSET_ZONE_A), true);
  assert.equal(isPointInPolygon(113.54089, 22.19762, REGION_OFFSET_ZONE_B), true);
  assert.equal(isPointInPolygon(121.564558, 25.033964, REGION_OFFSET_ZONE_C), true);
});

test('适用范围内发生有限偏移，范围外保持原坐标', () => {
  const beijing = [116.397428, 39.90923];
  const converted = wgs84ToGcj02(...beijing);

  assert.notDeepEqual(converted, beijing);
  assert.ok(Math.abs(converted[0] - 116.403671626) < 0.000001);
  assert.ok(Math.abs(converted[1] - 39.910633506) < 0.000001);
  assert.deepEqual(wgs84ToGcj02(-0.1246, 51.5007), [-0.1246, 51.5007]);
});

test('异常坐标不会导致转换函数抛错或产生额外污染', () => {
  assert.deepEqual(wgs84ToGcj02(Number.NaN, 39.9), [Number.NaN, 39.9]);
  assert.deepEqual(wgs84ToGcj02(200, 95), [200, 95]);
});
