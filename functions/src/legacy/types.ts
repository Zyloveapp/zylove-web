import { Timestamp } from "firebase-admin/firestore";

export interface UserDoc {
  uid: string;
  name: string;
  age: number;
  gender: "man" | "woman" | "nonbinary";
  mode: "spark" | "play";
  traits: string[];
  values: string[];
  lifestyle: Record<string, string>;
  habits: Record<string, string>;
  loveLanguages: string[];
  weekendVibes: string[];
  intent?: 'spark' | 'play' | 'open';
  lifeStage: string;
  seekingPrefs: {
    gender: string[];
    ageRange: [number, number];
    distance: number;
  };
  physicalPrefs: {
    heightRange?: [number, number];
    bodyTypes?: string[];
    [key: string]: unknown;
  };
  sparkPromptAnswers: {
    green_flag?: string;
    non_negotiable?: string;
    perfect_day?: string;
    five_years?: string;
    controversial?: string;
    dynamic?: string;
  };
  playNonNegotiables: {
    stiScreening?: boolean;
    consentAgreements?: string[];
    limits?: string[];
  };
  photoUrls: string[];
  bioSpark?: string;
  bioPlay?: string;
  verified: boolean;
  behaviorScore: number;
  behaviorGlowSpark: boolean;
  behaviorGlowPlay: boolean;
  likesReceivedCount: number;
  lastThresholdTriggered: number;
  notifyOnLike: boolean;
  phoneNumber?: string;
  displayName?: string;
  photoURLs?: string[];
  bio?: string;
  isFounder?: boolean;
  subscriptionTier?: "free" | "spark_plus" | "play_pass" | "elite";
  deleted?: boolean;
  deletedAt?: Timestamp;
  previousUid?: string;
  restoredAt?: Timestamp;
  visible?: boolean;
  profileUpdatedAt: Timestamp;
}

export interface PairDoc {
  userA: string;
  userB: string;
  createdAt: Timestamp;
  initiatedBy: string;
  sparkScore: number;
  sparkBreakdown: SparkBreakdown;
  playScore: number;
  playBreakdown: PlayBreakdown;
  triggeredDealbreakers?: string[];
  scoreCalculatedAt: Timestamp;
  scoreVersion: number;
  userALiked: boolean;
  userBLiked: boolean;
  matched: boolean;
  matchedAt?: Timestamp;
  tier1Spark?: { archetype: unknown; combinedScore: number; asymmetryGap: number; dataConfidence: number };
}

export interface SparkBreakdown {
  coreFit: number;
  dealbreakers: number;
  valuesIntentions: number;
  physicalPrefs: number;
  loveLanguages: number;
  lifestyle: number;
  personality: number;
}

export interface PlayBreakdown {
  nonNegotiables: number;
  physicalCompatibility: number;
  energyVibe: number;
  intentionsLimits: number;
}

export type BehaviorRating = "positive" | "meh" | "negative";

export interface BehaviorEventDoc {
  ratedBy: string;
  ratedUser: string;
  rating: BehaviorRating;
  trigger: "popup" | "manual";
  messageCount: number;
  pairId: string;
  createdAt: Timestamp;
}

export interface CuratedQueueDoc {
  userId: string;
  date: string;
  mode: "spark" | "play";
  profiles: CuratedProfile[];
  generatedAt: Timestamp;
  seen: boolean[];
}

export interface CuratedProfile {
  uid: string;
  sparkScore: number;
  playScore: number;
  pairId: string;
}

export function pairId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join("_");
}

export const BEHAVIOR_SCORE_FLOOR = 20;
export const BEHAVIOR_SCORE_CEILING = 100;
export const BEHAVIOR_SCORE_DEFAULT = 75;

export const BEHAVIOR_DELTA = {
  positive: +3,
  meh: 0,
  negative: -8,
} as const;

export const GLOW_THRESHOLD = 80;

export const POPUP_THRESHOLDS = {
  woman: { first: 12, topN: 4 },
  man:   { first: 6,  topN: 2 },
} as const;

// ─── Account Status ───────────────────────────────────────────────────────────
export interface DeletedAccountDoc {
  phoneNumber: string;
  previousUid: string;
  deletedAt: Timestamp;
  displayName: string;
  photoURLs: string[];
  bio: string;
  gender: string;
  mode: string;
  behaviorScore: number;
  isFounder: boolean;
  subscriptionTier: string;
  previousPairIds: string[];
}

// ── Profile types (mirrored from src/types/profile.ts)
// WARNING: Keep in sync with src/types/profile.ts until shared package exists

export type DatingIntent = 'spark' | 'play' | 'open'

// ─── Gender Identity ──────────────────────────────────────────────────────────


export type GenderIdentity =
  | 'man' | 'woman' | 'nonbinary' | 'trans_man' | 'trans_woman'
  | 'genderfluid' | 'agender' | 'self_describe'


export type AttractedTo = 'men' | 'women' | 'nonbinary_people' | 'trans_men' | 'trans_women' | 'everyone'


export type RelationshipStatus =
  | 'single'
  | 'divorced'
  | 'open_relationship'
  | 'ethically_non_mono'
  | 'separated'
  | 'married_they_dont_know'
  | 'prefer_not_to_say'


export type OpenTo = 'monogamy' | 'open_relationship' | 'casual' | 'something_that_grows' | 'polyamory' | 'not_sure_yet'


export type BodyType = 'slim' | 'athletic' | 'average' | 'curvy' | 'full_figured' | 'muscular' | 'prefer_not_to_say'


export type LifestyleTag =
  | 'homebody' | 'adventurer' | 'social_butterfly' | 'workaholic'
  | 'creative' | 'outdoorsy' | 'nightlife' | 'wellness_focused' | 'foodie' | 'traveler'


export type HabitTag =
  | 'gym_regular' | 'reader' | 'gamer' | 'cook' | 'music_lover'
  | 'dog_person' | 'cat_person' | 'hiker' | 'meditates'
  | 'drinks_socially' | 'doesnt_drink'
  | 'cigarette_smoker' | 'vaper' | '420_friendly'
  | 'night_owl' | 'early_riser' | 'puzzle_lover' | 'netflix_binger'
  | 'coffee_addict' | 'plant_parent'


export type DrinkingHabit = 'never' | 'socially' | 'regularly' | 'prefer_not_to_say'


export type Religion =
  | 'christian' | 'catholic' | 'jewish' | 'muslim' | 'hindu'
  | 'buddhist' | 'sikh' | 'spiritual' | 'agnostic' | 'atheist'
  | 'other_faith' | 'prefer_not_to_say'


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


export type PersonalityTrait =
  | 'funny' | 'loyal' | 'ambitious' | 'adventurous' | 'caring'
  | 'spontaneous' | 'intellectual' | 'creative' | 'laid_back' | 'passionate'
  | 'independent' | 'empathetic' | 'playful' | 'genuine'
  | 'confident' | 'romantic' | 'sarcastic' | 'wild_card' | 'grounded'


export type RelationshipValue =
  | 'communication' | 'trust' | 'independence' | 'passion' | 'stability'
  | 'spontaneity' | 'ambition' | 'loyalty' | 'humor' | 'spiritual_alignment'
  | 'growth' | 'physical_connection'


export type ParentalStatus = 'has_kids' | 'wants_kids' | 'open_to_kids' | 'child_free' | 'prefer_not_to_say'


export type ConflictStyle = 'direct' | 'process_first' | 'avoid' | 'situational'


export type TogethernessStyle = 'entwined' | 'separate_plus_deep' | 'independent' | 'in_between'


export type StressResponse = 'power_through' | 'step_back' | 'talk_it_out' | 'get_quiet'


export type ParentalCurrent = 'has_kids' | 'no_kids'


export type ParentalIntent =
  | 'wants_first'
  | 'wants_more'
  | 'open_to_more'
  | 'doesnt_want_any'
  | 'doesnt_want_more'
  | 'undecided'


export type LoveLanguage =
  | 'acts_of_service' | 'quality_time' | 'words_of_affirmation'
  | 'physical_touch' | 'gift_giving'


export type WeekendVibe =
  | 'slow_mornings' | 'cook_something_good' | 'out_in_the_city'
  | 'get_outside' | 'live_something' | 'stay_in_with_someone'
  | 'go_somewhere' | 'no_plan' | 'nightlife'
  | 'recharge_solo' | 'create_something' | 'host_people' | 'take_care_of_myself'


export type SeekingTrait =
  | 'ambitious' | 'kind' | 'funny' | 'emotionally_available' | 'independent'
  | 'stable' | 'spontaneous' | 'nurturing' | 'confident' | 'driven'
  | 'gentle' | 'passionate' | 'honest' | 'adventurous' | 'grounded'
  | 'intellectual' | 'protective' | 'affectionate'


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


export type RelationshipStyle = 'monogamous' | 'ethically_non_mono' | 'exploring'


export type PlayStyle = 'solo_play' | 'multi_play' | 'one_time' | 'play_partner' | 'situationship'


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

