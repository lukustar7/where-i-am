/**
 * 指南针方向计算模块。
 *
 * 所有函数都不依赖 DOM 或浏览器传感器，页面只负责把传感器数字交进来。
 * 方向平滑、最短夹角和模式切换因此可以被独立验证。
 */

export const HEADING_MODES = Object.freeze({
  WAITING: 'WAITING',
  PHONE: 'PHONE',
  COURSE: 'COURSE',
  DUAL: 'DUAL',
  CHECKING: 'CHECKING'
});

export const DEFAULT_HEADING_CONFIG = Object.freeze({
  courseSpeedThreshold: 8,
  linkedDeltaThreshold: 5,
  dualDeltaThreshold: 12,
  courseConfirmMs: 1800,
  dualConfirmMs: 1000
});

/**
 * 把任意有限角度收敛到 0（含）至 360（不含）的范围。
 */
export function normalizeHeading(heading) {
  if (!Number.isFinite(heading)) {
    return null;
  }

  const normalized = ((heading % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/**
 * 计算两个方向之间的最短夹角，结果始终位于 0 至 180 度。
 */
export function getHeadingDelta(firstHeading, secondHeading) {
  const first = normalizeHeading(firstHeading);
  const second = normalizeHeading(secondHeading);

  if (first === null || second === null) {
    return null;
  }

  const difference = Math.abs(first - second);
  return Math.min(difference, 360 - difference);
}

/**
 * 沿最短旋转方向做一次低通平滑，正确处理 359 度跨越到 1 度的情况。
 */
export function smoothHeading(previousHeading, nextHeading, alpha = 0.15) {
  const next = normalizeHeading(nextHeading);
  const previous = normalizeHeading(previousHeading);

  if (next === null) {
    return previous;
  }

  if (previous === null) {
    return next;
  }

  const safeAlpha = Number.isFinite(alpha)
    ? Math.min(1, Math.max(0, alpha))
    : 0.15;
  let difference = next - previous;

  while (difference < -180) difference += 360;
  while (difference > 180) difference -= 360;

  return normalizeHeading(previous + safeAlpha * difference);
}

/**
 * GPS 只有同时提供有效速度和运动方向，并达到速度门槛时才可参与模式判断。
 */
export function isReliableCourseHeading(heading, speed, threshold = DEFAULT_HEADING_CONFIG.courseSpeedThreshold) {
  return Number.isFinite(heading)
    && Number.isFinite(speed)
    && speed >= threshold;
}

/**
 * 有时间确认和迟滞区间的方向模式状态机。
 *
 * 手机方向与 GPS 方向短暂接近或分离时先进入 CHECKING，持续满足条件后才切换。
 * 这样可防止车辆颠簸、GPS 瞬时漂移造成界面在 COURSE 与 DUAL 之间快速闪烁。
 */
export class HeadingModeResolver {
  constructor(config = {}) {
    this.config = {
      ...DEFAULT_HEADING_CONFIG,
      ...config
    };
    this.mode = HEADING_MODES.WAITING;
    this.linkedSince = null;
    this.divergedSince = null;
  }

  reset(mode = HEADING_MODES.WAITING) {
    this.mode = mode;
    this.linkedSince = null;
    this.divergedSince = null;
    return this.mode;
  }

  resetTimers() {
    this.linkedSince = null;
    this.divergedSince = null;
  }

  resolve({ phoneHeading = null, courseHeading = null, speed = null, now = Date.now() } = {}) {
    const hasPhoneHeading = normalizeHeading(phoneHeading) !== null;
    const hasReliableCourse = isReliableCourseHeading(
      courseHeading,
      speed,
      this.config.courseSpeedThreshold
    );
    const safeNow = Number.isFinite(now) ? now : Date.now();

    if (!hasPhoneHeading && !hasReliableCourse) {
      return this.reset(HEADING_MODES.WAITING);
    }

    if (!hasReliableCourse) {
      return this.reset(hasPhoneHeading ? HEADING_MODES.PHONE : HEADING_MODES.WAITING);
    }

    if (!hasPhoneHeading) {
      return this.reset(HEADING_MODES.COURSE);
    }

    const delta = getHeadingDelta(phoneHeading, courseHeading);

    if (delta <= this.config.linkedDeltaThreshold) {
      if (this.linkedSince === null) {
        this.linkedSince = safeNow;
      }
      this.divergedSince = null;

      if (safeNow - this.linkedSince >= this.config.courseConfirmMs) {
        this.mode = HEADING_MODES.COURSE;
      } else if (this.mode !== HEADING_MODES.COURSE) {
        this.mode = HEADING_MODES.CHECKING;
      }

      return this.mode;
    }

    if (delta >= this.config.dualDeltaThreshold) {
      if (this.divergedSince === null) {
        this.divergedSince = safeNow;
      }
      this.linkedSince = null;

      if (safeNow - this.divergedSince >= this.config.dualConfirmMs) {
        this.mode = HEADING_MODES.DUAL;
      } else if (this.mode !== HEADING_MODES.DUAL) {
        this.mode = HEADING_MODES.CHECKING;
      }

      return this.mode;
    }

    // 5 至 12 度之间是迟滞区，保留已确认的稳定模式，否则继续显示检查中。
    this.resetTimers();
    if (this.mode !== HEADING_MODES.COURSE && this.mode !== HEADING_MODES.DUAL) {
      this.mode = HEADING_MODES.CHECKING;
    }
    return this.mode;
  }
}
