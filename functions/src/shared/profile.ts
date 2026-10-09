// src/types/profile.ts
//
// Zylove — Complete profile type system

// ─── Core Intent ──────────────────────────────────────────────────────────────

export type DatingIntent = 'spark' | 'play' | 'open'

// ─── Gender Identity ──────────────────────────────────────────────────────────

export type GenderIdentity =
  | 'man' | 'woman' | 'nonbinary' | 'trans_man' | 'trans_woman'
  | 'genderfluid' | 'agender' | 'self_describe'

export const GENDER_LABELS: Record<GenderIdentity, string> = {
  man: 'Man', woman: 'Woman', nonbinary: 'Non-binary',
  trans_man: 'Trans man', trans_woman: 'Trans woman',
  genderfluid: 'Genderfluid', agender: 'Agender',
  self_describe: 'Self-describe',
}
export const GENDER_PRIMARY: GenderIdentity[] = ['man', 'woman']
export const GENDER_MORE: GenderIdentity[] = [
  'nonbinary', 'trans_man', 'trans_woman', 'genderfluid', 'agender', 'self_describe',
]

// Off-map identities explicitly declare which attraction categories they want
// to be surfaced to — "show me to users who are attracted to [men/women/…]".
// Only set when genderIdentity is one of: genderfluid, agender, self_describe.
export const OFF_MAP_GENDER_IDENTITIES: GenderIdentity[] = ['genderfluid', 'agender', 'self_describe']

// ─── Orientation ──────────────────────────────────────────────────────────────

// The "Trans men" / "Trans women" choices were retired (2026-10-09, F-098):
// scoring and Explore read them as men / women, and the A2 migration moved
// stored picks there.
export type AttractedTo = 'men' | 'women' | 'nonbinary_people' | 'everyone'

export const ATTRACTED_TO_LABELS: Record<AttractedTo, string> = {
  men: 'Men', women: 'Women', nonbinary_people: 'Non-binary people',
  everyone: 'Everyone',
}

// ─── Relationship Status ──────────────────────────────────────────────────────

export type RelationshipStatus =
  | 'single'
  | 'divorced'
  | 'open_relationship'
  | 'ethically_non_mono'
  | 'separated'
  | 'married_they_dont_know'
  | 'prefer_not_to_say'

export const RELATIONSHIP_STATUS_LABELS: Record<RelationshipStatus, { label: string; description: string }> = {
  single:                 { label: 'Single',                    description: 'Fully available and ready.' },
  divorced:               { label: 'Divorced',                  description: 'Chapter closed. Starting fresh.' },
  open_relationship:      { label: 'Open relationship',         description: 'In a relationship — open, honest about it.' },
  ethically_non_mono:     { label: 'Ethically non-monogamous',  description: 'Multiple connections, full transparency.' },
  separated:              { label: 'Separated',                 description: 'In transition — being upfront about it.' },
  married_they_dont_know: { label: "Taken — being real about it", description: "Someone's in the picture. Being upfront so you can decide." },
  prefer_not_to_say:      { label: 'Prefer not to say',         description: 'Keeping it private for now.' },
}

// ─── Open To ──────────────────────────────────────────────────────────────────

export type OpenTo = 'monogamy' | 'open_relationship' | 'casual' | 'something_that_grows' | 'polyamory' | 'not_sure_yet'

export const OPEN_TO_LABELS: Record<OpenTo, { label: string; description: string }> = {
  monogamy:             { label: 'Monogamy',             description: 'One person, fully committed.' },
  open_relationship:    { label: 'Open relationship',    description: 'Committed but with agreed freedom.' },
  casual:               { label: 'Casual',               description: 'No strings, good times.' },
  something_that_grows: { label: 'Something that grows', description: 'Start somewhere real, see where it goes.' },
  polyamory:            { label: 'Polyamory',            description: 'Multiple loving relationships, openly.' },
  not_sure_yet:         { label: 'Not sure yet',         description: 'Still figuring it out. Honest about that.' },
}

// ─── Body Type ────────────────────────────────────────────────────────────────

export type BodyType = 'slim' | 'athletic' | 'average' | 'curvy' | 'full_figured' | 'muscular' | 'prefer_not_to_say'

export const BODY_TYPE_LABELS: Record<BodyType, { label: string; emoji: string }> = {
  slim:              { label: 'Slim',             emoji: '🌿' },
  athletic:          { label: 'Athletic',          emoji: '⚡' },
  average:           { label: 'Average',           emoji: '✨' },
  curvy:             { label: 'Curvy',             emoji: '🌸' },
  full_figured:      { label: 'Full-figured',      emoji: '🌺' },
  muscular:          { label: 'Muscular',          emoji: '💪' },
  prefer_not_to_say: { label: 'Prefer not to say', emoji: '—' },
}

// ─── Lifestyle Tags ───────────────────────────────────────────────────────────

export type LifestyleTag =
  | 'homebody' | 'adventurer' | 'social_butterfly' | 'workaholic'
  | 'creative' | 'outdoorsy' | 'nightlife' | 'wellness_focused' | 'foodie' | 'traveler'

export const LIFESTYLE_TAG_LABELS: Record<LifestyleTag, { label: string; emoji: string; description: string }> = {
  homebody:         { label: 'Homebody',         emoji: '🏠', description: 'Happiest at home — cozy nights in over crowded venues any day.' },
  adventurer:       { label: 'Adventurer',        emoji: '🧗', description: 'Loves exploring new places and thrives outside their comfort zone.' },
  social_butterfly: { label: 'Social butterfly',  emoji: '🦋', description: 'Energized by people — always knows everyone in the room.' },
  workaholic:       { label: 'Workaholic',        emoji: '💼', description: 'Driven by their work — ambition is a core part of who they are.' },
  creative:         { label: 'Creative',          emoji: '🎨', description: 'Sees the world differently — always making, building, or imagining something.' },
  outdoorsy:        { label: 'Outdoorsy',         emoji: '🌲', description: 'Feels most alive outside — hiking, camping, or just fresh air.' },
  nightlife:        { label: 'Nightlife',         emoji: '🌙', description: 'Comes alive after dark — dinner, drinks, dancing, late nights.' },
  wellness_focused: { label: 'Wellness focused',  emoji: '🧘', description: 'Intentional about their health — mind and body are a priority.' },
  foodie:           { label: 'Foodie',            emoji: '🍜', description: 'Lives to eat well — always hunting the next great meal or recipe.' },
  traveler:         { label: 'Traveler',          emoji: '✈️', description: 'Always planning the next trip — passport is never far away.' },
}

// ─── Habits ───────────────────────────────────────────────────────────────────

export type HabitTag =
  | 'gym_regular' | 'reader' | 'gamer' | 'cook' | 'music_lover'
  | 'dog_person' | 'cat_person' | 'hiker' | 'meditates'
  | 'drinks_socially' | 'doesnt_drink'
  | 'cigarette_smoker' | 'vaper' | '420_friendly'
  | 'night_owl' | 'early_riser' | 'puzzle_lover' | 'netflix_binger'
  | 'coffee_addict' | 'plant_parent'

export const HABIT_TAG_LABELS: Record<HabitTag, { label: string; emoji: string }> = {
  gym_regular:       { label: 'Gym regular',      emoji: '💪' },
  reader:            { label: 'Reader',            emoji: '📚' },
  gamer:             { label: 'Gamer',             emoji: '🎮' },
  cook:              { label: 'Cook',              emoji: '👨‍🍳' },
  music_lover:       { label: 'Music lover',       emoji: '🎵' },
  dog_person:        { label: 'Dog person',        emoji: '🐶' },
  cat_person:        { label: 'Cat person',        emoji: '🐱' },
  hiker:             { label: 'Hiker',             emoji: '🥾' },
  meditates:         { label: 'Meditates',         emoji: '🧘' },
  drinks_socially:   { label: 'Drinks socially',   emoji: '🍷' },
  doesnt_drink:      { label: "Doesn't drink",     emoji: '🧃' },
  cigarette_smoker:  { label: 'Smoker',            emoji: '🚬' },
  vaper:             { label: 'Vaper',             emoji: '💨' },
  '420_friendly':    { label: '420 friendly',      emoji: '🌿' },
  night_owl:         { label: 'Night owl',         emoji: '🦉' },
  early_riser:       { label: 'Early riser',       emoji: '🌅' },
  puzzle_lover:      { label: 'Puzzle lover',      emoji: '🧩' },
  netflix_binger:    { label: 'Netflix binger',    emoji: '📺' },
  coffee_addict:     { label: 'Coffee addict',     emoji: '☕' },
  plant_parent:      { label: 'Plant parent',      emoji: '🪴' },
}

// ─── Drinking Habit ───────────────────────────────────────────────────────────

export type DrinkingHabit = 'never' | 'socially' | 'regularly' | 'prefer_not_to_say'

export const DRINKING_HABIT_LABELS: Record<DrinkingHabit, { label: string; description: string }> = {
  never:              { label: 'Never',           description: 'Alcohol-free.' },
  socially:           { label: 'Socially',        description: 'A drink here and there — nothing heavy.' },
  regularly:          { label: 'Regularly',       description: 'Part of my routine.' },
  prefer_not_to_say:  { label: 'Prefer not to say', description: '' },
}

// ─── Religion ─────────────────────────────────────────────────────────────────

export type Religion =
  | 'christian' | 'catholic' | 'jewish' | 'muslim' | 'hindu'
  | 'buddhist' | 'sikh' | 'spiritual' | 'agnostic' | 'atheist'
  | 'other_faith' | 'prefer_not_to_say'

export const RELIGION_LABELS: Record<Religion, string> = {
  christian:         'Christian',
  catholic:          'Catholic',
  jewish:            'Jewish',
  muslim:            'Muslim',
  hindu:             'Hindu',
  buddhist:          'Buddhist',
  sikh:              'Sikh',
  spiritual:         'Spiritual (not religious)',
  agnostic:          'Agnostic',
  atheist:           'Atheist',
  other_faith:       'Other faith',
  prefer_not_to_say: 'Prefer not to say',
}

// ─── Politics ─────────────────────────────────────────────────────────────────

export type PoliticalView =
  | 'strong_democrat'
  | 'democrat'
  | 'center_left'
  | 'independent'
  | 'center_right'
  | 'republican'
  | 'strong_republican'
  | 'apolitical'
  | 'prefer_not_to_say'

export const POLITICAL_VIEW_LABELS: Record<PoliticalView, { label: string; description: string }> = {
  strong_democrat:    { label: 'Strong Democrat',    description: 'Progressive values, politically active.' },
  democrat:           { label: 'Democrat',           description: 'Generally left-leaning.' },
  center_left:        { label: 'Center-left',        description: 'Moderate with left-leaning views.' },
  independent:        { label: 'Independent',        description: 'No party loyalty — issue by issue.' },
  center_right:       { label: 'Center-right',       description: 'Moderate with right-leaning views.' },
  republican:         { label: 'Republican',         description: 'Generally right-leaning.' },
  strong_republican:  { label: 'Strong Republican',  description: 'Conservative values, politically active.' },
  apolitical:         { label: 'Apolitical',         description: "Not really my thing." },
  prefer_not_to_say:  { label: 'Prefer not to say',  description: 'Keeping this private.' },
}

// ─── Personality Traits ───────────────────────────────────────────────────────

export type PersonalityTrait =
  | 'funny' | 'loyal' | 'ambitious' | 'adventurous' | 'caring'
  | 'spontaneous' | 'intellectual' | 'creative' | 'laid_back' | 'passionate'
  | 'independent' | 'empathetic' | 'playful' | 'genuine'
  | 'confident' | 'romantic' | 'sarcastic' | 'wild_card' | 'grounded'

export const PERSONALITY_TRAIT_LABELS: Record<PersonalityTrait, string> = {
  funny: 'Funny', loyal: 'Loyal', ambitious: 'Ambitious', adventurous: 'Adventurous',
  caring: 'Caring', spontaneous: 'Spontaneous', intellectual: 'Intellectual',
  creative: 'Creative', laid_back: 'Laid-back', passionate: 'Passionate',
  independent: 'Independent', empathetic: 'Empathetic',
  playful: 'Playful', genuine: 'Genuine', confident: 'Confident',
  romantic: 'Romantic', sarcastic: 'Sarcastic', wild_card: 'Wild card', grounded: 'Grounded',
}

// ─── Relationship Values ──────────────────────────────────────────────────────

export type RelationshipValue =
  | 'communication' | 'trust' | 'independence' | 'passion' | 'stability'
  | 'spontaneity' | 'ambition' | 'loyalty' | 'humor' | 'spiritual_alignment'
  | 'growth' | 'physical_connection'

export const RELATIONSHIP_VALUE_LABELS: Record<RelationshipValue, string> = {
  communication: 'Communication', trust: 'Trust', independence: 'Independence',
  passion: 'Passion', stability: 'Stability', spontaneity: 'Spontaneity',
  ambition: 'Ambition', loyalty: 'Loyalty', humor: 'Humor',
  spiritual_alignment: 'Spiritual alignment', growth: 'Growth',
  physical_connection: 'Physical connection',
}

// ─── Parental Status ──────────────────────────────────────────────────────────

export type ParentalStatus = 'has_kids' | 'wants_kids' | 'open_to_kids' | 'child_free' | 'prefer_not_to_say'

export type ConflictStyle = 'direct' | 'process_first' | 'avoid' | 'situational'
export type TogethernessStyle = 'entwined' | 'separate_plus_deep' | 'independent' | 'in_between'
export type StressResponse = 'power_through' | 'step_back' | 'talk_it_out' | 'get_quiet'

export const CONFLICT_STYLE_LABELS: Record<ConflictStyle, string> = {
  direct:         'Talks it through right away',
  process_first:  'Takes space, then comes back',
  avoid:          'Avoids if possible',
  situational:    'Depends on the situation',
}

export const TOGETHERNESS_STYLE_LABELS: Record<TogethernessStyle, string> = {
  entwined:           'Loves entwined lives',
  separate_plus_deep: 'Strong independence + deep connection',
  independent:        'Highly independent',
  in_between:         'Somewhere in between',
}

export const STRESS_RESPONSE_LABELS: Record<StressResponse, string> = {
  power_through: 'Powers through',
  step_back:     'Steps back to reset',
  talk_it_out:   'Talks it out',
  get_quiet:     'Gets quiet and internal',
}

export const PARENTAL_STATUS_LABELS: Record<ParentalStatus, { label: string; description: string }> = {
  has_kids:          { label: 'I have kids',         description: 'Kids are part of my life.' },
  wants_kids:        { label: 'I want kids someday', description: 'Looking for someone who wants the same.' },
  open_to_kids:      { label: 'Open to kids',        description: 'Not a dealbreaker either way.' },
  child_free:        { label: 'Child-free',          description: "Not for me — and that's firm." },
  prefer_not_to_say: { label: 'Prefer not to say',   description: 'Keeping this private for now.' },
}

export type ParentalCurrent = 'has_kids' | 'no_kids'

export const PARENTAL_CURRENT_LABELS: Record<ParentalCurrent, { label: string; description: string }> = {
  has_kids: { label: 'I have kids',       description: 'Kids are part of my life.' },
  no_kids:  { label: "I don't have kids", description: '' },
}

export type ParentalIntent =
  | 'wants_first'
  | 'wants_more'
  | 'open_to_more'
  | 'doesnt_want_any'
  | 'doesnt_want_more'
  | 'undecided'

export const PARENTAL_INTENT_LABELS: Record<ParentalIntent, { label: string; description: string }> = {
  wants_first:      { label: 'I want them',                        description: 'Looking for someone who wants the same.' },
  wants_more:       { label: 'Yes, I want more',                   description: 'Open to growing the family.' },
  open_to_more:     { label: 'Open to more, not actively seeking', description: 'Depends on the right person.' },
  doesnt_want_any:  { label: "I don't want them",                  description: "That's firm for me." },
  doesnt_want_more: { label: "I don't want more children.",        description: 'Being real about it.' },
  undecided:        { label: "I'm open but unsure",                description: 'Depends on the partner.' },
}

// ─── Love Languages ───────────────────────────────────────────────────────────

export type LoveLanguage =
  | 'acts_of_service' | 'quality_time' | 'words_of_affirmation'
  | 'physical_touch' | 'gift_giving'

export const LOVE_LANGUAGE_LABELS: Record<LoveLanguage, {
  label: string; emoji: string; giveDescription: string; receiveDescription: string
}> = {
  acts_of_service: {
    label: 'Actions speak louder', emoji: '🛠️',
    giveDescription: 'I notice what needs doing and I handle it. Actions over words.',
    receiveDescription: 'They show up and do things without being asked. That hits different.',
  },
  quality_time: {
    label: 'Full attention', emoji: '⏱️',
    giveDescription: "Phone down, fully present. When I'm with you, I'm with you.",
    receiveDescription: 'No phone. No distractions. Just us. That\'s where I feel it.',
  },
  words_of_affirmation: {
    label: 'Say it out loud', emoji: '💬',
    giveDescription: 'Compliments, appreciation, telling them exactly how I feel. I say it.',
    receiveDescription: 'Tell me directly. Say it, mean it, say it again. Words matter to me.',
  },
  physical_touch: {
    label: 'Thoughtful touch', emoji: '🤝',
    giveDescription: 'A hand on their back. A hug that lasts a second longer.',
    receiveDescription: 'Closeness. Touch. Being physically present with me is how I feel loved.',
  },
  gift_giving: {
    label: 'Little surprises', emoji: '🎁',
    giveDescription: 'Remembering things. Showing up with their favorite thing. The details.',
    receiveDescription: 'They remembered what I mentioned once. Thoughtful surprises mean everything.',
  },
}

// ─── Weekend Vibe ─────────────────────────────────────────────────────────────

export type WeekendVibe =
  | 'slow_mornings' | 'cook_something_good' | 'out_in_the_city'
  | 'get_outside' | 'live_something' | 'stay_in_with_someone'
  | 'go_somewhere' | 'no_plan' | 'nightlife'
  | 'recharge_solo' | 'create_something' | 'host_people' | 'take_care_of_myself'

export const WEEKEND_VIBE_LABELS: Record<WeekendVibe, { label: string; emoji: string; description: string }> = {
  slow_mornings:        { label: 'Slow mornings',        emoji: '🌅', description: 'No alarm, nowhere to be.' },
  cook_something_good:  { label: 'Cook something good',  emoji: '🍳', description: "Home cooked meals, trying new recipes, or really good takeout." },
  out_in_the_city:      { label: 'Out in the city',      emoji: '🏙️', description: 'New spot, walk around, see what happens.' },
  get_outside:          { label: 'Get outside',          emoji: '🥾', description: 'Hike, trail, lake, fresh air.' },
  live_something:       { label: 'Live something',       emoji: '🎵', description: 'Concert, show, comedy, event.' },
  stay_in_with_someone: { label: 'Stay in with someone', emoji: '🛋️', description: 'Movie, couch, good company.' },
  go_somewhere:         { label: 'Go somewhere',         emoji: '✈️', description: 'Weekend trip, spontaneous, always packed.' },
  no_plan:              { label: 'No plan',              emoji: '🎲', description: 'See what the day brings, figure it out.' },
  nightlife:            { label: 'Nightlife',            emoji: '🍸', description: 'Dinner, drinks, dancing, late night.' },
  recharge_solo:        { label: 'Recharge solo',        emoji: '📚', description: 'Introvert reset, books, quiet time.' },
  create_something:     { label: 'Create something',     emoji: '🎨', description: 'Art, music, writing, building.' },
  host_people:          { label: 'Host people',          emoji: '🏡', description: 'Dinner party, backyard, your place.' },
  take_care_of_myself:  { label: 'Take care of myself',  emoji: '💪', description: 'Gym, run, sauna, whatever resets you.' },
}

// ─── Seeking Traits ───────────────────────────────────────────────────────────

export type SeekingTrait =
  | 'ambitious' | 'kind' | 'funny' | 'emotionally_available' | 'independent'
  | 'stable' | 'spontaneous' | 'nurturing' | 'confident' | 'driven'
  | 'gentle' | 'passionate' | 'honest' | 'adventurous' | 'grounded'
  | 'intellectual' | 'protective' | 'affectionate'

export const SEEKING_TRAIT_LABELS: Record<SeekingTrait, string> = {
  ambitious: 'Ambitious', kind: 'Kind', funny: 'Funny',
  emotionally_available: 'Emotionally available', independent: 'Independent',
  stable: 'Stable', spontaneous: 'Spontaneous', nurturing: 'Nurturing',
  confident: 'Confident', driven: 'Driven', gentle: 'Gentle',
  passionate: 'Passionate', honest: 'Honest', adventurous: 'Adventurous',
  grounded: 'Grounded', intellectual: 'Intellectual',
  protective: 'Protective', affectionate: 'Affectionate',
}

// ─── Dealbreakers ─────────────────────────────────────────────────────────────

export type Dealbreaker =
  | 'cigarette_smoker'
  | 'vaper'
  | 'heavy_drinker'
  | 'has_kids'
  | 'wants_kids'
  | 'doesnt_want_kids'
  | 'non_exclusive'
  | 'different_religion'
  | 'different_politics'
  | 'partner_doesnt_want_kids'
  | 'partner_wants_kids'
  | 'partner_has_kids'

export const DEALBREAKER_LABELS: Record<Dealbreaker, string> = {
  cigarette_smoker:    'Cigarette smoker',
  vaper:               'Vaper',
  heavy_drinker:       'Heavy drinker',
  has_kids:            'Has kids',
  wants_kids:          'Wants kids',
  doesnt_want_kids:    "Doesn't want kids",
  non_exclusive:       'Non-exclusive only',
  different_religion:  'Very different religious views',
  different_politics:       'Very different political views',
  partner_doesnt_want_kids: "Partner doesn't want kids",
  partner_wants_kids:       'Partner wants kids',
  partner_has_kids:         'Partner has kids from a prior relationship',
}

// ─── Relationship + Play Styles ───────────────────────────────────────────────

export type RelationshipStyle = 'monogamous' | 'ethically_non_mono' | 'exploring'

export const RELATIONSHIP_STYLE_LABELS: Record<RelationshipStyle, { label: string; description: string }> = {
  monogamous:         { label: 'Just us',         description: 'One person, fully committed.' },
  ethically_non_mono: { label: 'ENM',             description: 'Ethically non-monogamous — open and honest.' },
  exploring:          { label: 'Figuring it out', description: 'Still working out what I want.' },
}

export type PlayStyle = 'solo_play' | 'multi_play' | 'one_time' | 'play_partner' | 'situationship'

export const PLAY_STYLE_LABELS: Record<PlayStyle, { label: string; description: string }> = {
  solo_play:     { label: 'One at a time', description: 'Casual but exclusive — one connection at a time.' },
  multi_play:    { label: 'Open roster',   description: 'Keep my options open. Plural is fine.' },
  one_time:      { label: 'One-time play', description: 'No strings, no sequels.' },
  play_partner:  { label: 'Play partner',  description: 'Regular, consistent — just not a relationship.' },
  situationship: { label: 'Situationship', description: 'Somewhere between casual and committed.' },
}

export const INTENT_LABELS: Record<DatingIntent, { label: string; emoji: string; color: string; description: string }> = {
  spark: { label: 'Spark', emoji: '🔵', color: '#1B4FD8', description: 'Here for something real.' },
  play:  { label: 'Play',  emoji: '🔴', color: '#E03131', description: 'Here for fun, fully honest about it.' },
  open:  { label: 'Open',  emoji: '◈',  color: '#1D9E75', description: 'Connection first — labels later.' },
}

// ─── Full Profile ─────────────────────────────────────────────────────────────

export interface DatingProfile {
  uid: string
  displayName: string
  age: number
  birthday?: string
  genderIdentity: GenderIdentity
  genderSelfDescribe?: string
  pronouns?: string
  attractedTo: AttractedTo[]
  // Off-map identities (genderfluid / agender / self_describe) declare which
  // attraction categories they want to be surfaced to. Consulted by
  // prefMatchesGender in scoring when target's genderIdentity is off-map.
  matchableAs?: AttractedTo[]
  // Whether to surface "Interested in: X" on this user's Discover card.
  // Default false (opt-in). Set via profile edit screen.
  showOrientation?: boolean
  // Expo push notification token. Registered on app launch after auth.
  // null = permission declined; undefined = not yet prompted.
  expoPushToken?: string | null
  pushPermissionDeclined?: boolean
  onboardingFeedbackSeen?: boolean
  playNonNegotiables?: import('./dualProfile').PlayNonNegotiable[]
  // Photos flagged by Sightengine moderation (onPhotoUpload Cloud Function).
  // Hidden from Discover until approved by trust-safety review.
  pendingPhotoURLs?: Array<{
    url: string
    flaggedAt: any
    reason: { nudity: number; gore: number; offensive: number }
    approved: boolean
  }>;
  // Timestamp set exactly once — on Slide 2 confirmation modal or via silent
  // retroactive lock on next login for pre-existing users. After it is set,
  // Firestore rules reject any write to birthday, genderIdentity, matchableAs,
  // or identityLockedAt itself. See Commit D (identity immutability).
  identityLockedAt?: any // Firestore Timestamp — loose-typed to avoid admin/client import split
  relationshipStatus: RelationshipStatus
  openTo: OpenTo[]
  bodyType?: BodyType
  heightCm?: number
  intent: DatingIntent
  playStyle?: PlayStyle
  relationshipStyle?: RelationshipStyle
  openToCrossover: boolean
  lifestyleTags: LifestyleTag[]
  habitTags: HabitTag[]
  drinkingHabit?: DrinkingHabit
  religion?: Religion
  politicalView?: PoliticalView
  personalityTraits: PersonalityTrait[]
  relationshipValues: RelationshipValue[]
  weekendVibes: WeekendVibe[]
  weekendVibe?: WeekendVibe
  loveLangGive: LoveLanguage[]
  loveLangReceive: LoveLanguage[]
  bio: string
  bioGeneratedAt?: number
  promptAnswers: PromptAnswer[]
  photoURLs: string[]
  parentalStatus?: ParentalStatus
  parentalCurrent?: ParentalCurrent
  parentalIntent?: ParentalIntent
  conflictStyle?: ConflictStyle
  togethernessStyle?: TogethernessStyle
  stressResponse?: StressResponse
  seekingBodyTypes: BodyType[]
  seekingHeightMinCm?: number
  seekingHeightMaxCm?: number
  seekingTraits: SeekingTrait[]
  dealbreakers: Dealbreaker[]
  geohash: string
  locationLabel: string
  ageMin: number
  ageMax: number
  radiusMiles: number
  verificationStatus: 'unverified' | 'phone_verified' | 'fully_verified' | 'pending_review' | 'failed'
  phoneVerified: boolean
  reportCount: number
  isSuspended: boolean
  subscriptionTier: 'free' | 'spark_plus' | 'play_pass' | 'elite'
  playPassExpiresAt?: number
  createdAt: number
  lastActive: number
  publicKey: string
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

export interface PromptAnswer { promptId: string; answer: string }
export interface ProfilePrompt { id: string; text: string; placeholder: string; intentFilter?: DatingIntent[]; maxLength: number }

export const UNIVERSAL_PROMPTS: ProfilePrompt[] = [
  { id: 'dealbreaker', text: 'My one non-negotiable is…', placeholder: 'Be honest — this one matters', maxLength: 150 },
  { id: 'energy', text: 'My energy at 10pm on a Friday is…', placeholder: 'Netflix coma, rooftop bar, or chaotic third option?', maxLength: 150 },
  { id: 'green_flag', text: 'My biggest green flag is…', placeholder: 'What should someone know before swiping right?', maxLength: 150 },
  { id: 'perfect_day', text: 'My perfect day looks like…', placeholder: 'Start to finish', maxLength: 200 },
]

export const SPARK_PROMPTS: ProfilePrompt[] = [
  { id: 'spark_longterm', text: 'In a relationship I show up as…', placeholder: 'Describe how you love', intentFilter: ['spark', 'open'], maxLength: 200 },
  { id: 'spark_values', text: 'The value I will never compromise on is…', placeholder: "Family, ambition, kindness — what's yours?", intentFilter: ['spark', 'open'], maxLength: 150 },
  { id: 'spark_future', text: 'Five years from now I want to be…', placeholder: "Give me the vision, not the LinkedIn version", intentFilter: ['spark', 'open'], maxLength: 200 },
]

export const PLAY_PROMPTS: ProfilePrompt[] = [
  { id: 'play_vibe', text: "The vibe I'm bringing is…", placeholder: 'Set the tone — what should they expect?', intentFilter: ['play', 'open'], maxLength: 150 },
  { id: 'play_rules', text: 'My one rule is…', placeholder: 'Everyone has one. What\'s yours?', intentFilter: ['play', 'open'], maxLength: 150 },
]

export function getPromptsForIntent(intent: DatingIntent): ProfilePrompt[] {
  if (intent === 'spark') return [...UNIVERSAL_PROMPTS, ...SPARK_PROMPTS]
  if (intent === 'play') return [...UNIVERSAL_PROMPTS, ...PLAY_PROMPTS]
  return [...UNIVERSAL_PROMPTS, ...SPARK_PROMPTS, ...PLAY_PROMPTS]
}

// ─── Height helpers ───────────────────────────────────────────────────────────

export function cmToFeetInches(cm: number): string {
  const totalInches = cm / 2.54
  const feet = Math.floor(totalInches / 12)
  const inches = Math.round(totalInches % 12)
  return `${feet}'${inches}"`
}

export function feetInchesToCm(feet: number, inches: number): number {
  return Math.round((feet * 12 + inches) * 2.54)
}
