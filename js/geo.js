/**
 * 坐标范围与转换模块。
 *
 * 本文件只处理纯数学运算，不读取浏览器定位、不修改页面。
 * 这样既能避免界面代码误改坐标算法，也便于在 Node.js 中直接做自动测试。
 */

const PI = 3.1415926535897932384626;
const ECCENTRICITY_SQUARED = 0.00669342162296594323;
const ELLIPSOID_MAJOR_AXIS = 6378245.0;
const SEGMENT_EPSILON = 1e-10;

function freezePolygon(points) {
  return Object.freeze(points.map((point) => Object.freeze(point)));
}

// 主偏移范围多边形，点格式统一为 [经度, 纬度]。
export const REGION_OFFSET_BOUNDARY = freezePolygon([
  [73.5, 39.4],
  [73.5, 49.5], [87.5, 49.5],
  [97.0, 42.8], [108.0, 42.0], [115.0, 45.0], [117.5, 46.8],
  [119.5, 50.5], [121.0, 54.0], [123.5, 54.0],
  [127.5, 53.0], [131.0, 48.5], [135.0, 48.4], [135.0, 42.5],
  [128.0, 38.0], [124.5, 33.0], [124.5, 27.0],
  [124.0, 26.0], [123.5, 25.6],
  [123.0, 23.0], [121.0, 20.0],
  [118.0, 18.0], [117.5, 10.0], [113.0, 3.0], [109.0, 3.0],
  [108.0, 12.0], [108.0, 18.5],
  [104.5, 22.0], [97.5, 21.0],
  [97.3, 28.0], [91.5, 27.8], [80.0, 28.5],
  [78.0, 32.5]
]);

export const REGION_OFFSET_ZONE_A = freezePolygon([
  [113.8, 22.1], [114.4, 22.1], [114.4, 22.6], [113.8, 22.6]
]);

export const REGION_OFFSET_ZONE_B = freezePolygon([
  [113.5, 22.1], [113.6, 22.1], [113.6, 22.25], [113.5, 22.25]
]);

export const REGION_OFFSET_ZONE_C = freezePolygon([
  [119.3, 21.8], [122.5, 21.8], [122.5, 25.4], [119.3, 25.4]
]);

/**
 * 验证经纬度是否既是有限数字，也处于地球坐标的合法范围。
 */
export function isValidCoordinate(lng, lat) {
  return Number.isFinite(lng)
    && Number.isFinite(lat)
    && lng >= -180
    && lng <= 180
    && lat >= -90
    && lat <= 90;
}

/**
 * 单独判断点是否落在多边形的一条边上。
 *
 * 普通射线法会把部分边界点算作区域外，导致用户站在配置边界附近时界面反复切换。
 * 这里先用叉积和点积识别边界，并明确把边界归入区域内。
 */
function isPointOnSegment(lng, lat, start, end) {
  const [startLng, startLat] = start;
  const [endLng, endLat] = end;
  const cross = (lat - startLat) * (endLng - startLng)
    - (lng - startLng) * (endLat - startLat);
  const scale = Math.max(
    1,
    Math.abs(endLng - startLng),
    Math.abs(endLat - startLat)
  );

  if (Math.abs(cross) > SEGMENT_EPSILON * scale) {
    return false;
  }

  const dot = (lng - startLng) * (lng - endLng)
    + (lat - startLat) * (lat - endLat);
  return dot <= SEGMENT_EPSILON;
}

/**
 * 使用射线法判断坐标是否位于多边形内，边界点也按“位于区域内”处理。
 */
export function isPointInPolygon(lng, lat, polygon) {
  if (!isValidCoordinate(lng, lat) || !Array.isArray(polygon) || polygon.length < 3) {
    return false;
  }

  let inside = false;

  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];

    if (isPointOnSegment(lng, lat, previousPoint, currentPoint)) {
      return true;
    }

    const [currentLng, currentLat] = currentPoint;
    const [previousLng, previousLat] = previousPoint;
    const crossesLatitude = (currentLat > lat) !== (previousLat > lat);

    if (!crossesLatitude) {
      continue;
    }

    const intersectionLng = (previousLng - currentLng)
      * (lat - currentLat)
      / (previousLat - currentLat)
      + currentLng;

    if (lng < intersectionLng) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * 一次性计算全部区域状态，保证“是否显示 GCJ-02”和“是否执行转换”使用同一结论。
 */
export function getOffsetRegionState(lng, lat) {
  const isZoneA = isPointInPolygon(lng, lat, REGION_OFFSET_ZONE_A);
  const isZoneB = isPointInPolygon(lng, lat, REGION_OFFSET_ZONE_B);
  const isZoneC = isPointInPolygon(lng, lat, REGION_OFFSET_ZONE_C);
  const isMainRegion = isPointInPolygon(lng, lat, REGION_OFFSET_BOUNDARY);

  return {
    isZoneA,
    isZoneB,
    isZoneC,
    isMainRegion,
    hasOffsetRegion: isMainRegion || isZoneA || isZoneB || isZoneC
  };
}

function transformLatitude(x, y) {
  let result = -100.0
    + 2.0 * x
    + 3.0 * y
    + 0.2 * y * y
    + 0.1 * x * y
    + 0.2 * Math.sqrt(Math.abs(x));
  result += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  result += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  result += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return result;
}

function transformLongitude(x, y) {
  let result = 300.0
    + x
    + 2.0 * y
    + 0.1 * x * x
    + 0.1 * x * y
    + 0.1 * Math.sqrt(Math.abs(x));
  result += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  result += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  result += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return result;
}

/**
 * 将原始 WGS-84 坐标转换为 GCJ-02。
 *
 * 非法输入或不适用偏移的区域会原样返回，避免异常传感器数据把整套界面拖垮。
 */
export function wgs84ToGcj02(lng, lat) {
  if (!isValidCoordinate(lng, lat)) {
    return [lng, lat];
  }

  if (!getOffsetRegionState(lng, lat).hasOffsetRegion) {
    return [lng, lat];
  }

  let latitudeDelta = transformLatitude(lng - 105.0, lat - 35.0);
  let longitudeDelta = transformLongitude(lng - 105.0, lat - 35.0);
  const latitudeRadians = lat / 180.0 * PI;
  let magic = Math.sin(latitudeRadians);
  magic = 1.0 - ECCENTRICITY_SQUARED * magic * magic;
  const squareRootMagic = Math.sqrt(magic);

  latitudeDelta = (latitudeDelta * 180.0)
    / ((ELLIPSOID_MAJOR_AXIS * (1.0 - ECCENTRICITY_SQUARED))
      / (magic * squareRootMagic) * PI);
  longitudeDelta = (longitudeDelta * 180.0)
    / (ELLIPSOID_MAJOR_AXIS / squareRootMagic * Math.cos(latitudeRadians) * PI);

  return [lng + longitudeDelta, lat + latitudeDelta];
}
