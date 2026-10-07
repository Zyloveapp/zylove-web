// Maps engine output (0–100 "raw", result.raw) onto the display
// scale, so scores spread out: median ≈ 55, under 1% at 95+, with the labels
// (Strong fit 75+, Good fit 60–74, Some differences < 60) landing on sensible
// shares of pairs. Piecewise-linear and monotonic; points are raw → display.
// Fitted by scripts/calibrate-scores.mjs on realistic (coherent, complete)
// profiles and checked against production pairs. Changing a
// curve changes every score: bump SCORE_ENGINE_VERSION (scoring.ts) with it.

type Curve = readonly (readonly [number, number])[]

// Fitted 2026-10-07 (engine v2) on every compatible pair of the curated
// profiles in functions/test/fixtures/bots.json (n = 258).
export const TIER1_CURVE: Curve = [
  [0, 0], [72.6, 15], [78.3, 30], [82.7, 45], [86.5, 55], [89.7, 64], [92.5, 75], [95, 85], [100, 100],
]

export const TIER0_CURVE: Curve = [
  [0, 0], [29.8, 15], [39.1, 30], [46.7, 45], [55.2, 55], [63.3, 64], [70.4, 75], [78.1, 85], [100, 100],
]

export function applyCurve(curve: Curve, raw: number): number {
  const x = Math.max(0, Math.min(100, raw))
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]
    if (x <= x1) {
      const [x0, y0] = curve[i - 1]
      return x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)
    }
  }
  return curve[curve.length - 1][1]
}

export const calibrateTier1 = (raw: number): number => applyCurve(TIER1_CURVE, raw)
export const calibrateTier0 = (raw: number): number => applyCurve(TIER0_CURVE, raw)
