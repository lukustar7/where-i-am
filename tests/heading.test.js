import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEADING_MODES,
  HeadingModeResolver,
  getHeadingDelta,
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

test('方向模式只有持续贴合后才切换到 COURSE', () => {
  const resolver = new HeadingModeResolver();
  assert.equal(resolver.resolve({ phoneHeading: 90, courseHeading: 93, speed: 20, now: 1000 }), HEADING_MODES.CHECKING);
  assert.equal(resolver.resolve({ phoneHeading: 91, courseHeading: 93, speed: 20, now: 2799 }), HEADING_MODES.CHECKING);
  assert.equal(resolver.resolve({ phoneHeading: 91, courseHeading: 93, speed: 20, now: 2800 }), HEADING_MODES.COURSE);
});

test('方向持续分离后切换到 DUAL，低速立即回到 PHONE', () => {
  const resolver = new HeadingModeResolver();
  assert.equal(resolver.resolve({ phoneHeading: 10, courseHeading: 40, speed: 30, now: 1000 }), HEADING_MODES.CHECKING);
  assert.equal(resolver.resolve({ phoneHeading: 10, courseHeading: 40, speed: 30, now: 2000 }), HEADING_MODES.DUAL);
  assert.equal(resolver.resolve({ phoneHeading: 10, courseHeading: 40, speed: 2, now: 2100 }), HEADING_MODES.PHONE);
});

test('缺少手机方向时可使用可靠 COURSE，全部缺失时等待', () => {
  const resolver = new HeadingModeResolver();
  assert.equal(resolver.resolve({ phoneHeading: null, courseHeading: 180, speed: 30 }), HEADING_MODES.COURSE);
  assert.equal(resolver.resolve({ phoneHeading: null, courseHeading: null, speed: null }), HEADING_MODES.WAITING);
});

test('迟滞区保留已经确认的稳定模式', () => {
  const resolver = new HeadingModeResolver({ dualConfirmMs: 0 });
  assert.equal(resolver.resolve({ phoneHeading: 0, courseHeading: 30, speed: 20, now: 100 }), HEADING_MODES.DUAL);
  assert.equal(resolver.resolve({ phoneHeading: 0, courseHeading: 8, speed: 20, now: 200 }), HEADING_MODES.DUAL);
});
