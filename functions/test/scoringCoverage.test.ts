// Every answer the web onboarding offers must mean something to the scoring
// engine. An unmapped answer is silently dropped — it reads as a blank — so
// when the app adds an option, this fails until the option is mapped
// (functions/src/legacy/tier1/traitToFacetMap.ts) or listed below as
// deliberately unscored.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as maps from '../src/legacy/tier1/traitToFacetMap'

// The web app's answer types (what onboarding can save). Runs from
// functions/.test-build/test.
const WEB_TYPES = readFileSync(join(__dirname, '../../../src/types/profile.ts'), 'utf8')

function webOptions(typeName: string): string[] {
  const m = WEB_TYPES.match(new RegExp(`export type ${typeName}\\s*=([^;]*?)(?=\\n\\s*\\n|\\nexport )`, 's'))
  if (!m) throw new Error(`type ${typeName} not found in src/types/profile.ts`)
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
}

// Answers that intentionally carry no facet signal.
const UNSCORED = new Set(['prefer_not_to_say', 'unsure'])

const CASES: [string, Readonly<Record<string, unknown>>][] = [
  ['PersonalityTrait', maps.PERSONALITY_TRAIT_FACET_MAP],
  ['RelationshipValue', maps.RELATIONSHIP_VALUE_FACET_MAP],
  ['LifestyleTag', maps.LIFESTYLE_TAG_FACET_MAP],
  ['WeekendVibe', maps.WEEKEND_VIBE_FACET_MAP],
  ['HabitTag', maps.HABIT_TAG_FACET_MAP],
  ['LoveLanguage', maps.LOVE_LANG_GIVE_FACET_MAP],
  ['ConflictStyle', maps.CONFLICT_STYLE_FACET_MAP],
  ['TogethernessStyle', maps.TOGETHERNESS_STYLE_FACET_MAP],
  ['StressResponse', maps.STRESS_RESPONSE_FACET_MAP],
  ['ParentalCurrent', maps.PARENTAL_CURRENT_FACET_MAP],
  ['ParentalIntent', maps.PARENTAL_INTENT_FACET_MAP],
  ['Dealbreaker', maps.DEALBREAKER_REPULSION_MAP],
]

for (const [typeName, map] of CASES) {
  test(`every ${typeName} option is mapped`, () => {
    const options = webOptions(typeName)
    assert.ok(options.length > 0, `no options parsed for ${typeName}`)
    const unmapped = options.filter((o) => !UNSCORED.has(o) && !(o in map))
    assert.deepEqual(unmapped, [], `${typeName} options the engine ignores: ${unmapped.join(', ')}`)
  })
}
