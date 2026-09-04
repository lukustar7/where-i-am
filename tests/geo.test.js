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
  assert.equal(isPointInPolygon(74.0, 39.95, REGION_OFFSET_BOUNDARY), true);
});

test('三个附加区域能够被分别识别，且遵循主流规范不进行 GCJ 加偏', () => {
  const zoneA = getOffsetRegionState(114.173355, 22.292104);
  const zoneB = getOffsetRegionState(113.54089, 22.19762);
  const zoneC = getOffsetRegionState(121.564558, 25.033964);

  assert.equal(zoneA.isZoneA, true);
  assert.equal(zoneB.isZoneB, true);
  assert.equal(zoneC.isZoneC, true);
  assert.equal(isPointInPolygon(114.173355, 22.292104, REGION_OFFSET_ZONE_A), true);
  assert.equal(isPointInPolygon(113.54089, 22.19762, REGION_OFFSET_ZONE_B), true);
  assert.equal(isPointInPolygon(121.564558, 25.033964, REGION_OFFSET_ZONE_C), true);

  // 港澳台地区遵循 Apple Maps / Google Maps 官方标准，使用标准 WGS-84，不进行火星加偏
  assert.equal(zoneA.hasOffsetRegion, false);
  assert.equal(zoneB.hasOffsetRegion, false);
  assert.equal(zoneC.hasOffsetRegion, false);
  assert.deepEqual(wgs84ToGcj02(114.173355, 22.292104), [114.173355, 22.292104]);
});

test('周边关键海外城市精准判定为境外，坚决不进行火星加偏', () => {
  const overseasCities = [
    { name: '首尔', lng: 126.98, lat: 37.57 },
    { name: '平壤', lng: 125.76, lat: 39.03 },
    { name: '仁川', lng: 126.44, lat: 37.46 },
    { name: '釜山', lng: 129.07, lat: 35.18 },
    { name: '乌兰巴托', lng: 106.9, lat: 47.9 },
    { name: '海参崴', lng: 131.88, lat: 43.11 },
    { name: '东京', lng: 139.69, lat: 35.69 },
    { name: '伦敦', lng: -0.12, lat: 51.5 },
    { name: '纽约', lng: -74.0, lat: 40.71 }
  ];

  for (const city of overseasCities) {
    const state = getOffsetRegionState(city.lng, city.lat);
    assert.equal(state.hasOffsetRegion, false, `${city.name} 应被识别为境外`);
    assert.deepEqual(wgs84ToGcj02(city.lng, city.lat), [city.lng, city.lat], `${city.name} 不应被施加 GCJ 加偏`);
  }
});

test('中国大陆主要城市全部精准覆盖并合法偏移', () => {
  const mainlandCities = [
    { name: '北京', lng: 116.4, lat: 39.9 },
    { name: '上海', lng: 121.47, lat: 31.23 },
    { name: '广州', lng: 113.26, lat: 23.13 },
    { name: '三亚', lng: 109.51, lat: 18.25 },
    { name: '乌鲁木齐', lng: 87.62, lat: 43.82 },
    { name: '喀什', lng: 75.99, lat: 39.47 },
    { name: '拉萨', lng: 91.13, lat: 29.65 },
    { name: '哈尔滨', lng: 126.63, lat: 45.75 },
    { name: '丹东', lng: 124.38, lat: 40.13 },
    { name: '抚远', lng: 134.29, lat: 48.36 },
    { name: '漠河', lng: 122.53, lat: 52.97 }
  ];

  for (const city of mainlandCities) {
    const state = getOffsetRegionState(city.lng, city.lat);
    assert.equal(state.hasOffsetRegion, true, `${city.name} 应被识别为境内`);
    const shifted = wgs84ToGcj02(city.lng, city.lat);
    assert.notDeepEqual(shifted, [city.lng, city.lat], `${city.name} 应当发生偏移`);
    // 偏移量应在合理范围 (0.001 ~ 0.01 度之间，约 100m ~ 600m)
    const delta = Math.hypot(shifted[0] - city.lng, shifted[1] - city.lat);
    assert.ok(delta > 0.001 && delta < 0.015, `${city.name} 偏移幅度合理: ${delta}`);
  }
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
  // 极地经纬度安全除零防御
  assert.doesNotThrow(() => wgs84ToGcj02(116.4, 90));
  assert.doesNotThrow(() => wgs84ToGcj02(116.4, -90));
});
