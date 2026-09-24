// Wrong answers score 0. Correct answers score points_base scaled down
// linearly from full marks (answered instantly) to half marks (answered
// right at the buffer zero, i.e. at the wire).
// A late/missing answer (arrived after the time limit) is treated as wrong.
function computeScore({ isCorrect, responseTimeMs, timeLimitSeconds, pointsBase }) {
  if (!isCorrect) return 0;
  const timeLimitMs = timeLimitSeconds * 1000;
  const clamped = Math.max(0, Math.min(responseTimeMs, timeLimitMs));
  const speedFraction = 1 - clamped / timeLimitMs; // 1 = instant, 0 = used all the time
  const points = pointsBase * (0.5 + 0.5 * speedFraction);
  return Math.round(points);
}

module.exports = { computeScore };
