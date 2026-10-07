// A reference population of Spark profiles built from the web onboarding's
// own answer options, for calibrating (scripts/calibrate-scores.mjs) and
// testing the scoring engine. Seeded,
// so every run sees the same people. Answer counts follow onboarding (pick 3
// traits, 3 values, …); `blankShare` of people skip the optional questions.

export const OPTIONS = {
  personalityTraits: ['funny', 'loyal', 'ambitious', 'adventurous', 'caring', 'spontaneous', 'intellectual', 'creative', 'laid_back', 'passionate', 'independent', 'empathetic', 'playful', 'genuine', 'confident', 'romantic', 'sarcastic', 'wild_card', 'grounded'],
  relationshipValues: ['communication', 'trust', 'independence', 'passion', 'stability', 'spontaneity', 'ambition', 'loyalty', 'humor', 'spiritual_alignment', 'growth', 'physical_connection'],
  lifestyleTags: ['homebody', 'adventurer', 'social_butterfly', 'workaholic', 'creative', 'outdoorsy', 'nightlife', 'wellness_focused', 'foodie', 'traveler'],
  weekendVibes: ['slow_mornings', 'cook_something_good', 'out_in_the_city', 'get_outside', 'live_something', 'stay_in_with_someone', 'go_somewhere', 'no_plan', 'nightlife', 'recharge_solo', 'create_something', 'host_people', 'take_care_of_myself'],
  habitTags: ['gym_regular', 'reader', 'gamer', 'cook', 'music_lover', 'dog_person', 'cat_person', 'hiker', 'meditates', 'drinks_socially', 'doesnt_drink', 'cigarette_smoker', 'vaper', '420_friendly', 'night_owl', 'early_riser', 'puzzle_lover', 'netflix_binger', 'coffee_addict', 'plant_parent'],
  loveLanguages: ['words_of_affirmation', 'acts_of_service', 'physical_touch', 'quality_time', 'gift_giving'],
  conflictStyle: ['direct', 'process_first', 'avoid', 'situational'],
  togethernessStyle: ['entwined', 'separate_plus_deep', 'independent', 'in_between'],
  stressResponse: ['power_through', 'step_back', 'talk_it_out', 'get_quiet'],
  parentalCurrent: ['no_kids', 'has_kids'],
  parentalIntent: ['wants_first', 'open_to_more', 'doesnt_want_any', 'doesnt_want_more', 'unsure'],
  bodyType: ['slim', 'athletic', 'average', 'curvy', 'muscular'],
  religion: ['christian', 'catholic', 'spiritual', 'agnostic', 'atheist', 'jewish'],
  politicalView: ['liberal', 'center_left', 'moderate', 'center_right', 'conservative', 'apolitical'],
}

export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

export type Profile = Record<string, unknown>

export function person(
  rnd: () => number,
  gender: 'man' | 'woman',
  { blankShare = 0, dealbreakers = false }: { blankShare?: number; dealbreakers?: boolean } = {},
): Profile {
  const one = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const pick = <T>(a: readonly T[], n: number): T[] => {
    const c = [...a]
    const out: T[] = []
    while (out.length < n && c.length) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0])
    return out
  }
  const age = 24 + Math.floor(rnd() * 16)
  const p: Profile = {
    genderIdentity: gender,
    attractedTo: [gender === 'man' ? 'women' : 'men'],
    age, ageMin: age - 6, ageMax: age + 6,
    intent: one(['spark', 'spark', 'open']),
    bodyType: one(OPTIONS.bodyType),
    heightCm: gender === 'man' ? 165 + Math.floor(rnd() * 25) : 152 + Math.floor(rnd() * 23),
    religion: one(OPTIONS.religion),
    politicalView: one(OPTIONS.politicalView),
  }
  if (rnd() < 0.5) p.seekingBodyTypes = pick(OPTIONS.bodyType, 2 + Math.floor(rnd() * 2))
  if (rnd() < 0.3) Object.assign(p, gender === 'man' ? { seekingHeightMinCm: 150, seekingHeightMaxCm: 175 } : { seekingHeightMinCm: 170, seekingHeightMaxCm: 196 })
  if (dealbreakers && rnd() < 0.4) p.dealbreakers = pick(['cigarette_smoker', 'vaper', 'heavy_drinker', 'different_politics', 'different_religion', 'has_kids'], 1)
  if (rnd() < blankShare) return p
  return Object.assign(p, {
    personalityTraits: pick(OPTIONS.personalityTraits, 3),
    relationshipValues: pick(OPTIONS.relationshipValues, 3),
    lifestyleTags: pick(OPTIONS.lifestyleTags, 3),
    weekendVibes: pick(OPTIONS.weekendVibes, 3),
    habitTags: pick(OPTIONS.habitTags, 4),
    loveLangGive: pick(OPTIONS.loveLanguages, 2),
    loveLangReceive: pick(OPTIONS.loveLanguages, 2),
    conflictStyle: one(OPTIONS.conflictStyle),
    togethernessStyle: one(OPTIONS.togethernessStyle),
    stressResponse: one(OPTIONS.stressResponse),
    parentalCurrent: one(OPTIONS.parentalCurrent),
    parentalIntent: one(OPTIONS.parentalIntent),
    drinkingHabit: one(['never', 'socially', 'socially', 'regularly']),
  })
}

export function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
}
