// The founding-circle offer, described one way everywhere (invite, Join page,
// Terms, texts). Matches what the code does: functions/src/founders.ts and
// founderActivity.ts.
//
// - Opt-in: in a launch city with a spot open in your half, you're invited.
// - Elite free while you're an active founder, plus a permanent city badge.
// - Stay active during launch or the spot goes to someone else.
// - At 6 months (founderActivity.ts checkOne): circle complete → permanent;
//   not complete → Spark+ free, for good.

export const FOUNDER_CAPACITY_PER_CITY = 100

export const FOUNDER_BENEFITS = (cityName: string) => [
  "Elite access, free, for as long as you're a founder",
  `A ${cityName} Founder badge`,
  'Direct line to the founder',
  'First in line for new features',
]

export const FOUNDER_TERMS_SHORT =
  "Stay active while your city launches to keep your spot. At 6 months, if your city's founding circle is complete, founder status is yours for good; if it isn't, you keep Spark+ free, forever."
