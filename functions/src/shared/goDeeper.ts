// Mirrors src/components/onboarding/types.ts in the web app — keep in sync.

export const CONFLICT_STYLE_LABELS: Record<string, string> = {
  direct: 'Talks it through right away',
  process_first: 'Takes space, then comes back',
  avoid: 'Avoids if possible',
  situational: 'Depends on the situation',
}

export const TOGETHERNESS_STYLE_LABELS: Record<string, string> = {
  entwined: 'I love an entwined life',
  separate_plus_deep: 'Independent, but deeply connected',
  independent: 'I need a lot of independence',
  in_between: 'Somewhere in between',
}

export const STRESS_RESPONSE_LABELS: Record<string, string> = {
  power_through: 'I power through',
  step_back: 'I step back to reset',
  talk_it_out: 'I talk it out',
  get_quiet: 'I get quiet and internal',
}
