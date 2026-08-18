import {
  getOffsetRegionState,
  isValidCoordinate,
  wgs84ToGcj02
} from './geo.js';
import {
  getRelativeCourseAngle,
  isReliableCourseHeading,
  normalizeHeading,
  smoothHeading
} from './heading.js';
import { TelemetryRecorder } from './recorder.js';

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
  activateBtnLabel: requireElement('activateBtnLabel'),
  activationContainer: requireElement('activationContainer'),
  alertPanel: requireElement('alertPanel'),
  gpsStatus: requireElement('gpsStatus'),
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
  updateTime: requireElement('updateTime'),
  recStatus: requireElement('recStatus'),
  recorderSection: requireElement('recorderSection'),
  recStateBadge: requireElement('recStateBadge'),
  toggleRecBtn: requireElement('toggleRecBtn'),
  toggleRecLabel: requireElement('toggleRecLabel'),
  recBtnIcon: requireElement('recBtnIcon'),
  recDuration: requireElement('recDuration'),
  recGpsCount: requireElement('recGpsCount'),
  recOriCount: requireElement('recOriCount'),
  recMemory: requireElement('recMemory'),
  recorderExportTray: requireElement('recorderExportTray'),
  recorderDiagBox: requireElement('recorderDiagBox'),
  shareLogBtn: requireElement('shareLogBtn'),
  exportTxtBtn: requireElement('exportTxtBtn'),
  exportJsonBtn: requireElement('exportJsonBtn'),
  copySummaryBtn: requireElement('copySummaryBtn'),
  clearLogBtn: requireElement('clearLogBtn')
});

const recorder = new TelemetryRecorder();

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
  elements.compassWarning.hidden = source !== 'RELATIVE';
}

function renderCompassHeading() {
  // 主表盘永远只跟随手机物理手持方向旋转（无数据时默认保持 0 度）
  const displayPhoneHeading = normalizeHeading(state.phoneHeading) ?? 0;
  elements.compassDial.setAttribute('transform', `rotate(${-displayPhoneHeading} 160 160)`);

  // 蓝色航向针：车速达到门槛后，按相对于手机正前方的夹角在盘面旋转显现
  if (state.courseHeading !== null) {
    const relativeAngle = getRelativeCourseAngle(displayPhoneHeading, state.courseHeading) ?? 0;
    elements.courseMarker.setAttribute('transform', `rotate(${relativeAngle} 160 160)`);
    elements.courseMarker.classList.remove('hidden');
  } else {
    elements.courseMarker.classList.add('hidden');
  }

  // 始终同时独立更新两行读数
  elements.phoneHeadingValue.textContent = formatHeadingValue(state.phoneHeading);
  if (state.courseHeading !== null) {
    elements.courseHeadingValue.textContent = formatHeadingValue(state.courseHeading);
  } else if (state.currentData.speed !== null && state.currentData.speed < 8) {
    elements.courseHeadingValue.textContent = 'STATIONARY';
  } else {
    elements.courseHeadingValue.textContent = 'N/A';
  }
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

  // 同步写入全量黑匣子原始与解算数据
  recorder.recordGps(coords, {
    gcjLat,
    gcjLng,
    courseHeading: state.courseHeading,
    isReliableCourse: isReliableCourseHeading(coords.heading, coords.speed ? coords.speed * 3.6 : null),
    speed: state.currentData.speed
  });

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
      // 未知错误通常意味着旧监听已经失效；先清空 ID，重试按钮才能创建新监听。
      clearLocationWatch();
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

function recordOrientationState(event) {
  recorder.recordOrientation(event, {
    phoneHeading: state.phoneHeading,
    smoothedPhoneHeading: state.smoothedPhoneHeading,
    headingSource: state.currentHeadingSource,
    relativeCourseAngle: (state.phoneHeading !== null && state.courseHeading !== null)
      ? getRelativeCourseAngle(state.phoneHeading, state.courseHeading)
      : null
  });
}

function handleOrientation(event) {
  if (Number.isFinite(event.webkitCompassHeading)) {
    updatePhoneHeading(event.webkitCompassHeading, 'MAG');
  } else if (event.absolute === true && Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'MAG');
  } else if (Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'RELATIVE');
  }
  recordOrientationState(event);
}

function handleOrientationAbsolute(event) {
  if (Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'MAG');
  }
  recordOrientationState(event);
}

function handleOrientationFallback(event) {
  if (Number.isFinite(event.alpha)) {
    updatePhoneHeading(360 - event.alpha, 'RELATIVE');
  }
  recordOrientationState(event);
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
    elements.activateBtnLabel.textContent = 'Starting...';
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
    elements.activateBtnLabel.textContent = state.locationStatus === 'idle' ? 'Start GPS' : 'Retry GPS';
  } else if (!needsLocation && needsCompass) {
    elements.activateBtnLabel.textContent = state.orientationStatus === 'idle' ? 'Start Compass' : 'Retry Compass';
  } else {
    const hasFailure = state.locationStatus !== 'idle' || state.orientationStatus !== 'idle';
    elements.activateBtnLabel.textContent = hasFailure ? 'Retry Sensors' : 'Start Sensors';
  }
}

async function startSensors() {
  if (state.startInProgress) {
    return;
  }

  state.startInProgress = true;
  refreshActivationControl();

  try {
    // 启动传感器时若尚未录制，自动激活遥测黑匣子，防止开车忘记按 REC
    if (!recorder.isRecording) {
      recorder.startSession();
      updateRecorderUi();
    }

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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 1000);
}

function getFormattedFileTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function updateRecorderUi() {
  const stats = recorder.getStats();

  elements.recDuration.textContent = stats.durationText;
  elements.recGpsCount.textContent = stats.gpsCount.toString();
  elements.recOriCount.textContent = stats.orientationCount.toString();
  elements.recMemory.textContent = `${stats.estimatedMemoryKb} KB`;

  if (stats.isRecording) {
    elements.recStateBadge.textContent = 'REC';
    elements.recStateBadge.className = 'recorder-badge recording';
    elements.toggleRecBtn.classList.add('is-recording');
    elements.toggleRecLabel.textContent = 'Stop REC';
    elements.recBtnIcon.textContent = 'stop';
    elements.recStatus.textContent = `● REC ${stats.durationText}`;
    elements.recStatus.classList.remove('hidden');
  } else {
    elements.recStateBadge.textContent = stats.totalSamples > 0 ? 'STOPPED' : 'STANDBY';
    elements.recStateBadge.className = 'recorder-badge standby';
    elements.toggleRecBtn.classList.remove('is-recording');
    elements.toggleRecLabel.textContent = 'Start REC';
    elements.recBtnIcon.textContent = 'fiber_manual_record';
    elements.recStatus.classList.add('hidden');
  }
}

function renderDiagnosticSummary() {
  const diag = recorder.generateDiagnosticSummary();
  const stats = recorder.getStats();
  elements.recorderDiagBox.textContent = `【行车遥测诊断报告】(${stats.durationText} | 样本: ${stats.totalSamples})\n`
    + `• 最高车速: ${diag.maxSpeedKmh} km/h (最低: ${diag.minSpeedKmh} km/h)\n`
    + `• iOS 磁北硬件信号: ${diag.hasWkCompass ? '已捕捉 (有效磁北)' : '无独立磁北 (可能受车载磁场屏蔽)'}\n`
    + `• 陀螺仪角速度: ${diag.hasMotionRotation ? '已捕捉 (支持手转检测)' : '未提供'}\n`
    + `• 手机朝向角度极差: ${diag.phoneHeadingRange}`;
  elements.recorderDiagBox.hidden = false;
}

function toggleRecording() {
  if (recorder.isRecording) {
    recorder.stopSession();
    updateRecorderUi();
    elements.recorderExportTray.hidden = false;
    renderDiagnosticSummary();
  } else {
    recorder.startSession();
    updateRecorderUi();
    elements.recorderExportTray.hidden = true;
    elements.recorderDiagBox.hidden = true;
    requestWakeLock();
  }
}

function exportTxtLog() {
  const txtContent = recorder.exportToTxt();
  const filename = `where-i-am-flight-${getFormattedFileTimestamp()}.txt`;
  downloadBlob(new Blob([txtContent], { type: 'text/plain;charset=utf-8' }), filename);
}

function exportJsonLog() {
  const jsonContent = recorder.exportToJson();
  const filename = `where-i-am-flight-${getFormattedFileTimestamp()}.json`;
  downloadBlob(new Blob([jsonContent], { type: 'application/json;charset=utf-8' }), filename);
}

async function shareFlightLog() {
  const txtContent = recorder.exportToTxt();
  const filename = `where-i-am-flight-${getFormattedFileTimestamp()}.txt`;
  const file = new File([txtContent], filename, { type: 'text/plain;charset=utf-8' });

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'Where I AM 行车传感器遥测日志',
        text: `行车遥测黑匣子日志 (${recorder.getStats().durationText})`,
        files: [file]
      });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('Share API failed, falling back to download:', err);
    }
  }

  // 降级：直接下载 TXT
  downloadBlob(new Blob([txtContent], { type: 'text/plain;charset=utf-8' }), filename);
}

async function copyFlightSummary() {
  const diag = recorder.generateDiagnosticSummary();
  const stats = recorder.getStats();
  const summaryText = [
    `【Where I AM 行车遥测摘要】`,
    `会话 ID: ${recorder.sessionId || 'N/A'}`,
    `录制时长: ${stats.durationText}`,
    `样本总数: ${stats.totalSamples} (GPS: ${stats.gpsCount}, 姿态: ${stats.orientationCount}, 运动: ${stats.motionCount})`,
    `最高车速: ${diag.maxSpeedKmh} km/h`,
    `iOS 磁北硬件信号: ${diag.hasWkCompass ? '正常' : '未检测到'}`,
    `陀螺仪角速度信号: ${diag.hasMotionRotation ? '正常' : '未检测到'}`,
    `手机朝向波动范围: ${diag.phoneHeadingRange}`
  ].join('\n');

  try {
    await writeClipboard(summaryText);
    flashCopyResult(elements.copySummaryBtn, true);
  } catch {
    flashCopyResult(elements.copySummaryBtn, false);
  }
}

function clearFlightLog() {
  if (recorder.isRecording) {
    recorder.stopSession();
  }
  recorder.clear();
  updateRecorderUi();
  elements.recorderExportTray.hidden = true;
  elements.recorderDiagBox.hidden = true;
  elements.recorderDiagBox.textContent = '';
}

function bindEvents() {
  elements.activateBtn.addEventListener('click', startSensors);
  elements.copyWgsBtn.addEventListener('click', () => copyCoordinates('wgs'));
  elements.copyGcjBtn.addEventListener('click', () => copyCoordinates('gcj'));

  // 记录器控制与导出绑定
  elements.toggleRecBtn.addEventListener('click', toggleRecording);
  elements.exportTxtBtn.addEventListener('click', exportTxtLog);
  elements.exportJsonBtn.addEventListener('click', exportJsonLog);
  elements.shareLogBtn.addEventListener('click', shareFlightLog);
  elements.copySummaryBtn.addEventListener('click', copyFlightSummary);
  elements.clearLogBtn.addEventListener('click', clearFlightLog);

  // 原始运动传感器监听
  window.addEventListener('devicemotion', (event) => {
    recorder.recordMotion(event);
  }, true);

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
  updateRecorderUi();
  bindEvents();
  registerServiceWorker();
  window.setInterval(() => {
    updateFreshnessIndicators();
    if (recorder.isRecording) {
      updateRecorderUi();
    }
  }, 1000);
}

initialize();
