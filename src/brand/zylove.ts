// src/brand/zylove.ts
//
// Zylove — Match your energy.
//
// Single source of truth for all brand copy, colors, and identity.
// Import from here rather than hardcoding strings anywhere in the app.

// ─── Identity ─────────────────────────────────────────────────────────────────

export const BRAND = {
  name:           'Zylove',
  tagline:        'Match your energy.',
  taglineShort:   'Your energy. Your match.',
  description:    'Two sides. One you. Find people who match where you are right now.',

  // Mode names — these are permanent UX labels, not marketing copy
  sparkModeName:  'Spark',      // serious dating mode
  playModeName:   'Play',       // casual / adult mode

  // Score system
  scoreName:      'Zylove Score',
  scoreTagline:   'Your reputation, earned.',

  // Legal
  companyName:    'Zylove, LLC',
  supportEmail:   'support@zylove.app',
  privacyUrl:     'https://zylove.app/privacy',
  termsUrl:       'https://zylove.app/terms',
} as const

// ─── Mode labels ──────────────────────────────────────────────────────────────

export const MODE_LABELS = {
  spark: {
    name:        'Spark',
    emoji:       '🔵',
    tagline:     'Here for something real.',
    description: 'Serious dating. Genuine connections. People worth your time.',
    color:       '#1B4FD8',
    toggle:      '🔵 Spark',
  },
  play: {
    name:        'Play',
    emoji:       '🔴',
    tagline:     'Here for a good time.',
    description: 'Casual, honest, and on your terms. No games — just real people being real.',
    color:       '#E03131',
    toggle:      '🔴 Play',
  },
} as const

// ─── Zylove Score tiers ────────────────────────────────────────────────────────

export const ZYLOVE_SCORE_TIERS = {
  new:      { label: 'New',      emoji: '🌱', minScore: 0  },
  building: { label: 'Building', emoji: '📈', minScore: 40 },
  good:     { label: 'Good',     emoji: '👍', minScore: 60 },
  great:    { label: 'Great',    emoji: '⭐', minScore: 75 },
  trusted:  { label: 'Trusted',  emoji: '🛡', minScore: 85 },
  elite:    { label: 'Elite',    emoji: '✦',  minScore: 95 },
} as const

// ─── Onboarding copy ──────────────────────────────────────────────────────────

export const ONBOARDING_COPY = {
  welcome: {
    title:    'Dating, on your terms.',
    subtitle: 'Whether you\'re chasing something real or just a really good time — you\'re in the right place.',
    honesty:  'No judgment. No pressure. Just honesty.',
    cta:      'Let\'s do this',
  },
  intent: {
    title:    'What are you here for?',
    preamble: 'We keep it real here. Your answer puts you with people who want the same thing — so nobody wastes anybody\'s time.',
    privacy:  'Serious daters won\'t see casual profiles (and vice versa) unless you both opt in. Choose honestly.',
    cta:      'This is me',
  },
  seeking: {
    title:    'Let\'s find your kind of person.',
    privacy:  'Your answers are completely private. Nobody who likes you will ever see your preferences or know their score. We use this to quietly filter your likes so the best ones surface first.',
    cta:      'Let\'s go',
  },
  liveness: {
    title:    'Quick identity check',
    subtitle: 'We\'ll ask you to do 2 simple gestures on camera to confirm you\'re a real person. Takes about 15 seconds.',
    privacy1: 'Your video is processed on-device',
    privacy2: 'Only a single frame is uploaded for review',
    privacy3: 'Never stored or shared with third parties',
    cta:      'Start check',
    skip:     'Do this later',
  },
  done: {
    title:    'You\'re all set.',
    subtitle: 'Time to verify your account and start meeting people.',
    cta:      'Go to my profile',
  },
} as const

// ─── Empty states ─────────────────────────────────────────────────────────────

export const EMPTY_STATES = {
  discover:    { emoji: '🌸', title: 'You\'re all caught up', subtitle: 'Try expanding your distance filter' },
  topPicks:      { emoji: '✦',  title: 'No top matches yet',   subtitle: 'As likes come in, we\'ll rank the best ones here. Refresh when you\'re ready.' },
  allLikes:    { emoji: '🌸', title: 'No likes yet',          subtitle: 'When someone likes you, they\'ll show up here.' },
  matches:     { emoji: '💬', title: 'No matches yet',        subtitle: 'Like someone back to start a conversation.' },
  noProfiles:  { emoji: '📍', title: 'Nobody nearby',         subtitle: 'Try expanding your distance or adjusting your filters.' },
} as const

// ─── Notification copy ────────────────────────────────────────────────────────

export const NOTIFICATION_COPY = {
  newMatch:         (name: string) => `It\'s a match! You and ${name} liked each other 💕`,
  newMessage:       (name: string) => `${name} sent you a message`,
  likeExpiring:     'Your like is about to expire ⏳ — this is your one reminder.',
  topMatchExpiring: 'A great match is expiring soon. Check your Top 10.',
  reviewReceived:   'You received a new Zylove Score review.',
  verifiedBadge:    'Your identity has been verified ✓ — your profile is now fully active.',
} as const

// ─── Feature names (for UI labels) ───────────────────────────────────────────

export const FEATURE_NAMES = {
  topPicks:       'Top 10',
  zyloveScore:   'Zylove Score',
  trustedBadge: 'Trusted',
  forYou:       'For You',
} as const
