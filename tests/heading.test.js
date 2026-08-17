import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEADING_MODES,
  HeadingModeResolver,
  getHeadingDelta,
  getRelativeCourseAngle,
  isReliableCourseHeading,
  normalizeHeading,
  smoothHeading
} from '../js/heading.js';

test('角度标准化覆盖负数、多圈旋转和非法值', () => {
  assert.equal(normalizeHeading(0), 0);
  assert.equal(normalizeHeading(360), 0);
  assert.equal(normalizeHeading(-1), 359);
  assert.equal(normalizeHeading(721), 1);
  assert.equal(normalizeHeading(Number.NaN), null);
});

test('最短夹角正确跨越正北零点', () => {
  assert.equal(getHeadingDelta(359, 1), 2);
  assert.equal(getHeadingDelta(10, 190), 180);
  assert.equal(getHeadingDelta(null, 10), null);
});

test('相对航向角正确计算（支持正向、反向与跨零点）', () => {
  // 手机指北(0°)，车向东(90°) -> 相对角 90°
  assert.equal(getRelativeCourseAngle(0, 90), 90);
  // 手机指东(90°)，车向北(0°) -> 相对角 270°
  assert.equal(getRelativeCourseAngle(90, 0), 270);
  // 手机指南(180°)，车向北(0°) -> 相对角 180°
  assert.equal(getRelativeCourseAngle(180, 0), 180);
  // 手机指 350°，车指 10° -> 相对角 20°
  assert.equal(getRelativeCourseAngle(350, 10), 20);
});

test('低通平滑沿最短路径跨越零点', () => {
  assert.equal(smoothHeading(359, 1, 0.5), 0);
  assert.equal(smoothHeading(null, 90, 0.15), 90);
  assert.equal(smoothHeading(10, 30, 2), 30);
});

test('GPS 运动方向必须同时满足方向和速度条件', () => {
  assert.equal(isReliableCourseHeading(90, 8), true);
  assert.equal(isReliableCourseHeading(90, 7.99), false);
  assert.equal(isReliableCourseHeading(null, 20), false);
  assert.equal(isReliableCourseHeading(90, null), false);
});

test('双向模式解析：移动且双传感器正常为 DUAL，低速回到 PHONE', () => {
  const resolver = new HeadingModeResolver();
  assert.equal(resolver.resolve({ phoneHeading: 10, courseHeading: 40, speed: 30 }), HEADING_MODES.DUAL_ACTIVE);
  assert.equal(resolver.resolve({ phoneHeading: 10, courseHeading: 40, speed: 5 }), HEADING_MODES.PHONE_ONLY);
  assert.equal(resolver.resolve({ phoneHeading: 10, courseHeading: null, speed: 0 }), HEADING_MODES.PHONE_ONLY);
});

test('缺少手机方向时为 COURSE，全部缺失时为 WAITING', () => {
  const resolver = new HeadingModeResolver();
  assert.equal(resolver.resolve({ phoneHeading: null, courseHeading: 180, speed: 30 }), HEADING_MODES.COURSE_ONLY);
  assert.equal(resolver.resolve({ phoneHeading: null, courseHeading: null, speed: null }), HEADING_MODES.WAITING);
});
