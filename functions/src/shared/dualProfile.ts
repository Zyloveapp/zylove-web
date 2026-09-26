// src/types/dualProfile.ts
//
// Dual profile system — every user has two fully independent profiles:
//
//   SparkProfile  — serious dating. Cobalt blue theme. Standard bio + prompts.
//   PlayProfile   — casual/hookup. Red/black theme. Spicy bio + play tags + spice level.
//
// Shared only: uid, verificationStatus, publicKey, geohash, liveMode.
// Everything else — photos, bios, interests, prompts — is 100% independent.
// Firestore paths:
//   users/{uid}/sparkProfile/data
//   users/{uid}/playProfile/data

// ─── Cobalt / Spark Theme ─────────────────────────────────────────────────────

export const SPARK_COLORS = {
  primary:        '#1B4FD8',
  primaryLight:   '#EEF2FF',
  primaryMid:     '#6B8EF0',
  primaryText:    '#1B3BA8',
  accent:         '#1B4FD8',
  accentLight:    '#EEF2FF',
  bg:             '#F8FAFF',
  bgSecondary:    '#EEF2FF',
  surface:        '#FFFFFF',
  text:           '#0F1B4D',
  textSecondary:  '#4B5E9E',
  textTertiary:   '#9BA8CC',
  tabBar:         '#FFFFFF',
  border:         'rgba(27,79,216,0.12)',
  statusBar:      'dark-content' as 'dark-content' | 'light-content',
  rippleTo:       '#0A0A1A',
}

// ─── Play Theme (Red / Black) ─────────────────────────────────────────────────

export const PLAY_COLORS = {
  primary:        '#E03131',
  primaryLight:   '#3A0A0A',
  primaryMid:     '#C92A2A',
  primaryText:    '#FF8787',
  accent:         '#E03131',
  accentLight:    '#2D0808',
  bg:             '#0A0A0A',
  bgSecondary:    '#151515',
  surface:        '#1A1A1A',
  text:           '#F5F5F5',
  textSecondary:  '#A0A0A0',
  textTertiary:   '#555555',
  tabBar:         '#111111',
  border:         'rgba(224,49,49,0.18)',
  statusBar:      'light-content' as 'dark-content' | 'light-content',
  rippleTo:       '#F8FAFF',
}

export type AppTheme = typeof SPARK_COLORS

export function getThemeColors(mode: 'spark' | 'play'): AppTheme {
  return mode === 'play' ? PLAY_COLORS : SPARK_COLORS
}

// ─── Spice Level ──────────────────────────────────────────────────────────────

export type SpiceLevel = 'vanilla' | 'spicy' | 'blindfold' | 'unleashed' | 'no_limits'

export const SPICE_META: Record<SpiceLevel, {
  label: string; emoji: string; color: string; description: string
}> = {
  vanilla:    { label: 'Vanilla',    emoji: '🍦', color: '#1D9E75', description: 'Classic intimacy — sensual, genuine, all the feels' },
  spicy:      { label: 'Spicy',      emoji: '🌶️', color: '#E07B00', description: 'Adventurous and open — I like to explore and try things' },
  blindfold:  { label: 'Blindfold',  emoji: '🎭', color: '#BA7517', description: 'Into anticipation and light power play — trust is everything' },
  unleashed:  { label: 'Unleashed',  emoji: '⛓',  color: '#E03131', description: 'Full spectrum, no holding back — bring your imagination' },
  no_limits:  { label: 'No limits',  emoji: '🔑', color: '#6B0000', description: 'No limits, no judgment — if you know, you know' },
}

export type PlayNonNegotiable =
  | 'recent_sti_screening'
  | 'safe_sex_only'
  | 'singles_only'
  | 'no_chems'
  | 'discreet_required'
  | 'no_emotional_attachment'
  | 'no_threesomes'
  | 'condoms_always'

export const PLAY_NON_NEGOTIABLE_LABELS: Record<PlayNonNegotiable, string> = {
  recent_sti_screening:    'Recent STI screening',
  safe_sex_only:           'Safe sex only',
  singles_only:            'Singles only',
  no_chems:                'No substances',
  discreet_required:       'Discretion required',
  no_emotional_attachment: 'No emotional attachment',
  no_threesomes:           'No threesomes',
  condoms_always:          'Condoms always',
}

// ─── Play Interest Tags ───────────────────────────────────────────────────────

export type PlayInterestTag =
  | 'one_and_done'      | 'fwb'                | 'regular_thing'
  | 'no_strings'        | 'situationship'      | 'open_to_more'
  | 'discreet'          | 'locals_only'        | 'travel_hookup'
  | 'long_distance'     | 'online_only'        | 'sugar_dynamic'
  | 'poly_friendly'     | 'ethically_non_mono'
  | 'kissing'           | 'making_out'         | 'touching'
  | 'oral_giving'       | 'oral_receiving'     | 'oral_both'
  | 'all_the_way'       | 'anal'               | 'mutual_pleasure'
  | 'sexting'           | 'video_fun'          | 'toys'
  | 'massage'           | 'overnight'          | 'multiple_rounds'
  | 'mutual_masturbation' | 'edging'           | 'tantric'
  | 'sensory_play'      | 'body_worship'       | 'pegging'
  | 'sixty_nine'        | 'shower_fun'         | 'public_risk'
  | 'outdoor'
  | 'dom'               | 'sub'                | 'switch_role'
  | 'vanilla_only'      | 'light_bdsm'         | 'role_play'
  | 'exhibitionist'     | 'voyeur'             | 'group_open'
  | 'hard_bdsm'         | 'bondage'            | 'impact_play'
  | 'praise_kink'       | 'degradation'        | 'daddy_dom'
  | 'mommy_dom'         | 'pet_play'           | 'orgasm_control'
  | 'cuckolding'        | 'hotwife'            | 'threesome_mmf'
  | 'threesome_ffm'     | 'rough'              | 'gentle_dom'
  | 'slow_and_sensual'  | 'passionate'         | 'spontaneous'
  | 'adventurous'       | 'communicative'      | 'body_positive'
  | 'sober_play'        | 'chem_friendly'      | 'safe_only'
  | 'high_chemistry_only' | 'emotionally_safe' | 'dirty_talk'
  | 'restraints'        | 'rough_play'         | 'gentle_lover'
  | 'intense'           | 'playful'            | 'teasing'
  | 'eye_contact'       | 'vocal'              | 'quiet_intensity'
  | 'sensory_focused'   | 'connection_first'   | 'purely_physical'
  | 'laugh_during'      | 'takes_charge'       | 'follows_lead'
  | 'both_directions'   | 'no_kissing'
  | 'hotel_preferred'   | 'your_place'         | 'my_place'
  | 'anywhere'          | 'daytime'            | 'late_night'
  | 'weekends_only'     | 'no_overnight'       | 'travel_ok'

export const PLAY_TAG_LABELS: Record<PlayInterestTag, { label: string; emoji: string; category: string }> = {
  one_and_done:         { label: 'One & done',           emoji: '🎯', category: 'arrangement' },
  fwb:                  { label: 'FWB',                   emoji: '🤝', category: 'arrangement' },
  regular_thing:        { label: 'Regular thing',         emoji: '🔄', category: 'arrangement' },
  no_strings:           { label: 'No strings',            emoji: '✂️', category: 'arrangement' },
  situationship:        { label: 'Situationship',         emoji: '🌀', category: 'arrangement' },
  open_to_more:         { label: 'Open to more',          emoji: '🚪', category: 'arrangement' },
  discreet:             { label: 'Discreet',              emoji: '🤫', category: 'arrangement' },
  locals_only:          { label: 'Locals only',           emoji: '📍', category: 'arrangement' },
  travel_hookup:        { label: 'Travel hookup',         emoji: '✈️', category: 'arrangement' },
  long_distance:        { label: 'Long distance ok',      emoji: '🗺️', category: 'arrangement' },
  online_only:          { label: 'Online only',           emoji: '💻', category: 'arrangement' },
  sugar_dynamic:        { label: 'Sugar dynamic',         emoji: '🍬', category: 'arrangement' },
  poly_friendly:        { label: 'Poly friendly',         emoji: '♾️', category: 'arrangement' },
  ethically_non_mono:   { label: 'ENM',                   emoji: '🌈', category: 'arrangement' },
  kissing:              { label: 'Kissing',               emoji: '💋', category: 'acts' },
  making_out:           { label: 'Making out',            emoji: '🔥', category: 'acts' },
  touching:             { label: 'Touching',              emoji: '🤲', category: 'acts' },
  oral_giving:          { label: 'Oral (giving)',         emoji: '⬇️', category: 'acts' },
  oral_receiving:       { label: 'Oral (receiving)',      emoji: '⬆️', category: 'acts' },
  oral_both:            { label: 'Oral (both)',           emoji: '↕️', category: 'acts' },
  all_the_way:          { label: 'All the way',           emoji: '💯', category: 'acts' },
  anal:                 { label: 'Anal',                  emoji: '🍑', category: 'acts' },
  mutual_pleasure:      { label: 'Mutual pleasure',       emoji: '🎭', category: 'acts' },
  sexting:              { label: 'Sexting',               emoji: '📱', category: 'acts' },
  video_fun:            { label: 'Video fun',             emoji: '📹', category: 'acts' },
  toys:                 { label: 'Toys',                  emoji: '🧸', category: 'acts' },
  massage:              { label: 'Massage',               emoji: '💆', category: 'acts' },
  overnight:            { label: 'Overnight ok',          emoji: '🌙', category: 'acts' },
  multiple_rounds:      { label: 'Multiple rounds',       emoji: '🔁', category: 'acts' },
  mutual_masturbation:  { label: 'Mutual pleasure (solo)',emoji: '✨', category: 'acts' },
  edging:               { label: 'Edging',                emoji: '⏳', category: 'acts' },
  tantric:              { label: 'Tantric',               emoji: '🕯️', category: 'acts' },
  sensory_play:         { label: 'Sensory play',          emoji: '👁️', category: 'acts' },
  body_worship:         { label: 'Body worship',          emoji: '🙏', category: 'acts' },
  pegging:              { label: 'Pegging',               emoji: '⚡', category: 'acts' },
  sixty_nine:           { label: '69',                    emoji: '♾️', category: 'acts' },
  shower_fun:           { label: 'Shower fun',            emoji: '🚿', category: 'acts' },
  public_risk:          { label: 'Public risk',           emoji: '👀', category: 'acts' },
  outdoor:              { label: 'Outdoor',               emoji: '🌿', category: 'acts' },
  dom:                  { label: 'Dom',                   emoji: '👑', category: 'dynamic' },
  sub:                  { label: 'Sub',                   emoji: '🎀', category: 'dynamic' },
  switch_role:          { label: 'Switch',                emoji: '🔀', category: 'dynamic' },
  vanilla_only:         { label: 'Vanilla only',          emoji: '🍦', category: 'dynamic' },
  light_bdsm:           { label: 'Light BDSM',            emoji: '🎭', category: 'dynamic' },
  role_play:            { label: 'Role play',             emoji: '🎬', category: 'dynamic' },
  exhibitionist:        { label: 'Exhibitionist',         emoji: '💃', category: 'dynamic' },
  voyeur:               { label: 'Voyeur',                emoji: '🔭', category: 'dynamic' },
  group_open:           { label: 'Open to groups',        emoji: '👥', category: 'dynamic' },
  hard_bdsm:            { label: 'Hard BDSM',             emoji: '⛓️', category: 'dynamic' },
  bondage:              { label: 'Bondage',               emoji: '🪢', category: 'dynamic' },
  impact_play:          { label: 'Impact play',           emoji: '✋', category: 'dynamic' },
  praise_kink:          { label: 'Praise kink',           emoji: '🌟', category: 'dynamic' },
  degradation:          { label: 'Degradation',           emoji: '🖤', category: 'dynamic' },
  daddy_dom:            { label: 'Daddy dom',             emoji: '🦁', category: 'dynamic' },
  mommy_dom:            { label: 'Mommy dom',             emoji: '🌺', category: 'dynamic' },
  pet_play:             { label: 'Pet play',              emoji: '🐾', category: 'dynamic' },
  orgasm_control:       { label: 'Orgasm control',        emoji: '🎮', category: 'dynamic' },
  cuckolding:           { label: 'Cuckolding',            emoji: '♠️', category: 'dynamic' },
  hotwife:              { label: 'Hotwife',               emoji: '♥️', category: 'dynamic' },
  threesome_mmf:        { label: 'Threesome MMF',         emoji: '👨‍👩‍👦', category: 'dynamic' },
  threesome_ffm:        { label: 'Threesome FFM',         emoji: '👩‍👩‍👦', category: 'dynamic' },
  rough:                { label: 'Rough',                 emoji: '💪', category: 'dynamic' },
  gentle_dom:           { label: 'Gentle dom',            emoji: '🕊️', category: 'dynamic' },
  slow_and_sensual:     { label: 'Slow & sensual',        emoji: '🌊', category: 'vibe' },
  passionate:           { label: 'Passionate',            emoji: '❤️‍🔥', category: 'vibe' },
  spontaneous:          { label: 'Spontaneous',           emoji: '⚡', category: 'vibe' },
  adventurous:          { label: 'Adventurous',           emoji: '🏔️', category: 'vibe' },
  communicative:        { label: 'Communicative',         emoji: '💬', category: 'vibe' },
  body_positive:        { label: 'Body positive',         emoji: '💝', category: 'vibe' },
  sober_play:           { label: 'Sober only',            emoji: '🧃', category: 'vibe' },
  chem_friendly:        { label: 'Chem friendly',         emoji: '🍃', category: 'vibe' },
  safe_only:            { label: 'Safe sex only',         emoji: '🛡️', category: 'vibe' },
  high_chemistry_only:  { label: 'High chemistry only',   emoji: '⚗️', category: 'vibe' },
  emotionally_safe:     { label: 'Emotionally safe',      emoji: '🫂', category: 'vibe' },
  dirty_talk:           { label: 'Dirty talk',            emoji: '🗣️', category: 'vibe' },
  restraints:           { label: 'Restraints',            emoji: '🪢', category: 'vibe' },
  rough_play:           { label: 'Rough play',            emoji: '💪', category: 'vibe' },
  gentle_lover:         { label: 'Gentle lover',          emoji: '🕊️', category: 'vibe' },
  intense:              { label: 'Intense',               emoji: '🔥', category: 'vibe' },
  playful:              { label: 'Playful',               emoji: '😈', category: 'vibe' },
  teasing:              { label: 'Teasing',               emoji: '😏', category: 'vibe' },
  eye_contact:          { label: 'Eye contact',           emoji: '👁️', category: 'vibe' },
  vocal:                { label: 'Vocal',                 emoji: '🎙️', category: 'vibe' },
  quiet_intensity:      { label: 'Quiet intensity',       emoji: '🤫', category: 'vibe' },
  sensory_focused:      { label: 'Sensory focused',       emoji: '✨', category: 'vibe' },
  connection_first:     { label: 'Connection first',      emoji: '🔗', category: 'vibe' },
  purely_physical:      { label: 'Purely physical',       emoji: '💥', category: 'vibe' },
  laugh_during:         { label: 'Laugh during',          emoji: '😂', category: 'vibe' },
  takes_charge:         { label: 'Takes charge',          emoji: '👊', category: 'vibe' },
  follows_lead:         { label: 'Follows your lead',     emoji: '🎯', category: 'vibe' },
  both_directions:      { label: 'Goes both ways',        emoji: '🔄', category: 'vibe' },
  no_kissing:           { label: 'No kissing',            emoji: '🚫', category: 'vibe' },
  hotel_preferred:      { label: 'Hotel preferred',       emoji: '🏨', category: 'place' },
  your_place:           { label: 'Your place',            emoji: '🏠', category: 'place' },
  my_place:             { label: 'My place',              emoji: '🏡', category: 'place' },
  anywhere:             { label: 'Anywhere',              emoji: '🌍', category: 'place' },
  daytime:              { label: 'Daytime',               emoji: '☀️', category: 'place' },
  late_night:           { label: 'Late night',            emoji: '🌙', category: 'place' },
  weekends_only:        { label: 'Weekends only',         emoji: '📅', category: 'place' },
  no_overnight:         { label: 'No overnight',          emoji: '🚪', category: 'place' },
  travel_ok:            { label: 'Travel ok',             emoji: '✈️', category: 'place' },
}

// ─── Spark Profile ────────────────────────────────────────────────────────────

export interface SparkProfile {
  uid: string
  displayName: string
  age: number
  pronouns?: string
  genderIdentity: string
  attractedTo: string[]
  locationLabel: string
  geohash: string
  photoURLs: string[]
  bio: string
  promptAnswers: PromptAnswer[]
  interests: string[]
  personalityTags: string[]
  topValues: string[]
  lifestyleTags: string[]
  intent: 'spark'
  relationshipStyle: string
  height?: number
  bodyType?: string
  smokingStatus?: string
  drinkingStatus?: string
  cannabisStatus?: string
  hasKids?: boolean
  wantsKids?: boolean
  radiusMiles: number
  ageMin: number
  ageMax: number
  verificationStatus: string
  publicKey: string
  isActive: boolean
  completeness: number
  createdAt: number
  lastUpdated: number
}

// ─── Play Profile ─────────────────────────────────────────────────────────────

export interface PlayProfile {
  uid: string
  displayName: string
  age: number
  locationLabel: string
  geohash: string
  photoURLs: string[]
  playBio: string
  spiceLevel: SpiceLevel
  playInterestTags: PlayInterestTag[]
  promptAnswers: PromptAnswer[]
  playStyle: string
  radiusMiles: number
  ageMin: number
  ageMax: number
  playNonNegotiables?: PlayNonNegotiable[]
  isActive?: boolean
  completeness?: number
  lastUpdated?: number
}

export interface PromptAnswer {
  promptId: string
  answer: string
}

export interface AppPrompt {
  id: string
  text: string
  placeholder: string
  inspirations?: string[]  // short starter phrases, not full answers
}

// ─── Spark Prompt Bank (20 questions) ────────────────────────────────────────
// 3 shown at random per session. User can swap any for another from the bank.
// No quickFills — replaced with short inspiration sparks via toggle.

export const SPARK_PROMPT_BANK: AppPrompt[] = [
  {
    id: 'green_flag',
    text: 'My biggest green flag…',
    placeholder: 'What makes you a great partner?',
    inspirations: ['I show up the same on bad days', 'I say what I mean', 'I remember the small things'],
  },
  {
    id: 'dealbreaker',
    text: 'My one non-negotiable…',
    placeholder: 'What you won\'t compromise on',
    inspirations: ['Honesty, even when it\'s hard', 'Emotional availability', 'Ambition in some form'],
  },
  {
    id: 'perfect_day',
    text: 'My perfect day looks like…',
    placeholder: 'Walk us through it',
    inspirations: ['Slow morning, no agenda', 'Outside as much as possible', 'Productive until noon then off'],
  },
  {
    id: 'five_years',
    text: 'Five years from now…',
    placeholder: 'Where are you headed?',
    inspirations: ['Work that means something', 'Somewhere warmer', 'Done waiting, actually building'],
  },
  {
    id: 'controversy',
    text: 'My controversial take…',
    placeholder: 'Something you genuinely believe',
    inspirations: ['Most people settle out of fear', 'Texting killed getting to know someone', 'Chemistry isn\'t enough'],
  },
  {
    id: 'misunderstood',
    text: 'People always misread me as…',
    placeholder: 'What do people get wrong about you at first?',
    inspirations: ['Intimidating when I\'m just focused', 'Quiet when I\'m actually observing', 'Reserved until I\'m not'],
  },
  {
    id: 'proud_of',
    text: 'Something I\'m genuinely proud of…',
    placeholder: 'Doesn\'t have to be impressive — just real',
    inspirations: ['How far I\'ve come in the last year', 'A relationship I handled with integrity', 'Building something from nothing'],
  },
  {
    id: 'learned_hard_way',
    text: 'Something I learned the hard way…',
    placeholder: 'What changed how you see things?',
    inspirations: ['Not everyone deserves access to you', 'Timing matters as much as feelings', 'You can\'t logic someone into caring'],
  },
  {
    id: 'recharge',
    text: 'The way I recharge is…',
    placeholder: 'Introvert, extrovert, somewhere in between?',
    inspirations: ['Completely alone with no agenda', 'One good conversation', 'Moving my body somewhere quiet'],
  },
  {
    id: 'love_looks_like',
    text: 'To me, love looks like…',
    placeholder: 'Concrete, specific, yours',
    inspirations: ['Showing up when it\'s inconvenient', 'Remembering the details', 'Making someone feel chosen every day'],
  },
  {
    id: 'unusual_skill',
    text: 'A skill I have that surprises people…',
    placeholder: 'Could be anything — the weirder the better',
    inspirations: ['I can read a room instantly', 'I cook one thing exceptionally well', 'I remember everything I read'],
  },
  {
    id: 'how_i_argue',
    text: 'When we disagree, I\'ll…',
    placeholder: 'How do you handle conflict?',
    inspirations: ['Say what I think directly', 'Need an hour to process then talk', 'Ask more questions than I answer'],
  },
  {
    id: 'current_obsession',
    text: 'Right now I can\'t stop thinking about…',
    placeholder: 'What has your attention lately?',
    inspirations: ['A book I can\'t put down', 'A problem I\'m trying to solve', 'Something I just started learning'],
  },
  {
    id: 'at_my_best',
    text: 'I\'m at my best when…',
    placeholder: 'What conditions bring out the best version of you?',
    inspirations: ['I have space to think', 'I\'m challenged by the people around me', 'I have a clear goal'],
  },
  {
    id: 'friendship_test',
    text: 'To be my friend you have to…',
    placeholder: 'What do you require from your inner circle?',
    inspirations: ['Be honest even when I don\'t want to hear it', 'Show up when things aren\'t convenient', 'Have your own thing going on'],
  },
  {
    id: 'what_i_want',
    text: 'What I actually want from this…',
    placeholder: 'Be specific — vague answers help no one',
    inspirations: ['Someone to build something real with', 'A partner who challenges me', 'Connection that doesn\'t feel like work'],
  },
  {
    id: 'tell_me_something',
    text: 'Something most people don\'t know about me…',
    placeholder: 'The thing that surprises people when they find out',
    inspirations: ['I grew up completely different from how I present', 'I changed course completely at some point', 'I have a very different private life'],
  },
  {
    id: 'dating_philosophy',
    text: 'My dating philosophy in one line…',
    placeholder: 'What guides how you approach this?',
    inspirations: ['Go slow or don\'t go at all', 'Better to be honest early than kind late', 'I\'d rather be alone than settle'],
  },
  {
    id: 'morning_or_night',
    text: 'I\'m a morning person or a night person and here\'s why…',
    placeholder: 'More interesting than it sounds if you actually answer it',
    inspirations: ['Morning — everything important happens before noon', 'Night — I come alive when the pressure\'s off', 'Neither — I\'m a nap person'],
  },
  {
    id: 'the_ask',
    text: 'The right person to match with me…',
    placeholder: 'What would make someone exactly right for you?',
    inspirations: ['Knows what they want and says it', 'Has a life they\'re genuinely excited about', 'Is done playing games'],
  },
]

// ─── Play Prompt Bank (18 questions) ─────────────────────────────────────────
// 3 shown at random per session. User can swap any for another from the bank.

export const PLAY_PROMPT_BANK: AppPrompt[] = [
  {
    id: 'play_vibe',
    text: 'The vibe I bring is…',
    placeholder: 'Set the tone — what should they expect?',
    inspirations: ['Confident and attentive', 'Spontaneous and unpredictable', 'Slow and deliberate'],
  },
  {
    id: 'play_rules',
    text: 'My one rule is…',
    placeholder: 'Everyone has one. What is yours?',
    inspirations: ['Communication first', 'Mutual respect always', 'Consent is ongoing'],
  },
  {
    id: 'play_after',
    text: 'After, I want to…',
    placeholder: 'Leave? Stay? Grab food? No judgment',
    inspirations: ['Order food and debrief', 'Stay for a bit', 'Depends entirely on the energy'],
  },
  {
    id: 'play_ideal',
    text: 'My ideal scenario is…',
    placeholder: 'Paint the picture',
    inspirations: ['Hotel, no agenda, full night', 'Your place, something to drink, zero pressure', 'Completely unplanned'],
  },
  {
    id: 'play_opener',
    text: 'The best way to get my attention is…',
    placeholder: 'What actually works on you?',
    inspirations: ['Make me laugh', 'Be direct about what you want', 'Prove you read my profile'],
  },
  {
    id: 'play_limits',
    text: 'What I\'m not into is…',
    placeholder: 'Limits matter — be upfront',
    inspirations: ['Anything undiscussed', 'Rushing with no build-up', 'Flaking after committing'],
  },
  {
    id: 'play_chemistry',
    text: 'I know we have chemistry when…',
    placeholder: 'What\'s the signal for you?',
    inspirations: ['The conversation doesn\'t slow down', 'There\'s tension before anything happens', 'I forget what time it is'],
  },
  {
    id: 'play_morning_after',
    text: 'The morning after, I\'m the type to…',
    placeholder: 'Honest answer only',
    inspirations: ['Make coffee and stay a while', 'Disappear gracefully', 'Ask if you\'re hungry'],
  },
  {
    id: 'play_dealbreaker',
    text: 'Instant dealbreaker for me is…',
    placeholder: 'What ends it before it starts?',
    inspirations: ['Bad hygiene', 'Lying about availability', 'Not being able to communicate directly'],
  },
  {
    id: 'play_communicate',
    text: 'During, I communicate by…',
    placeholder: 'How do you check in and respond?',
    inspirations: ['Saying exactly what I want', 'Reading the room and adjusting', 'Asking before switching anything up'],
  },
  {
    id: 'play_first_move',
    text: 'I\'m the type to make the first move…',
    placeholder: 'When, how, and what that looks like',
    inspirations: ['Always — I don\'t wait', 'When the signal is clear', 'Never — I prefer to be pursued'],
  },
  {
    id: 'play_fantasy',
    text: 'Something I\'ve always wanted to try…',
    placeholder: 'Keep it tasteful or go all in — your call',
    inspirations: ['Something that requires complete trust', 'Something location-specific', 'Something I\'ve thought about more than once'],
  },
  {
    id: 'play_confidence',
    text: 'What makes me confident in this space is…',
    placeholder: 'What do you bring to the table?',
    inspirations: ['I know what I want and say it', 'I pay attention to what works for the other person', 'I\'ve put in the time to know myself'],
  },
  {
    id: 'play_surprise',
    text: 'Something that might surprise you about me…',
    placeholder: 'The thing that doesn\'t match the profile',
    inspirations: ['I\'m completely different in person', 'I\'m more selective than I look', 'I take this seriously even if it\'s casual'],
  },
  {
    id: 'play_non_negotiable',
    text: 'Before anything happens, I need to know…',
    placeholder: 'What do you need established first?',
    inspirations: ['We\'re both on the same page about what this is', 'You\'re actually available', 'There\'s genuine mutual attraction, not just convenience'],
  },
  {
    id: 'play_type',
    text: 'My type in this context is…',
    placeholder: 'Honest — what are you actually drawn to here?',
    inspirations: ['Someone who takes charge without being asked', 'Someone who follows my lead', 'Someone who knows when to switch'],
  },
  {
    id: 'play_best_experience',
    text: 'The best experiences I\'ve had started with…',
    placeholder: 'What conditions made it work?',
    inspirations: ['Zero expectations going in', 'Genuine conversation before anything physical', 'Someone who was completely present'],
  },
  {
    id: 'play_worth_it',
    text: 'You\'ll know it was worth it when…',
    placeholder: 'What\'s the measure of success for you?',
    inspirations: ['We both leave satisfied', 'We actually want to do it again', 'Nobody regrets anything'],
  },
]

// ─── Backwards compatibility exports ─────────────────────────────────────────
// Keep SPARK_PROMPTS and PLAY_PROMPTS pointing to the first 5/6 of each bank
// so existing code that imports them doesn't break.

export const SPARK_PROMPTS = SPARK_PROMPT_BANK.slice(0, 5)
export const PLAY_PROMPTS  = PLAY_PROMPT_BANK.slice(0, 6)

// ─── Prompt selection helpers ─────────────────────────────────────────────────

// Returns 3 random prompts from the bank, deterministic per uid so
// the same user sees the same 3 questions if they re-enter the step.
export function selectSparkPrompts(uid: string): AppPrompt[] {
  return seededSample(SPARK_PROMPT_BANK, 3, uid + '-spark')
}

export function selectPlayPrompts(uid: string): AppPrompt[] {
  return seededSample(PLAY_PROMPT_BANK, 3, uid + '-play')
}

// Simple seeded shuffle — same seed always produces same result
function seededSample<T>(arr: T[], n: number, seed: string): T[] {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i)
    hash |= 0
  }
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    hash = ((hash << 5) - hash) + i
    hash |= 0
    const j = Math.abs(hash) % (i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}

// ─── Dual profile meta ────────────────────────────────────────────────────────

export const PLAY_TAG_CATEGORY_LABELS: Record<string, { label: string; emoji: string }> = {
  arrangement: { label: 'What I am here for', emoji: '🎯' },
  acts:        { label: 'What I am into',     emoji: '🔥' },
  dynamic:     { label: 'How I like it',      emoji: '⚡' },
  vibe:        { label: 'My vibe',            emoji: '✨' },
  place:       { label: 'Where I play',       emoji: '📍' },
}

export interface DualProfileMeta {
  uid: string
  hasSparkProfile: boolean
  hasPlayProfile: boolean
  activeMode: 'spark' | 'play'
  lastSwitched: number
}
