import {
  REGION_OFFSET_BOUNDARY,
  REGION_OFFSET_ZONE_A,
  REGION_OFFSET_ZONE_B,
  REGION_OFFSET_ZONE_C,
  getOffsetRegionState,
  isPointInPolygon,
  isValidCoordinate,
  wgs84ToGcj02
} from './geo.js';
import {
  HEADING_MODES,
  HeadingModeResolver,
  isReliableCourseHeading,
  normalizeHeading,
  smoothHeading
} from './heading.js';

/**
 * 浏览器应用入口。
 *
 * 本文件只负责三件事：读取设备能力、维护运行状态、把状态渲染到现有 DOM。
 * 坐标与方向数学运算已拆到纯模块，避免权限回调、页面更新和核心算法互相缠绕。
 */

const APP_CONFIG = Object.freeze({
  headingFilterAlpha: 0.15,
  orientationFallbackDelayMs: 2200,
  phoneHeadingStaleMs: 6000,
  gpsFixStaleMs: 15000,
  locationTimeoutMs: 15000
});

const COPY_ICON_PATH = 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z';
const COPY_SUCCESS_PATH = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
const COPY_FAILURE_PATH = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required interface element is missing: #${id}`);
  }
  return element;
}

const elements = Object.freeze({
  activateBtn: requireElement('activateBtn'),
  activationContainer: requireElement('activationContainer'),
  alertPanel: requireElement('alertPanel'),
  gpsStatus: requireElement('gpsStatus'),
  compassSource: requireElement('compassSource'),
  lockStatus: requireElement('lockStatus'),
  compassDial: requireElement('compassDial'),
  courseMarker: requireElement('courseMarker'),
  dialTicks: requireElement('dialTicks'),
  dialLabels: requireElement('dialLabels'),
  primaryHeadingLabel: requireElement('primaryHeadingLabel'),
  secondaryHeadingLabel: requireElement('secondaryHeadingLabel'),
  phoneHeadingValue: requireElement('phoneHeadingValue'),
  courseHeadingValue: requireElement('courseHeadingValue'),
  compassWarning: requireElement('compassWarning'),
  gpsAcc: requireElement('gpsAcc'),
  gpsAlt: requireElement('gpsAlt'),
  gpsSpd: requireElement('gpsSpd'),
  gpsMode: requireElement('gpsMode'),
  modeInfoBtn: requireElement('modeInfoBtn'),
  modePopover: requireElement('modePopover'),
  modePopoverClose: requireElement('modePopoverClose'),
  wgsLat: requireElement('wgsLat'),
  wgsLng: requireElement('wgsLng'),
  gcjCard: requireElement('gcjCard'),
  gcjLat: requireElement('gcjLat'),
  gcjLng: requireElement('gcjLng'),
  copyWgsBtn: requireElement('copyWgsBtn'),
  copyGcjBtn: requireElement('copyGcjBtn'),
  amapWgs: requireElement('amapWgs'),
  gmapWgs: requireElement('gmapWgs'),
  amapGcj: requireElement('amapGcj'),
  gmapGcj: requireElement('gmapGcj'),
  updateTime: requireElement('updateTime')
});

const headingModeResolver = new HeadingModeResolver();
const warningMessages = new Map();
const orientationListeners = new Map();
const copyFeedbackTimers = new Map();
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const state = {
  startInProgress: false,
  orientationStatus: 'idle',
  locationStatus: 'idle',
  locationWatchId: null,
  wakeLock: null,
  orientationFallbackTimer: null,
  currentHeadingSource: 'WAITING',
  lastPhoneHeadingUpdateAt: 0,
  compassAnimationFrame: null,
  smoothedPhoneHeading: null,
  phoneHeading: null,
  courseHeading: null,
  hasLocationFix: false,
  lastFixAt: null,
  currentData: {
    wgsLat: null,
    wgsLng: null,
    gcjLat: null,
    gcjLng: null,
    altitude: null,
    accuracy: null,
    speed: null,
    heading: null,
    hasOffsetRegion: false
  }
};

function setStatusBadge(element, text, tone = 'warning') {
  element.textContent = text;
  element.className = 'status-badge';
  if (tone !== 'warning') {
    element.classList.add(tone);
  }
}

function renderWarnings() {
  if (warningMessages.size === 0) {
    elements.alertPanel.textContent = '';
    elements.alertPanel.hidden = true;
    return;
  }

  elements.alertPanel.textContent = [...warningMessages.values()].join('\n');
  elements.alertPanel.hidden = false;
}

function setWarning(key, message) {
  warningMessages.set(key, message);
  renderWarnings();
}

function clearWarning(key) {
  if (warningMessages.delete(key)) {
    renderWarnings();
  }
}

function createSvgElement(tagName, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function getDialPoint(center, radius, degree) {
  const radians = degree * Math.PI / 180;
  return {
    x: center + Math.sin(radians) * radius,
    y: center - Math.cos(radians) * radius
  };
}

/**
 * 表盘只在启动时创建一次。后续方向变化仅旋转 SVG 分组，避免每秒重建 180 条刻度。
 */
function buildCompassDial() {
  if (elements.dialTicks.childElementCount > 0) {
    return;
  }

  const center = 160;
  const outerRadius = 132;
  const ticks = document.createDocumentFragment();
  const labels = document.createDocumentFragment();

  for (let degree = 0; degree < 360; degree += 2) {
    const isMajor = degree % 30 === 0;
    const isMedium = !isMajor && degree % 10 === 0;
    const innerRadius = outerRadius - (isMajor ? 22 : (isMedium ? 16 : 10));
    const outerPoint = getDialPoint(center, outerRadius, degree);
    const innerPoint = getDialPoint(center, innerRadius, degree);

    ticks.appendChild(createSvgElement('line', {
      x1: outerPoint.x.toFixed(2),
      y1: outerPoint.y.toFixed(2),
      x2: innerPoint.x.toFixed(2),
      y2: innerPoint.y.toFixed(2),
      class: `dial-tick${isMajor ? ' major' : ''}${isMedium ? ' medium' : ''}`,
      'stroke-width': isMajor ? '2.2' : (isMedium ? '1.6' : '1.1')
    }));
  }

  for (let degree = 0; degree < 360; degree += 30) {
    const point = getDialPoint(center, 150, degree);
    const label = createSvgElement('text', {
      x: point.x.toFixed(2),
      y: point.y.toFixed(2),
      class: 'degree-label'
    });
    label.textContent = degree.toString();
    labels.appendChild(label);
  }

  ['N', 'E', 'S', 'W'].forEach((labelText, index) => {
    const point = getDialPoint(center, 78, index * 90);
    const label = createSvgElement('text', {
      x: point.x.toFixed(2),
      y: point.y.toFixed(2),
      class: 'cardinal-label'
    });
    label.textContent = labelText;
    labels.appendChild(label);
  });

  elements.dialTicks.appendChild(ticks);
  elements.dialLabels.appendChild(labels);
}

function getDirectionText(heading) {
  const normalized = normalizeHeading(heading);
  if (normalized === null) {
    return '';
  }

  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(normalized / 45) % directions.length];
}

function formatHeadingValue(heading) {
  const normalized = normalizeHeading(heading);
  if (normalized === null) {
    return 'N/A';
  }

  const rounded = Math.round(normalized) % 360;
  return `${rounded.toString().padStart(3, '0')}° ${getDirectionText(normalized)}`;
}

function updateHeadingSource(source) {
  state.currentHeadingSource = source;

  if (source === 'MAG') {
    setStatusBadge(elements.compassSource, 'MAG', 'active');
    elements.compassWarning.hidden = true;
    return;
  }

  if (source === 'RELATIVE') {
    setStatusBadge(elements.compassSource, 'RELATIVE');
    elements.compassWarning.hidden = false;
    return;
  }

  setStatusBadge(elements.compassSource, 'COMPASS WAIT', 'neutral');
  elements.compassWarning.hidden = true;
}

function renderCompassHeading() {
  const mode = headingModeResolver.resolve({
    phoneHeading: state.phoneHeading,
    courseHeading: state.courseHeading,
    speed: state.currentData.speed
  });
  const primaryHeading = mode === HEADING_MODES.COURSE
    ? state.courseHeading
    : state.phoneHeading;
  const displayHeading = normalizeHeading(primaryHeading ?? state.courseHeading) ?? 0;

  // 使用 SVG 原生 transform，规避部分移动浏览器不稳定刷新 SVG CSS transform 的问题。
  elements.compassDial.setAttribute('transform', `rotate(${-displayHeading} 160 160)`);

  if (state.courseHeading === null || mode === HEADING_MODES.COURSE) {
    elements.courseMarker.classList.add('hidden');
  } else {
    const relativeCourse = normalizeHeading(state.courseHeading - displayHeading) ?? 0;
    elements.courseMarker.setAttribute('transform', `rotate(${relativeCourse} 160 160)`);
    elements.courseMarker.classList.remove('hidden');
  }

  if (mode === HEADING_MODES.COURSE) {
    elements.primaryHeadingLabel.textContent = 'COURSE';
    elements.secondaryHeadingLabel.textContent = 'PHONE';
    elements.phoneHeadingValue.textContent = formatHeadingValue(state.courseHeading);
    elements.courseHeadingValue.textContent = state.phoneHeading === null ? 'N/A' : 'LINKED';
  } else {
    elements.primaryHeadingLabel.textContent = 'PHONE';
    elements.secondaryHeadingLabel.textContent = 'COURSE';
    elements.phoneHeadingValue.textContent = formatHeadingValue(state.phoneHeading);
    elements.courseHeadingValue.textContent = formatHeadingValue(state.courseHeading);
  }

  elements.gpsMode.textContent = mode;
  elements.gpsMode.classList.toggle('active', mode === HEADING_MODES.DUAL || mode === HEADING_MODES.COURSE);
}

/**
 * 方向事件在部分设备上可超过屏幕刷新率。把同一帧内的多次事件合并，只渲染最新状态，
 * 可显著减少重复 DOM 写入，同时不会牺牲肉眼可见的指南针流畅度。
 */
function scheduleCompassRender() {
  if (state.compassAnimationFrame !== null) {
    return;
  }

  state.compassAnimationFrame = window.requestAnimationFrame(() => {
    state.compassAnimationFrame = null;
    renderCompassHeading();
  });
}

function updatePhoneHeading(rawHeading, source) {
  const normalized = normalizeHeading(rawHeading);
  if (normalized === null) {
    return;
  }

  // 绝对磁北与相对方向的零点不同，来源切换时必须丢弃旧平滑值，防止表盘慢慢绕错方向。
  if (state.currentHeadingSource !== source) {
    state.smoothedPhoneHeading = null;
  }

  state.smoothedPhoneHeading = smoothHeading(
    state.smoothedPhoneHeading,
    normalized,
    APP_CONFIG.headingFilterAlpha
  );
  state.phoneHeading = state.smoothedPhoneHeading;
  state.lastPhoneHeadingUpdateAt = Date.now();
  updateHeadingSource(source);
  clearWarning('compassSignal');
  scheduleCompassRender();
}

function setMapLink(link, url) {
  if (url === null) {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
    link.tabIndex = -1;
    return;
  }

  link.href = url.toString();
  link.setAttribute('aria-disabled', 'false');
  link.tabIndex = 0;
}

function createGoogleMapUrl(lat, lng) {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', `${lat},${lng}`);
  return url;
}

function createAppleMapUrl(lat, lng) {
  const url = new URL('https://maps.apple.com/');
  const coordinate = `${lat},${lng}`;
  url.searchParams.set('ll', coordinate);
  url.searchParams.set('q', coordinate);
  return url;
}

function formatCoordinate(value, positiveDirection, negativeDirection) {
  const direction = value >= 0 ? positiveDirection : negativeDirection;
  return `${Math.abs(value).toFixed(6)}° ${direction}`;
}

function renderPosition() {
  const data = state.currentData;
  elements.wgsLat.textContent = formatCoordinate(data.wgsLat, 'N', 'S');
  elements.wgsLng.textContent = formatCoordinate(data.wgsLng, 'E', 'W');
  elements.gpsAlt.textContent = data.altitude === null ? 'N/A' : `${data.altitude.toFixed(1)} m`;
  elements.gpsAcc.textContent = data.accuracy === null ? 'N/A' : `±${data.accuracy.toFixed(1)} m`;
  elements.gpsSpd.textContent = data.speed === null ? 'N/A' : `${data.speed.toFixed(1)} km/h`;
  elements.copyWgsBtn.disabled = false;

  setMapLink(elements.gmapWgs, createGoogleMapUrl(data.wgsLat, data.wgsLng));
  setMapLink(elements.amapWgs, createAppleMapUrl(data.wgsLat, data.wgsLng));

  if (data.hasOffsetRegion) {
    elements.gcjCard.hidden = false;
    elements.gcjLat.textContent = formatCoordinate(data.gcjLat, 'N', 'S');
    elements.gcjLng.textContent = formatCoordinate(data.gcjLng, 'E', 'W');
    elements.copyGcjBtn.disabled = false;
    elements.amapGcj.classList.add('visible');
    elements.gmapGcj.classList.add('visible');
    setMapLink(elements.amapGcj, createAppleMapUrl(data.gcjLat, data.gcjLng));
    setMapLink(elements.gmapGcj, createGoogleMapUrl(data.gcjLat, data.gcjLng));
  } else {
    elements.gcjCard.hidden = true;
    elements.copyGcjBtn.disabled = true;
    elements.amapGcj.classList.remove('visible');
    elements.gmapGcj.classList.remove('visible');
    setMapLink(elements.amapGcj, null);
    setMapLink(elements.gmapGcj, null);
  }

  state.courseHeading = isReliableCourseHeading(data.heading, data.speed)
    ? normalizeHeading(data.heading)
    : null;
  scheduleCompassRender();
  updateFreshnessIndicators();
}

function handleLocationSuccess(position) {
  const { coords } = position;
  if (!isValidCoordinate(coords.longitude, coords.latitude)) {
    setWarning('location', 'LOCATION ERROR: THE DEVICE RETURNED AN INVALID COORDINATE.');
    return;
  }

  const region = getOffsetRegionState(coords.longitude, coords.latitude);
  const [gcjLng, gcjLat] = wgs84ToGcj02(coords.longitude, coords.latitude);

  state.currentData = {
    wgsLat: coords.latitude,
    wgsLng: coords.longitude,
    gcjLat,
    gcjLng,
    altitude: Number.isFinite(coords.altitude) ? coords.altitude : null,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    speed: Number.isFinite(coords.speed) ? Math.max(0, coords.speed * 3.6) : null,
    heading: Number.isFinite(coords.heading) ? normalizeHeading(coords.heading) : null,
    hasOffsetRegion: region.hasOffsetRegion
  };
  state.hasLocationFix = true;
  state.lastFixAt = Date.now();
  state.locationStatus = 'watching';
  clearWarning('location');
  setStatusBadge(elements.gpsStatus, 'GPS ON', 'active');
  renderPosition();
  refreshActivationControl();
}

function clearLocationWatch() {
  if (state.locationWatchId === null || !('geolocation' in navigator)) {
    return;
  }

  navigator.geolocation.clearWatch(state.locationWatchId);
  state.locationWatchId = null;
}

function handleLocationError(error) {
  switch (error.code) {
    case 1:
      // 权限拒绝后旧 watch ID 已经失效，必须清空；否则重试按钮会被“已有监听”判断直接拦住。
      clearLocationWatch();
      state.locationStatus = 'denied';
      setStatusBadge(elements.gpsStatus, 'GPS DENIED', 'error');
      setWarning('location', 'LOCATION ERROR: PERMISSION DENIED. ENABLE LOCATION ACCESS IN SYSTEM SETTINGS, THEN RETRY.');
      break;
    case 2:
      setStatusBadge(elements.gpsStatus, 'GPS WEAK');
      setWarning('location', 'LOCATION ERROR: POSITION UNAVAILABLE. GPS SIGNAL IS WEAK OR UNSTABLE.');
      break;
    case 3:
      setStatusBadge(elements.gpsStatus, 'GPS SEARCH');
      setWarning('location', 'LOCATION TIMEOUT: STILL SEARCHING FOR A GPS FIX.');
      break;
    default:
      state.locationStatus = 'error';
      setStatusBadge(elements.gpsStatus, 'GPS ERROR', 'error');
      setWarning('location', 'LOCATION ERROR: AN UNKNOWN DEVICE ERROR OCCURRED.');
  }

  refreshActivationControl();
}

function startLocationWatch() {
  if (state.locationWatchId !== null) {
    return true;
  }

  if (!('geolocation' in navigator)) {
    state.locationStatus = 'unavailable';
    setStatusBadge(elements.gpsStatus, 'NO GPS', 'error');
    setWarning('location', 'GEOLOCATION IS NOT SUPPORTED BY THIS DEVICE OR BROWSER.');
    return false;
  }

  try {
    state.locationWatchId = navigator.geolocation.watchPosition(
      handleLocationSuccess,
      handleLocationError,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: APP_CONFIG.locationTimeoutMs
      }
    );
    state.locationStatus = 'watching';
    setStatusBadge(elements.gpsStatus, 'GPS SEARCH');
    return true;
  } catch (error) {
    state.locationStatus = 'error';
    state.locationWatchId = null;
    setStatusBadge(elements.gpsStatus, 'GPS ERROR', 'error');
    setWarning('location', `LOCATION STARTUP ERROR: ${error.message}`);
    return false;
  }
}

function attachOrientationListener(eventName, handler) {
  if (orientationListeners.has(eventName)) {
    return;
  }

  window.addEventListener(eventName, handler, true);
  orientationListeners.set(eventName, handler);
}

function scheduleOrientationFallback() {
  if (state.orientationFallbackTimer !== null) {
    window.clearTimeout(state.orientationFallbackTimer);
  }

  state.orientationFallbackTimer = window.setTimeout(() => {
    const hasRecentHeading = Date.now() - state.lastPhoneHeadingUpdateAt
      < APP_CONFIG.orientationFallbackDelayMs;

    if (!hasRecentHeading && !orientationListeners.has('deviceorientation')) {
      attachOrientationListener('deviceorientation', handleOrientationFallback);
      setWarning('compassSignal', 'ABSOLUTE COMPASS DATA IS UNAVAILABLE. WAITING FOR RELATIVE ORIENTATION DATA.');
    }
  }, APP_CONFIG.orientationFallbackDelayMs);
}

async function startOrientationSensors() {
  if (state.orientationStatus === 'active') {
    return true;
  }

  if (!('DeviceOrientationEvent' in window)) {
    state.orientationStatus = 'unavailable';
    setStatusBadge(elements.compassSource, 'NO COMPASS', 'error');
    setWarning('compassPermission', 'ORIENTATION SENSORS ARE NOT SUPPORTED BY THIS DEVICE OR BROWSER.');
    return false;
  }

  state.orientationStatus = 'starting';
  const OrientationEvent = window.DeviceOrientationEvent;

  if (typeof OrientationEvent.requestPermission === 'function') {
    try {
      // iOS 要求权限请求直接发生在点击回调链内，因此本函数必须是 startSensors 的首个异步动作。
      const permission = await OrientationEvent.requestPermission();
      if (permission !== 'granted') {
        state.orientationStatus = 'denied';
        setStatusBadge(elements.compassSource, 'COMPASS DENIED', 'error');
        setWarning('compassPermission', 'COMPASS PERMISSION DENIED. ENABLE MOTION AND ORIENTATION ACCESS, THEN RETRY.');
        return false;
      }

      attachOrientationListener('deviceorientation', handleOrientation);
      state.orientationStatus = 'active';
      clearWarning('compassPermission');
      scheduleOrientationFallback();
      return true;
    } catch (error) {
      state.orientationStatus = 'error';
      setStatusBadge(elements.compassSource, 'COMPASS ERROR', 'error');
      setWarning('compassPermission', `COMPASS STARTUP ERROR: ${error.message}`);
      return false;
    }
  }

  if ('ondeviceorientationabsolute' in window) {
    attachOrientationListener('deviceorientationabsolute', handleOrientationAbsolute);
  } else {
    attachOrientationListener('deviceorientation', handleOrientationFallback);
  }

  state.orientationStatus = 'active';
  clearWarning('compassPermission');
  scheduleOrientationFallback();
  return true;
}

function handleOrientation(event) {
  if (Number.isFinite(event.webkitCompassHeading)) {
    updatePhoneHeading(event.webkitCompassHeading, 'MAG');
  } else if (event.absolute === true && Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'MAG');
  } else if (Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'RELATIVE');
  }
}

function handleOrientationAbsolute(event) {
  if (Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'MAG');
  }
}

function handleOrientationFallback(event) {
  if (Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'RELATIVE');
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    setStatusBadge(elements.lockStatus, 'NO WAKE', 'neutral');
    return false;
  }

  if (document.visibilityState !== 'visible') {
    return false;
  }

  if (state.wakeLock && !state.wakeLock.released) {
    return true;
  }

  try {
    const lock = await navigator.wakeLock.request('screen');
    state.wakeLock = lock;
    setStatusBadge(elements.lockStatus, 'WAKE ON', 'active');

    lock.addEventListener('release', () => {
      if (state.wakeLock === lock) {
        state.wakeLock = null;
      }
      setStatusBadge(elements.lockStatus, 'WAKE OFF');
    }, { once: true });
    return true;
  } catch (error) {
    state.wakeLock = null;
    setStatusBadge(elements.lockStatus, 'WAKE OFF');
    console.warn('Wake Lock request failed:', error);
    return false;
  }
}

function refreshActivationControl() {
  elements.activationContainer.hidden = false;

  if (state.startInProgress) {
    elements.activateBtn.disabled = true;
    elements.activateBtn.textContent = 'Starting...';
    return;
  }

  const needsLocation = ['idle', 'denied', 'error'].includes(state.locationStatus);
  const needsCompass = ['idle', 'denied', 'error'].includes(state.orientationStatus);

  if (!needsLocation && !needsCompass) {
    elements.activationContainer.hidden = true;
    return;
  }

  elements.activateBtn.disabled = false;
  if (needsLocation && !needsCompass) {
    elements.activateBtn.textContent = state.locationStatus === 'idle' ? 'Start GPS' : 'Retry GPS';
  } else if (!needsLocation && needsCompass) {
    elements.activateBtn.textContent = state.orientationStatus === 'idle' ? 'Start Compass' : 'Retry Compass';
  } else {
    const hasFailure = state.locationStatus !== 'idle' || state.orientationStatus !== 'idle';
    elements.activateBtn.textContent = hasFailure ? 'Retry Sensors' : 'Start Sensors';
  }
}

async function startSensors() {
  if (state.startInProgress) {
    return;
  }

  state.startInProgress = true;
  refreshActivationControl();

  try {
    // iOS 的方向权限必须最先请求；定位和常亮即使失败也互不阻塞。
    await startOrientationSensors();
    startLocationWatch();
    await requestWakeLock();
  } finally {
    state.startInProgress = false;
    refreshActivationControl();
  }
}

function updateFreshnessIndicators() {
  const now = Date.now();

  if (state.lastFixAt !== null) {
    const ageMs = Math.max(0, now - state.lastFixAt);
    const ageSeconds = Math.floor(ageMs / 1000);
    const suffix = ageMs >= APP_CONFIG.gpsFixStaleMs ? ` | ${ageSeconds}s OLD` : '';
    elements.updateTime.textContent = `LAST FIX: ${timeFormatter.format(state.lastFixAt)}${suffix}`;

    if (state.locationStatus === 'watching') {
      if (ageMs >= APP_CONFIG.gpsFixStaleMs) {
        setStatusBadge(elements.gpsStatus, 'GPS STALE');
      } else {
        setStatusBadge(elements.gpsStatus, 'GPS ON', 'active');
      }
    }
  }

  if (state.phoneHeading !== null
    && now - state.lastPhoneHeadingUpdateAt >= APP_CONFIG.phoneHeadingStaleMs) {
    // 传感器长时间没有新事件时不继续展示“实时”旧方向，GPS 仍可单独接管 COURSE。
    state.phoneHeading = null;
    state.smoothedPhoneHeading = null;
    updateHeadingSource('WAITING');
    renderCompassHeading();
    scheduleOrientationFallback();
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }

  // 老旧浏览器降级路径；临时输入框不显示，也不会污染页面布局。
  const input = document.createElement('textarea');
  input.className = 'clipboard-fallback';
  input.value = text;
  input.setAttribute('readonly', '');
  document.body.appendChild(input);
  input.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Legacy clipboard command was rejected.');
    }
  } finally {
    input.remove();
  }
}

function flashCopyResult(button, succeeded) {
  const path = button.querySelector('path');
  if (!path) {
    return;
  }

  const previousTimer = copyFeedbackTimers.get(button);
  if (previousTimer) {
    window.clearTimeout(previousTimer);
  }

  button.classList.remove('success-flash', 'fail-flash');
  button.classList.add(succeeded ? 'success-flash' : 'fail-flash');
  path.setAttribute('d', succeeded ? COPY_SUCCESS_PATH : COPY_FAILURE_PATH);

  const timer = window.setTimeout(() => {
    path.setAttribute('d', COPY_ICON_PATH);
    button.classList.remove('success-flash', 'fail-flash');
    copyFeedbackTimers.delete(button);
  }, 1500);
  copyFeedbackTimers.set(button, timer);
}

async function copyCoordinates(kind) {
  if (!state.hasLocationFix) {
    return;
  }

  const isGcj = kind === 'gcj';
  if (isGcj && !state.currentData.hasOffsetRegion) {
    return;
  }

  const latitude = isGcj ? state.currentData.gcjLat : state.currentData.wgsLat;
  const longitude = isGcj ? state.currentData.gcjLng : state.currentData.wgsLng;
  const button = isGcj ? elements.copyGcjBtn : elements.copyWgsBtn;

  try {
    await writeClipboard(`${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
    flashCopyResult(button, true);
  } catch (error) {
    console.warn('Clipboard write failed:', error);
    flashCopyResult(button, false);
  }
}

function setModePopoverVisible(visible, restoreFocus = false) {
  elements.modePopover.hidden = !visible;
  elements.modeInfoBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');

  if (visible) {
    elements.modePopoverClose.focus({ preventScroll: true });
  } else if (restoreFocus) {
    elements.modeInfoBtn.focus({ preventScroll: true });
  }
}

/**
 * 保留原项目的控制台自测入口，便于无测试工具的手机浏览器现场核对区域配置。
 * 自动测试使用同一批核心函数，但不会弹窗。
 */
function runSystemSelfTest() {
  const testCases = [
    { name: 'Reference point A', lng: 116.397428, lat: 39.90923, expectRegion: true, zone: null },
    { name: 'Reference point B', lng: 121.564558, lat: 25.033964, expectRegion: true, zone: 'C' },
    { name: 'Reference point C', lng: 114.173355, lat: 22.292104, expectRegion: true, zone: 'A' },
    { name: 'Reference point D', lng: 113.54089, lat: 22.19762, expectRegion: true, zone: 'B' },
    { name: 'Reference point E', lng: -0.1246, lat: 51.5007, expectRegion: false, zone: null },
    { name: 'Reference point F', lng: -74.0445, lat: 40.6892, expectRegion: false, zone: null }
  ];

  const zonePolygons = {
    A: REGION_OFFSET_ZONE_A,
    B: REGION_OFFSET_ZONE_B,
    C: REGION_OFFSET_ZONE_C
  };
  const lines = ['SYSTEM TEST RESULTS:'];
  let allPassed = true;

  for (const testCase of testCases) {
    const region = getOffsetRegionState(testCase.lng, testCase.lat);
    const expectedZoneMatched = testCase.zone === null
      || isPointInPolygon(testCase.lng, testCase.lat, zonePolygons[testCase.zone]);
    const [convertedLng, convertedLat] = wgs84ToGcj02(testCase.lng, testCase.lat);
    const changed = convertedLng !== testCase.lng || convertedLat !== testCase.lat;
    const passed = region.hasOffsetRegion === testCase.expectRegion
      && expectedZoneMatched
      && changed === testCase.expectRegion;

    allPassed = allPassed && passed;
    lines.push(`${passed ? 'PASS' : 'FAIL'}: ${testCase.name}`);
  }

  // 同时确认主范围常量仍可被模块正常读取，防止构建时意外裁掉配置。
  lines.push(`BOUNDARY POINTS: ${REGION_OFFSET_BOUNDARY.length}`);
  lines.push(allPassed ? 'STATUS: ALL TESTS PASSED.' : 'STATUS: TEST FAILURE.');
  const message = lines.join('\n');
  console.log(message);
  window.alert(message);
  return allPassed;
}

function bindEvents() {
  elements.activateBtn.addEventListener('click', startSensors);
  elements.copyWgsBtn.addEventListener('click', () => copyCoordinates('wgs'));
  elements.copyGcjBtn.addEventListener('click', () => copyCoordinates('gcj'));

  elements.modeInfoBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setModePopoverVisible(elements.modePopover.hidden);
  });
  elements.modePopoverClose.addEventListener('click', () => setModePopoverVisible(false, true));

  document.addEventListener('click', (event) => {
    if (elements.modePopover.hidden) {
      return;
    }
    if (elements.modePopover.contains(event.target) || elements.modeInfoBtn.contains(event.target)) {
      return;
    }
    setModePopoverVisible(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.modePopover.hidden) {
      setModePopoverVisible(false, true);
    }
  });

  for (const link of [elements.amapWgs, elements.gmapWgs, elements.amapGcj, elements.gmapGcj]) {
    link.addEventListener('click', (event) => {
      if (link.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible'
      && (state.locationWatchId !== null || state.orientationStatus === 'active')) {
      requestWakeLock();
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('Service Worker registration failed:', error);
    });
  }, { once: true });
}

function initialize() {
  buildCompassDial();
  updateHeadingSource('WAITING');
  setStatusBadge(elements.gpsStatus, 'GPS WAIT', 'neutral');
  renderCompassHeading();
  refreshActivationControl();
  bindEvents();
  registerServiceWorker();
  window.setInterval(updateFreshnessIndicators, 1000);

  // 显式挂到 window，保持历史版本承诺的手机控制台手工自测方式。
  window.runSystemSelfTest = runSystemSelfTest;
}

initialize();
