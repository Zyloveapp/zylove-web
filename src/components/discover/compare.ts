import type { DiscoverProfile } from '../../services/discover'
import { lifestyleLabel, loveLanguageLabel, personalityLabel, valueLabel } from './labels'

// What two Spark profiles have in common, from the data already on both docs.
// Shared by ProfileComparison and the "Why this works" rows.
export interface ProfileFacts {
  sharedValues: string[]
  sharedTraits: string[]
  myTraits: string[]
  theirTraits: string[]
  sharedLife: string[]
  onlyMine: string[] // lifestyle tags only I have
  onlyTheirs: string[] // lifestyle tags only they have
  myGive: string[]
  myNeed: string[]
  theirGive: string[]
  theirNeed: string[]
  iGiveTheyNeed: string[] // my give meets their need
  theyGiveINeed: string[] // their give meets my need
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function compareProfiles(me: DiscoverProfile, them: DiscoverProfile): ProfileFacts {
  const myLife = list(me.lifestyleTags)
  const theirLife = list(them.lifestyleTags)
  const myTraits = list(me.personalityTraits)
  const theirTraits = list(them.personalityTraits)
  const myGive = list(me.loveLangGive)
  const myNeed = list(me.loveLangReceive)
  const theirGive = list(them.loveLangGive)
  const theirNeed = list(them.loveLangReceive)
  return {
    sharedValues: list(me.relationshipValues).filter((v) => list(them.relationshipValues).includes(v)),
    sharedTraits: myTraits.filter((t) => theirTraits.includes(t)),
    myTraits,
    theirTraits,
    sharedLife: myLife.filter((t) => theirLife.includes(t)),
    onlyMine: myLife.filter((t) => !theirLife.includes(t)),
    onlyTheirs: theirLife.filter((t) => !myLife.includes(t)),
    myGive,
    myNeed,
    theirGive,
    theirNeed,
    iGiveTheyNeed: myGive.filter((l) => theirNeed.includes(l)),
    theyGiveINeed: theirGive.filter((l) => myNeed.includes(l)),
  }
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

function levelWords(value: number): string {
  if (value >= 90) return 'Strong alignment'
  if (value >= 80) return 'High compatibility'
  if (value >= 70) return 'Good match'
  return 'Moderate'
}

// One "Why this works" sentence per score category. `facts` is null until the
// viewer's own profile has loaded (and in Play), so each case has a fallback
// that doesn't need it.
// `asymmetryBand` is Deep Fit's |A→B − B→A| as a band (F-098: the server
// no longer sends the raw gap): 0 under 5 points, 1 up to 10, 2 up to 20,
// 3 above.
export function whyThisWorks(key: string, value: number, asymmetryBand: number | null, facts: ProfileFacts | null): string {
  switch (key) {
    case 'coreFit':
      if (asymmetryBand === null || asymmetryBand >= 3) return 'Worth exploring — some key differences to discuss'
      if (asymmetryBand === 0) return 'You both lead with depth — fundamentals are tightly aligned'
      if (asymmetryBand === 1) return 'Your foundations are compatible — similar emotional wavelength'
      return 'Compatible at the core, with complementary differences'

    case 'valuesIntentions':
      return facts && facts.sharedValues.length > 0
        ? `You both prioritize ${joinNames(facts.sharedValues.slice(0, 2).map(valueLabel))}`
        : 'Broadly aligned intentions — different paths to similar places'

    // F-098: how well they fit your own physical preferences (never theirs).
    case 'physicalPrefs':
      if (value > 70) return 'They fit what you’re looking for'
      if (value >= 50) return 'Good physical compatibility'
      return 'Some preference differences — worth a conversation'

    case 'loveLanguages': {
      const hasData = facts && facts.myGive.length + facts.myNeed.length > 0 && facts.theirGive.length + facts.theirNeed.length > 0
      if (!facts || !hasData) return value > 70 ? 'Compatible love styles' : 'Different approaches to showing love'
      if (facts.iGiveTheyNeed.length > 0 && facts.theyGiveINeed.length > 0) {
        return "You speak each other's language — rare alignment"
      }
      if (facts.iGiveTheyNeed.length > 0) return `You give what they need — ${loveLanguageLabel(facts.iGiveTheyNeed[0])}`
      if (facts.theyGiveINeed.length > 0) return `They give what you need — ${loveLanguageLabel(facts.theyGiveINeed[0])}`
      return 'Different love styles — but both are valid'
    }

    case 'lifestyle':
      if (facts && facts.sharedLife.length > 0) return `You both: ${facts.sharedLife.slice(0, 2).map(lifestyleLabel).join(' · ')}`
      if (facts && facts.onlyMine.length > 0 && facts.onlyTheirs.length > 0) {
        return `Different energies — ${lifestyleLabel(facts.onlyMine[0])} meets ${lifestyleLabel(facts.onlyTheirs[0])}`
      }
      return 'Compatible rhythms'

    case 'personality':
      if (facts && facts.sharedTraits.length > 0) {
        return `You're both ${joinNames(facts.sharedTraits.slice(0, 2).map(personalityLabel))}`
      }
      if (facts && facts.myTraits.length > 0 && facts.theirTraits.length > 0) {
        return `${personalityLabel(facts.myTraits[0])} meets ${personalityLabel(facts.theirTraits[0])} — you balance each other`
      }
      return 'Compatible personalities'

    // Play categories have no profile-level detail to draw on yet.
    default:
      return levelWords(value)
  }
}
