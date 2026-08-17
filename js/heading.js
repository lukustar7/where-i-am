/**
 * 指南针方向数学计算与双向指示解算模块。
 *
 * 纯数学函数库，零 DOM 依赖，提供角度标准化、最短角计算、相对角解算和低通滤波。
 */

export const DEFAULT_HEADING_CONFIG = Object.freeze({
  courseSpeedThreshold: 8 // 8 km/h 速度阈值
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
 * 计算航向相对于手机正前方的旋转夹角（在表盘坐标系中的角度）。
 */
export function getRelativeCourseAngle(phoneHeading, courseHeading) {
  const phone = normalizeHeading(phoneHeading);
  const course = normalizeHeading(courseHeading);

  if (course === null) {
    return null;
  }

  if (phone === null) {
    return course;
  }

  return normalizeHeading(course - phone);
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
 * GPS 只有同时提供有效速度和运动方向，并达到速度门槛时才可作为可靠航向。
 */
export function isReliableCourseHeading(heading, speed, threshold = DEFAULT_HEADING_CONFIG.courseSpeedThreshold) {
  return Number.isFinite(heading)
    && Number.isFinite(speed)
    && speed >= threshold;
}
