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
  // 1. 西北边境（新疆-中亚）
  [73.5, 39.4],
  [74.5, 40.5],
  [78.5, 41.0],
  [80.0, 44.5],
  [82.5, 45.2],
  [85.5, 47.0],
  [87.3, 49.1], // 中俄哈蒙交界阿尔泰

  // 2. 北部边境（中蒙边界）
  [91.0, 45.5],
  [97.0, 42.8],
  [101.0, 42.0],
  [105.0, 41.5],
  [111.0, 42.5],
  [115.5, 45.0],
  [116.8, 46.8],
  [119.9, 46.7],

  // 3. 东北边境（中俄内蒙古-黑龙江）
  [117.4, 49.6], // 满洲里
  [120.0, 52.0],
  [122.5, 53.5], // 漠河北极村
  [126.5, 51.5],
  [130.0, 48.0],
  [135.0, 48.5], // 抚远黑瞎子岛（中国最东端）

  // 4. 中俄东段（乌苏里江向南，精准避开海参崴）
  [134.0, 46.5],
  [131.8, 45.0], // 兴凯湖
  [131.0, 44.0],
  [130.6, 42.4], // 珲春防川三国交界

  // 5. 中朝边界（沿图们江与鸭绿江，精准剔除朝鲜半岛全境）
  [129.5, 42.3],
  [128.1, 41.8], // 长白山天池
  [126.0, 41.0],
  [124.3, 39.8], // 丹东鸭绿江口

  // 6. 黄海-渤海海岸线（辽东半岛与山东半岛）
  [122.0, 39.0], // 大连
  [118.0, 38.5], // 渤海湾
  [120.4, 36.1], // 青岛
  [122.6, 37.4], // 成山头

  // 7. 东南海岸线向南延伸至南海九段线海域
  [121.5, 34.0], // 江苏盐城外海
  [122.0, 31.0], // 上海崇明/长江口
  [122.5, 29.8], // 舟山群岛
  [120.8, 27.5], // 浙江温州外海
  [119.8, 25.5], // 福建平潭外海
  [118.0, 24.2], // 厦门外海
  [117.2, 23.5], // 潮汕外海
  [115.0, 22.4], // 惠州外海
  [113.8, 21.8], // 珠江口外海
  [115.0, 16.0], // 西沙东侧
  [118.0, 10.0], // 南沙东侧
  [113.0, 3.5],  // 曾母暗沙（中国最南端）
  [109.0, 3.5],  // 南沙西侧
  [108.0, 12.0], // 越南外海边界
  [110.0, 17.0], // 海南三亚南侧外海
  [108.0, 18.0], // 海南岛西侧
  [107.5, 20.0], // 北部湾中线
  [108.0, 21.5], // 广西东兴/中越北仑河口

  // 8. 西南陆地边界（中越、中老、中缅）
  [104.5, 22.8], // 云南河口/中越
  [102.2, 22.4], // 中老
  [100.0, 21.5], // 西双版纳
  [97.5, 24.5],  // 瑞丽中缅
  [98.5, 27.0],  // 怒江中缅

  // 9. 西藏边境（中印、中尼、中不）
  [97.3, 28.0],  // 察隅
  [95.0, 28.5],  // 墨脱
  [92.0, 27.8],  // 错那
  [88.5, 27.8],  // 日喀则亚东
  [85.5, 28.2],  // 吉隆/珠峰
  [81.0, 30.2],  // 普兰/阿里
  [79.0, 32.5],  // 班公湖/阿克赛钦
  [78.5, 35.5],  // 和田/昆仑山
  [75.0, 37.0],  // 塔县/红其拉甫
  [73.5, 39.4]   // 闭合至乌恰
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
 * 注意：根据 Apple Maps 与 Google Maps 国际规范，中国香港、澳门、台湾使用原始标准 WGS-84 坐标，
 * 仅中国大陆内地依法适用 GCJ-02 国测局加偏。
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
    hasOffsetRegion: isMainRegion && !isZoneA && !isZoneB && !isZoneC
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
  const cosLat = Math.cos(latitudeRadians);
  const safeCosLat = Math.max(1e-10, Math.abs(cosLat));
  longitudeDelta = (longitudeDelta * 180.0)
    / (ELLIPSOID_MAJOR_AXIS / squareRootMagic * safeCosLat * PI);

  return [lng + longitudeDelta, lat + latitudeDelta];
}
