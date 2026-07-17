function clampWindow(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { clampWindow };
