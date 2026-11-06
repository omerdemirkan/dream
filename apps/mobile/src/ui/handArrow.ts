/**
 * The hand-drawn arrow on an empty Home (mocks/screens/home-empty, A3): a loop-de-loop from the words down to the
 * input. Each stroke is a filled outline, so it can taper at both ends and wobble a little like a pen line; the
 * head is two uneven flicks aimed back along the stroke's last direction. Plain geometry, computed once.
 */

type Point = readonly [number, number]
type Cubic = readonly [Point, Point, Point, Point]

/** The art's box in points. The tip sits at the bottom centre. */
export const arrowBox = { width: 110, height: 150 } as const

/** From under the words, a loop to the right, then down onto the input. */
const shaft: ReadonlyArray<Cubic> = [
  [
    [32, 0],
    [40, 46],
    [106, 64],
    [100, 34]
  ],
  [
    [100, 34],
    [94, 6],
    [38, 16],
    [50, 62]
  ],
  [
    [50, 62],
    [56, 92],
    [56, 122],
    [55, 148]
  ]
]

const at = (c: Cubic, t: number): Point => {
  const u = 1 - t
  const f = (i: 0 | 1) => u * u * u * c[0][i] + 3 * u * u * t * c[1][i] + 3 * u * t * t * c[2][i] + t * t * t * c[3][i]
  return [f(0), f(1)]
}

const sample = (curves: ReadonlyArray<Cubic>, per: number): ReadonlyArray<Point> =>
  curves.flatMap((c, j) =>
    Array.from({ length: per + (j === 0 ? 1 : 0) }, (_, i) => at(c, (i + (j === 0 ? 0 : 1)) / per))
  )

/** A pen's unevenness: a slow sum of sines, so the same art comes out every time. */
const wobble = (t: number, seed: number) => 0.32 * Math.sin(t * 23 + seed) + 0.22 * Math.sin(t * 47 + seed * 2.3)

/** A tapered outline around a polyline: `start` and `end` are the width at each end as a share of `width`. */
const outline = (
  points: ReadonlyArray<Point>,
  options: { readonly width: number; readonly start: number; readonly end: number; readonly seed: number }
): string => {
  const left: Array<Point> = []
  const right: Array<Point> = []
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)] ?? p
    const b = points[Math.min(points.length - 1, i + 1)] ?? p
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const dx = (b[0] - a[0]) / length
    const dy = (b[1] - a[1]) / length
    const t = i / (points.length - 1)
    const floor = t < 0.5 ? options.start : options.end
    const half =
      ((options.width * (floor + (1 - floor) * Math.sin(Math.PI * t))) / 2) * (1 + 0.18 * wobble(t, options.seed))
    const shift = 0.5 * wobble(t, options.seed + 5)
    left.push([p[0] - dy * (half + shift), p[1] + dx * (half + shift)])
    right.push([p[0] + dy * (half - shift), p[1] - dx * (half - shift)])
  })
  const all = [...left, ...right.reverse()]
  return `M${all.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`
}

const polyline = (points: ReadonlyArray<Point>) =>
  `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}`

const shaftPoints = sample(shaft, 40)
const tip = shaftPoints[shaftPoints.length - 1] ?? [0, 0]
const before = shaftPoints[shaftPoints.length - 5] ?? tip

/** The direction the stroke ends in, in radians (π/2 is straight down). */
export const arrowHeading = Math.atan2(tip[1] - before[1], tip[0] - before[0])

/** Two flicks from the tip, one a little shorter, each with a slight bend. */
const barbs = (
  [
    [-36, 15],
    [32, 12.5]
  ] as const
).map(([spread, length], j) => {
  const angle = arrowHeading + Math.PI + (spread * Math.PI) / 180
  const bend = j === 0 ? 0.12 : -0.12
  const end: Point = [tip[0] + Math.cos(angle) * length, tip[1] + Math.sin(angle) * length]
  const mid: Point = [tip[0] + Math.cos(angle + bend) * length * 0.55, tip[1] + Math.sin(angle + bend) * length * 0.55]
  return outline(sample([[tip, mid, mid, end]], 16), { width: 2.7, start: 0.9, end: 0.2, seed: 4 + j * 3 })
})

const shaftLength = shaftPoints.reduce(
  (sum, p, i) =>
    i === 0 ? 0 : sum + Math.hypot(p[0] - (shaftPoints[i - 1] ?? p)[0], p[1] - (shaftPoints[i - 1] ?? p)[1]),
  0
)

export const arrowArt = {
  /** The shaft's tapered outline. */
  shaft: outline(shaftPoints, { width: 2.8, start: 0.45, end: 0.6, seed: 4 }),
  /** The head's two flicks. */
  barbs,
  /** The shaft's centre line and its length, for drawing it in. */
  centre: polyline(shaftPoints),
  length: shaftLength,
  tip
} as const
