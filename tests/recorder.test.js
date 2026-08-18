import assert from 'node:assert/strict';
import test from 'node:test';

import { TelemetryRecorder } from '../js/recorder.js';

test('TelemetryRecorder 会话开启、记录与统计', () => {
  const recorder = new TelemetryRecorder({
    orientationThrottleMs: 10,
    motionThrottleMs: 10
  });

  assert.equal(recorder.isRecording, false);
  const sessionId = recorder.startSession({ vehicle: 'test-car' });
  assert.ok(sessionId.startsWith('flight_'));
  assert.equal(recorder.isRecording, true);

  // 记录 GPS
  recorder.recordGps(
    { latitude: 39.9, longitude: 116.4, speed: 20, heading: 90, altitude: 45, accuracy: 5 },
    { gcjLat: 39.901, gcjLng: 116.406, courseHeading: 90, isReliableCourse: true, speed: 72 }
  );

  // 记录 Orientation
  recorder.recordOrientation(
    { webkitCompassHeading: 88, webkitCompassAccuracy: 5, alpha: 272, beta: 10, gamma: -2, absolute: true },
    { phoneHeading: 88, smoothedPhoneHeading: 88, headingSource: 'MAG', relativeCourseAngle: 2 }
  );

  // 记录 Motion
  recorder.recordMotion({
    acceleration: { x: 0.1, y: 0.2, z: 0.3 },
    rotationRate: { alpha: 0.5, beta: -0.2, gamma: 1.1 },
    interval: 16
  });

  const stats = recorder.getStats();
  assert.equal(stats.isRecording, true);
  assert.equal(stats.gpsCount, 1);
  assert.equal(stats.orientationCount, 1);
  assert.equal(stats.motionCount, 1);
  assert.ok(stats.totalSamples >= 4); // 包含 SESSION_START

  // 停止会话
  const endStats = recorder.stopSession();
  assert.equal(recorder.isRecording, false);
  assert.equal(endStats.isRecording, false);
});

test('TelemetryRecorder 抽样节流有效防止过高频次膨胀', async () => {
  const recorder = new TelemetryRecorder({
    orientationThrottleMs: 50,
    motionThrottleMs: 50
  });

  recorder.startSession();

  // 连续高频调用 5 次（间隔 0ms）
  for (let i = 0; i < 5; i++) {
    recorder.recordOrientation({ alpha: i, beta: 0, gamma: 0 });
    recorder.recordMotion({ acceleration: { x: i } });
  }

  // 节流后应该只有 1 帧写入
  assert.equal(recorder.orientationCount, 1);
  assert.equal(recorder.motionCount, 1);

  // 等待 60ms 再次调用
  await new Promise((r) => setTimeout(r, 60));
  recorder.recordOrientation({ alpha: 99 });
  recorder.recordMotion({ acceleration: { x: 99 } });

  assert.equal(recorder.orientationCount, 2);
  assert.equal(recorder.motionCount, 2);

  recorder.stopSession();
});

test('TelemetryRecorder 导出 TXT 与 JSON 内容完整性', () => {
  const recorder = new TelemetryRecorder();
  recorder.startSession();

  recorder.recordGps(
    { latitude: 31.23, longitude: 121.47, speed: 25, heading: 180, accuracy: 3 },
    { gcjLat: 31.228, gcjLng: 121.474, courseHeading: 180, isReliableCourse: true, speed: 90 }
  );

  recorder.recordOrientation(
    { webkitCompassHeading: 175, webkitCompassAccuracy: 10, alpha: 185, beta: 5, gamma: 0 },
    { phoneHeading: 175, smoothedPhoneHeading: 175, headingSource: 'MAG', relativeCourseAngle: 5 }
  );

  recorder.stopSession();

  const txt = recorder.exportToTxt();
  assert.ok(txt.includes('FLIGHT RECORDER LOG'));
  assert.ok(txt.includes('Max Speed'));
  assert.ok(txt.includes('RAW_WGS(31.230000, 121.470000)'));
  assert.ok(txt.includes('wkHdg=175.0°'));

  const jsonStr = recorder.exportToJson();
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.schemaVersion, '1.0');
  assert.ok(Array.isArray(parsed.records));
  assert.ok(parsed.records.some((r) => r.type === 'GPS'));
  assert.ok(parsed.records.some((r) => r.type === 'ORIENTATION'));
});
