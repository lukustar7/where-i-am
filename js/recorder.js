/**
 * 行车黑匣子与传感器遥测记录引擎。
 *
 * 核心职责：
 * 1. 实时抓取手机底层的全部原始传感器数据（GPS 原始流、磁北/欧拉角姿态流、陀螺仪/加速度运动流）。
 * 2. 同步比对应用层解算与渲染状态（手机朝向、GPS 航向、相对角、解算来源）。
 * 3. 自适应高频抽样节流与内存保护，支持 10~50 公里长时间持续记录。
 * 4. 提供 IndexedDB 容灾备份、TXT 易读文本导出、JSON 深度分析导出与系统原生分享。
 */

const DB_NAME = 'where-i-am-telemetry-db';
const DB_VERSION = 1;
const STORE_NAME = 'flight_records';

export class TelemetryRecorder {
  constructor(options = {}) {
    this.maxSamples = options.maxSamples ?? 50000;
    this.orientationThrottleMs = options.orientationThrottleMs ?? 100; // ~10Hz 抽样，平衡精度与内存
    this.motionThrottleMs = options.motionThrottleMs ?? 100;

    this.isRecording = false;
    this.sessionId = null;
    this.sessionStartTime = null;
    this.sessionEndTime = null;

    this.lastOrientationRecordAt = 0;
    this.lastMotionRecordAt = 0;

    this.records = [];
    this.gpsCount = 0;
    this.orientationCount = 0;
    this.motionCount = 0;
    this.systemCount = 0;

    this.db = null;
    this.dbInitPromise = this.initIndexedDb();
  }

  async initIndexedDb() {
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          }
        };
        request.onsuccess = (event) => {
          this.db = event.target.result;
          resolve(this.db);
        };
        request.onerror = () => {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  }

  startSession(metadata = {}) {
    this.sessionId = `flight_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.sessionStartTime = Date.now();
    this.sessionEndTime = null;
    this.isRecording = true;
    this.records = [];
    this.gpsCount = 0;
    this.orientationCount = 0;
    this.motionCount = 0;
    this.systemCount = 0;
    this.lastOrientationRecordAt = 0;
    this.lastMotionRecordAt = 0;

    this.recordSystemEvent('SESSION_START', {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      screenOrientation: typeof screen !== 'undefined' && screen.orientation ? screen.orientation.type : 'unknown',
      viewport: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : null,
      ...metadata
    });

    return this.sessionId;
  }

  stopSession() {
    if (!this.isRecording) {
      return this.getStats();
    }

    this.sessionEndTime = Date.now();
    this.isRecording = false;
    this.recordSystemEvent('SESSION_STOP', {
      durationMs: this.sessionEndTime - this.sessionStartTime,
      totalSamples: this.records.length
    });

    this.persistToIndexedDb().catch(() => undefined);
    return this.getStats();
  }

  recordGps(rawCoords, computedState = {}) {
    if (!this.isRecording || !rawCoords) {
      return;
    }

    const now = Date.now();
    const record = {
      t_ms: now - this.sessionStartTime,
      type: 'GPS',
      epoch: now,
      raw: {
        lat: rawCoords.latitude,
        lng: rawCoords.longitude,
        alt: rawCoords.altitude ?? null,
        acc: rawCoords.accuracy ?? null,
        altAcc: rawCoords.altitudeAccuracy ?? null,
        spd_mps: rawCoords.speed ?? null,
        spd_kmh: Number.isFinite(rawCoords.speed) ? rawCoords.speed * 3.6 : null,
        hdg_deg: rawCoords.heading ?? null,
        hwTimestamp: rawCoords.timestamp ?? null
      },
      computed: {
        gcjLat: computedState.gcjLat ?? null,
        gcjLng: computedState.gcjLng ?? null,
        courseHeading: computedState.courseHeading ?? null,
        isReliableCourse: computedState.isReliableCourse ?? false,
        speed_kmh: computedState.speed ?? null
      }
    };

    this.appendRecord(record);
    this.gpsCount += 1;
  }

  recordOrientation(rawEvent, computedState = {}) {
    if (!this.isRecording || !rawEvent) {
      return;
    }

    const now = Date.now();
    if (now - this.lastOrientationRecordAt < this.orientationThrottleMs) {
      return;
    }
    this.lastOrientationRecordAt = now;

    const record = {
      t_ms: now - this.sessionStartTime,
      type: 'ORIENTATION',
      epoch: now,
      raw: {
        alpha: rawEvent.alpha ?? null,
        beta: rawEvent.beta ?? null,
        gamma: rawEvent.gamma ?? null,
        absolute: rawEvent.absolute ?? null,
        webkitCompassHeading: rawEvent.webkitCompassHeading ?? null,
        webkitCompassAccuracy: rawEvent.webkitCompassAccuracy ?? null
      },
      computed: {
        phoneHeading: computedState.phoneHeading ?? null,
        smoothedPhoneHeading: computedState.smoothedPhoneHeading ?? null,
        headingSource: computedState.headingSource ?? null,
        relativeCourseAngle: computedState.relativeCourseAngle ?? null
      }
    };

    this.appendRecord(record);
    this.orientationCount += 1;
  }

  recordMotion(rawEvent) {
    if (!this.isRecording || !rawEvent) {
      return;
    }

    const now = Date.now();
    if (now - this.lastMotionRecordAt < this.motionThrottleMs) {
      return;
    }
    this.lastMotionRecordAt = now;

    const acc = rawEvent.acceleration || {};
    const accGrav = rawEvent.accelerationIncludingGravity || {};
    const rot = rawEvent.rotationRate || {};

    const record = {
      t_ms: now - this.sessionStartTime,
      type: 'MOTION',
      epoch: now,
      raw: {
        acc_x: acc.x ?? null,
        acc_y: acc.y ?? null,
        acc_z: acc.z ?? null,
        accGrav_x: accGrav.x ?? null,
        accGrav_y: accGrav.y ?? null,
        accGrav_z: accGrav.z ?? null,
        rotRate_alpha: rot.alpha ?? null,
        rotRate_beta: rot.beta ?? null,
        rotRate_gamma: rot.gamma ?? null,
        interval: rawEvent.interval ?? null
      }
    };

    this.appendRecord(record);
    this.motionCount += 1;
  }

  recordSystemEvent(event, details = {}) {
    const now = Date.now();
    const startTime = this.sessionStartTime ?? now;
    const record = {
      t_ms: now - startTime,
      type: 'SYSTEM',
      epoch: now,
      event,
      details
    };

    this.appendRecord(record);
    this.systemCount += 1;
  }

  appendRecord(record) {
    if (this.records.length >= this.maxSamples) {
      this.records.shift(); // 环形缓冲，防止极长时间测试耗尽浏览器内存
    }
    this.records.push(record);
  }

  getStats() {
    const now = Date.now();
    const durationMs = this.sessionStartTime
      ? (this.isRecording ? now - this.sessionStartTime : (this.sessionEndTime ?? now) - this.sessionStartTime)
      : 0;

    const estimatedBytes = this.records.length * 160;

    return {
      isRecording: this.isRecording,
      sessionId: this.sessionId,
      durationMs,
      durationText: formatDuration(durationMs),
      totalSamples: this.records.length,
      gpsCount: this.gpsCount,
      orientationCount: this.orientationCount,
      motionCount: this.motionCount,
      estimatedMemoryKb: (estimatedBytes / 1024).toFixed(1)
    };
  }

  clear() {
    this.records = [];
    this.gpsCount = 0;
    this.orientationCount = 0;
    this.motionCount = 0;
    this.systemCount = 0;
    this.sessionStartTime = null;
    this.sessionEndTime = null;
    this.sessionId = null;
    this.isRecording = false;
  }

  async persistToIndexedDb() {
    if (!this.db || this.records.length === 0) {
      return;
    }

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const snapshot = {
        sessionId: this.sessionId,
        sessionStartTime: this.sessionStartTime,
        sessionEndTime: this.sessionEndTime,
        stats: this.getStats(),
        records: this.records
      };
      store.put(snapshot);
    } catch (error) {
      console.warn('Failed to persist flight log to IndexedDB:', error);
    }
  }

  generateDiagnosticSummary() {
    let maxSpeedKmh = 0;
    let minSpeedKmh = Infinity;
    let gpsCount = 0;
    let orientationCount = 0;
    let motionCount = 0;
    let hasWkCompass = false;
    let hasMotionRotation = false;

    let initialPhoneHdg = null;
    let phoneHdgMin = Infinity;
    let phoneHdgMax = -Infinity;

    for (const r of this.records) {
      if (r.type === 'GPS') {
        gpsCount++;
        const spd = r.raw.spd_kmh ?? 0;
        if (spd > maxSpeedKmh) maxSpeedKmh = spd;
        if (spd < minSpeedKmh) minSpeedKmh = spd;
      } else if (r.type === 'ORIENTATION') {
        orientationCount++;
        if (r.raw.webkitCompassHeading !== null) {
          hasWkCompass = true;
        }
        const ph = r.computed.phoneHeading;
        if (ph !== null) {
          if (initialPhoneHdg === null) initialPhoneHdg = ph;
          if (ph < phoneHdgMin) phoneHdgMin = ph;
          if (ph > phoneHdgMax) phoneHdgMax = ph;
        }
      } else if (r.type === 'MOTION') {
        motionCount++;
        if (r.raw.rotRate_alpha !== null || r.raw.rotRate_gamma !== null) {
          hasMotionRotation = true;
        }
      }
    }

    return {
      gpsCount,
      orientationCount,
      motionCount,
      maxSpeedKmh: maxSpeedKmh.toFixed(1),
      minSpeedKmh: minSpeedKmh === Infinity ? '0.0' : minSpeedKmh.toFixed(1),
      hasWkCompass,
      hasMotionRotation,
      phoneHeadingRange: phoneHdgMin !== Infinity ? `${phoneHdgMin.toFixed(0)}° ~ ${phoneHdgMax.toFixed(0)}°` : 'N/A'
    };
  }

  /**
   * 导出为人类直接可读的 .txt 日志文件
   */
  exportToTxt() {
    const stats = this.getStats();
    const diag = this.generateDiagnosticSummary();
    const startDateStr = this.sessionStartTime ? new Date(this.sessionStartTime).toISOString() : 'N/A';
    const endDateStr = this.sessionEndTime ? new Date(this.sessionEndTime).toISOString() : 'N/A';

    const lines = [
      '========================================================================',
      ' WHERE I AM - FLIGHT RECORDER LOG (DUAL-TRACK TELEMETRY)',
      '========================================================================',
      `Session ID: ${this.sessionId || 'N/A'}`,
      `Recording Start: ${startDateStr}`,
      `Recording End:   ${endDateStr}`,
      `Total Duration:  ${stats.durationText} (${(stats.durationMs / 1000).toFixed(1)}s)`,
      `Total Records:   ${this.records.length} (GPS: ${stats.gpsCount} | ORI: ${stats.orientationCount} | MOT: ${stats.motionCount} | SYS: ${this.systemCount})`,
      '------------------------------------------------------------------------',
      ' DIAGNOSTIC SUMMARY:',
      `  • Max Speed: ${diag.maxSpeedKmh} km/h`,
      `  • WebKit Compass Active: ${diag.hasWkCompass ? 'YES' : 'NO'}`,
      `  • Gyro RotationRate Active: ${diag.hasMotionRotation ? 'YES' : 'NO'}`,
      `  • Phone Heading Range: ${diag.phoneHeadingRange}`,
      '========================================================================',
      ' TIME-SERIES DUAL-TRACK TELEMETRY (Raw hardware inputs vs Screen outputs)',
      ' Format Columns:',
      '  [+OFFSET_TIME] [TYPE] Details (Raw inputs | Computed screen outputs)',
      '------------------------------------------------------------------------'
    ];

    for (const r of this.records) {
      const timeTag = `[+${formatDurationMs(r.t_ms)}]`;

      if (r.type === 'GPS') {
        const rawHdg = r.raw.hdg_deg !== null ? `${r.raw.hdg_deg.toFixed(1)}°` : 'null';
        const spdKmh = r.raw.spd_kmh !== null ? `${r.raw.spd_kmh.toFixed(1)}km/h` : 'null';
        const acc = r.raw.acc !== null ? `±${r.raw.acc.toFixed(1)}m` : 'null';
        const alt = r.raw.alt !== null ? `${r.raw.alt.toFixed(1)}m` : 'null';
        const gcj = r.computed.gcjLat !== null ? `GCJ(${r.computed.gcjLat.toFixed(5)},${r.computed.gcjLng.toFixed(5)})` : 'None';
        const isRel = r.computed.isReliableCourse ? 'RELIABLE' : 'UNRELIABLE';

        lines.push(`${timeTag} [GPS] RAW_WGS(${r.raw.lat.toFixed(6)}, ${r.raw.lng.toFixed(6)}) | Spd: ${spdKmh} | Hdg(Course): ${rawHdg} | Acc: ${acc} | Alt: ${alt} || COMPUTED: ${gcj} | CourseState: ${isRel}`);
      } else if (r.type === 'ORIENTATION') {
        const wkHdg = r.raw.webkitCompassHeading !== null ? `${r.raw.webkitCompassHeading.toFixed(1)}°` : 'null';
        const wkAcc = r.raw.webkitCompassAccuracy !== null ? `±${r.raw.webkitCompassAccuracy.toFixed(1)}°` : 'null';
        const alpha = r.raw.alpha !== null ? `${r.raw.alpha.toFixed(1)}°` : 'null';
        const beta = r.raw.beta !== null ? `${r.raw.beta.toFixed(1)}°` : 'null';
        const gamma = r.raw.gamma !== null ? `${r.raw.gamma.toFixed(1)}°` : 'null';
        const abs = r.raw.absolute ? 'ABS' : 'REL';

        const outHdg = r.computed.phoneHeading !== null ? `${r.computed.phoneHeading.toFixed(1)}°` : 'N/A';
        const outSrc = r.computed.headingSource ?? 'N/A';
        const outRel = r.computed.relativeCourseAngle !== null ? `${r.computed.relativeCourseAngle.toFixed(1)}°` : 'N/A';

        lines.push(`${timeTag} [ORI] RAW_INPUT: wkHdg=${wkHdg} (acc=${wkAcc}), alpha=${alpha}, beta=${beta}, gamma=${gamma}, mode=${abs} || DISPLAY_OUTPUT: PhoneHdg=${outHdg} [${outSrc}], RelCourseArrow=${outRel}`);
      } else if (r.type === 'MOTION') {
        const rotA = r.raw.rotRate_alpha !== null ? r.raw.rotRate_alpha.toFixed(1) : 'null';
        const rotB = r.raw.rotRate_beta !== null ? r.raw.rotRate_beta.toFixed(1) : 'null';
        const rotG = r.raw.rotRate_gamma !== null ? r.raw.rotRate_gamma.toFixed(1) : 'null';
        const accX = r.raw.acc_x !== null ? r.raw.acc_x.toFixed(2) : 'null';
        const accY = r.raw.acc_y !== null ? r.raw.acc_y.toFixed(2) : 'null';
        const accZ = r.raw.acc_z !== null ? r.raw.acc_z.toFixed(2) : 'null';

        lines.push(`${timeTag} [MOT] RAW_GYRO(deg/s): α(Z)=${rotA}, β(X)=${rotB}, γ(Y)=${rotG} | RAW_ACC(m/s²): X=${accX}, Y=${accY}, Z=${accZ}`);
      } else if (r.type === 'SYSTEM') {
        lines.push(`${timeTag} [SYS] Event: ${r.event} | Details: ${JSON.stringify(r.details)}`);
      }
    }

    lines.push('========================================================================');
    lines.push(' END OF FLIGHT LOG');
    lines.push('========================================================================');

    return lines.join('\n');
  }

  /**
   * 导出为结构化 JSON，用于图表渲染和深度分析
   */
  exportToJson() {
    return JSON.stringify({
      schemaVersion: '1.0',
      sessionId: this.sessionId,
      sessionStartTime: this.sessionStartTime,
      sessionEndTime: this.sessionEndTime,
      stats: this.getStats(),
      diagnostic: this.generateDiagnosticSummary(),
      records: this.records
    }, null, 2);
  }
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatDurationMs(t_ms) {
  const totalMs = Math.max(0, Math.floor(t_ms));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}
