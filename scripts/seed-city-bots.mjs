// Seed 40 more bots for Dallas and Houston (10 women + 10 men each), in the
// same shape as the Austin pool (dating-app-2/scripts/seedBots.ts): a full
// Spark root doc plus users/{uid}/playProfile/data.
//
//   node scripts/seed-city-bots.mjs --dry-run           list what would be written
//   node scripts/seed-city-bots.mjs --apply             write them
//   node scripts/seed-city-bots.mjs --apply --photos=map.json
//                                                       photos from a { uid: [urls] } file
//
// Photos: by default each new bot copies the current photoURLs of one Austin
// bot (Dallas w-00N ← zbot-w-00N, Houston w-00N ← zbot-w-0(10+N); men the
// same), read at run time — so run it after the Austin photos are replaced.
// No face repeats among the new bots, but every face also belongs to an
// Austin bot, and bots show to everyone in Explore. --photos overrides per bot.
//
// Create-only: a uid that already exists is skipped, never overwritten.
// Every enum value here is one the Austin bots already use. Credentials as
// in init-cities.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app')
const { FieldValue, getFirestore } = require('firebase-admin/firestore')

const SERVICE_ACCOUNT = join(homedir(), 'Desktop/Zylove/dating-app-2/firebase/zylove-service-account.json')
const apply = process.argv.includes('--apply')
const photosArg = process.argv.find((a) => a.startsWith('--photos='))?.slice('--photos='.length)
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('Pass --dry-run or --apply')
  process.exit(1)
}

const CITIES = {
  dal: { label: 'Dallas, TX', lat: 32.7767, lng: -96.797 },
  hou: { label: 'Houston, TX', lat: 29.7604, lng: -95.3698 },
}
const TODAY = new Date('2026-10-04T00:00:00Z')

// ─── Archetypes: the tag sets (Spark + Play) a persona builds on ─────────────

const ARCHETYPES = {
  driven: {
    lifestyleTags: ['workaholic', 'traveler', 'foodie'],
    habitTags: ['gym_regular', 'coffee_addict', 'early_riser'],
    personalityTraits: ['ambitious', 'driven', 'confident', 'genuine'],
    relationshipValues: ['ambition', 'growth', 'communication'],
    weekendVibes: ['out_in_the_city', 'take_care_of_myself', 'go_somewhere'],
    conflictStyle: 'direct', togethernessStyle: 'separate_plus_deep', stressResponse: 'power_through',
    seekingTraits: ['ambitious', 'honest', 'emotionally_available', 'driven'],
    spiceLevel: 'spicy', playInterestTags: ['connection_first', 'intense', 'eye_contact', 'communicative', 'regular_thing'],
    playPrompts: [
      ['play_rules', 'Say what you want. I respect directness more than anything.'],
      ['play_vibe', 'Focused. When I am in, I am all the way in.'],
    ],
  },
  outdoorsy: {
    lifestyleTags: ['outdoorsy', 'adventurer', 'wellness_focused'],
    habitTags: ['hiker', 'early_riser', 'dog_person', 'cook'],
    personalityTraits: ['grounded', 'genuine', 'laid_back', 'loyal'],
    relationshipValues: ['trust', 'loyalty', 'growth'],
    weekendVibes: ['get_outside', 'slow_mornings', 'cook_something_good'],
    conflictStyle: 'situational', togethernessStyle: 'entwined', stressResponse: 'step_back',
    seekingTraits: ['kind', 'grounded', 'honest', 'affectionate'],
    spiceLevel: 'vanilla', playInterestTags: ['slow_and_sensual', 'kissing', 'touching', 'connection_first', 'situationship'],
    playPrompts: [
      ['play_chemistry', 'When it feels easy. No performance, just two people who like each other.'],
      ['play_after', 'Stay for breakfast. I make good eggs.'],
    ],
  },
  social: {
    lifestyleTags: ['social_butterfly', 'nightlife', 'foodie'],
    habitTags: ['music_lover', 'night_owl', 'coffee_addict'],
    personalityTraits: ['playful', 'spontaneous', 'confident', 'passionate'],
    relationshipValues: ['spontaneity', 'passion', 'humor'],
    weekendVibes: ['nightlife', 'live_something', 'host_people'],
    conflictStyle: 'direct', togethernessStyle: 'in_between', stressResponse: 'talk_it_out',
    seekingTraits: ['funny', 'spontaneous', 'confident', 'passionate'],
    spiceLevel: 'blindfold', playInterestTags: ['playful', 'dirty_talk', 'passionate', 'fwb', 'no_strings'],
    playPrompts: [
      ['play_opener', 'Make me laugh first. Everything else follows.'],
      ['play_vibe', 'Fun, a little loud, never boring.'],
    ],
  },
  creative: {
    lifestyleTags: ['creative', 'homebody', 'foodie'],
    habitTags: ['reader', 'cat_person', 'night_owl', 'coffee_addict'],
    personalityTraits: ['creative', 'empathetic', 'intellectual', 'genuine'],
    relationshipValues: ['communication', 'independence', 'growth'],
    weekendVibes: ['create_something', 'recharge_solo', 'slow_mornings'],
    conflictStyle: 'process_first', togethernessStyle: 'independent', stressResponse: 'get_quiet',
    seekingTraits: ['intellectual', 'creative', 'kind', 'emotionally_available'],
    spiceLevel: 'spicy', playInterestTags: ['slow_and_sensual', 'eye_contact', 'role_play', 'communicative', 'connection_first'],
    playPrompts: [
      ['play_communicate', 'Out loud. Tell me what works and I will remember it.'],
      ['play_ideal', 'Rainy night, good record on, nowhere to be.'],
    ],
  },
  family: {
    lifestyleTags: ['homebody', 'wellness_focused', 'foodie'],
    habitTags: ['early_riser', 'cook', 'dog_person', 'doesnt_drink'],
    personalityTraits: ['caring', 'loyal', 'grounded', 'empathetic'],
    relationshipValues: ['stability', 'trust', 'spiritual_alignment'],
    weekendVibes: ['cook_something_good', 'host_people', 'slow_mornings'],
    conflictStyle: 'process_first', togethernessStyle: 'entwined', stressResponse: 'talk_it_out',
    seekingTraits: ['kind', 'stable', 'honest', 'protective'],
    spiceLevel: 'vanilla', playInterestTags: ['kissing', 'touching', 'slow_and_sensual', 'connection_first', 'regular_thing'],
    playPrompts: [
      ['play_rules', 'Respect, always. Kindness is attractive.'],
      ['play_chemistry', 'When I feel safe enough to be a little bolder.'],
    ],
  },
  thinker: {
    lifestyleTags: ['traveler', 'creative', 'homebody'],
    habitTags: ['reader', 'meditates', 'coffee_addict', 'hiker'],
    personalityTraits: ['intellectual', 'sarcastic', 'genuine', 'laid_back'],
    relationshipValues: ['communication', 'humor', 'independence'],
    weekendVibes: ['go_somewhere', 'recharge_solo', 'create_something'],
    conflictStyle: 'situational', togethernessStyle: 'separate_plus_deep', stressResponse: 'get_quiet',
    seekingTraits: ['intellectual', 'funny', 'honest', 'emotionally_available'],
    spiceLevel: 'blindfold', playInterestTags: ['communicative', 'switch_role', 'eye_contact', 'intense', 'situationship'],
    playPrompts: [
      ['play_communicate', 'I ask. Then I listen. Then I ask again.'],
      ['play_vibe', 'Curious. I like figuring people out.'],
    ],
  },
  athlete: {
    lifestyleTags: ['wellness_focused', 'adventurer', 'social_butterfly'],
    habitTags: ['gym_regular', 'early_riser', 'cook', 'music_lover'],
    personalityTraits: ['driven', 'confident', 'passionate', 'loyal'],
    relationshipValues: ['loyalty', 'passion', 'ambition'],
    weekendVibes: ['take_care_of_myself', 'get_outside', 'out_in_the_city'],
    conflictStyle: 'direct', togethernessStyle: 'in_between', stressResponse: 'power_through',
    seekingTraits: ['driven', 'confident', 'affectionate', 'honest'],
    spiceLevel: 'unleashed', playInterestTags: ['passionate', 'intense', 'dom', 'oral_both', 'fwb'],
    playPrompts: [
      ['play_vibe', 'High energy. I bring the same effort everywhere.'],
      ['play_after', 'Shower, snacks, round two if the vibe is right.'],
    ],
  },
  easygoing: {
    lifestyleTags: ['foodie', 'outdoorsy', 'homebody'],
    habitTags: ['gamer', 'dog_person', 'music_lover', '420_friendly'],
    personalityTraits: ['laid_back', 'playful', 'genuine', 'wild_card'],
    relationshipValues: ['humor', 'spontaneity', 'trust'],
    weekendVibes: ['live_something', 'recharge_solo', 'cook_something_good'],
    conflictStyle: 'avoid', togethernessStyle: 'in_between', stressResponse: 'step_back',
    seekingTraits: ['funny', 'kind', 'spontaneous', 'creative'],
    spiceLevel: 'spicy', playInterestTags: ['playful', 'no_strings', 'kissing', 'touching', 'fwb'],
    playPrompts: [
      ['play_ideal', 'Couch, takeout, no plan, see where it goes.'],
      ['play_opener', 'Send a good meme. Seriously.'],
    ],
  },
}

// ─── Personas ────────────────────────────────────────────────────────────────
// [id, name, age, birthday MM-DD, heightCm, bodyType, archetype, attractedTo,
//  openTo, drinkingHabit, religion, politicalView, loveGive, loveReceive,
//  parentalCurrent, parentalIntent, dealbreakers, relationshipStyle,
//  playStyle, playNonNegotiables, bio, [3 Spark prompts], playBio]

const W = 'women'
const M = 'men'
const PERSONAS = [
  // ── Dallas women ──
  ['dal-w-001', 'Brooke', 27, '03-14', 168, 'athletic', 'driven', [M], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'center_right',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'quality_time'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'situationship', ['safe_sex_only'],
    "Commercial real estate in Uptown, Katy Trail runs before work. I plan a lot, so I like someone who can make me forget the plan for a night.",
    [['green_flag', 'I follow up. If I said I would call, I call.'], ['at_my_best', 'Sunday morning, long run done, nowhere to be until brunch.'], ['the_ask', 'Someone with their own thing going on who still makes time.']],
    'Driven by day, a lot softer after dark.'],
  ['dal-w-002', 'Kayla', 25, '08-02', 163, 'slim', 'social', [M], ['something_that_grows', 'casual'], 'socially', 'agnostic', 'democrat',
    ['physical_touch', 'words_of_affirmation'], ['physical_touch', 'quality_time'], 'no_kids', 'undecided', [], 'exploring', 'play_partner', ['safe_sex_only', 'condoms_always'],
    "Event planner, Deep Ellum regular, owner of too many cowboy boots. If there's live music on a Tuesday, I'm probably there.",
    [['perfect_day', 'Patio brunch, a nap, then a show on Elm Street.'], ['controversy', 'Tex-Mex beats Mexican food and I will die on that hill.'], ['how_i_argue', 'Loud for five minutes, hugging by minute ten.']],
    'Flirty, fun, zero patience for boring.'],
  ['dal-w-003', 'Danielle', 31, '11-21', 170, 'curvy', 'family', [M], ['monogamy'], 'never', 'christian', 'republican',
    ['acts_of_service', 'quality_time'], ['quality_time', 'words_of_affirmation'], 'has_kids', 'open_to_more', ['heavy_drinker', 'cigarette_smoker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Pediatric nurse and mom to a seven-year-old who runs my life. Church on Sundays, Friday night is pizza and a movie. Looking for steady.",
    [['love_looks_like', 'Showing up for the boring stuff, not just the fun stuff.'], ['what_i_want', 'A partner, not a project. Someone ready.'], ['proud_of', 'Raising a kind kid while working nights.']],
    'Old-fashioned on the outside. Ask me later.'],
  ['dal-w-004', 'Alexis', 29, '05-09', 165, 'average', 'creative', [M], ['monogamy', 'something_that_grows'], 'socially', 'spiritual', 'center_left',
    ['words_of_affirmation', 'quality_time'], ['words_of_affirmation', 'acts_of_service'], 'no_kids', 'undecided', [], 'monogamous', 'situationship', ['safe_sex_only', 'recent_sti_screening'],
    "Graphic designer working out of a Bishop Arts studio. I collect vintage records and very strong opinions about fonts.",
    [['current_obsession', 'Restoring a 1970s record player I found at an estate sale.'], ['misunderstood', 'Quiet at first. I am just taking notes.'], ['recharge', 'Headphones, a sketchbook and a long drive.']],
    'Slow burn. Worth it.'],
  ['dal-w-005', 'Megan', 34, '01-30', 172, 'athletic', 'athlete', [M], ['monogamy', 'something_that_grows'], 'socially', 'catholic', 'independent',
    ['physical_touch', 'acts_of_service'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'doesnt_want_any', ['cigarette_smoker'], 'monogamous', 'play_partner', ['safe_sex_only'],
    "Physical therapist and former D1 volleyball player. White Rock Lake loops, Mavs games, competitive about board games in a way I can't fix.",
    [['unusual_skill', 'I can tell what you injured by how you walk in.'], ['friendship_test', 'Be willing to lose at Catan gracefully. I will not.'], ['learned_hard_way', 'Recovery days matter as much as the hard ones.']],
    'Competitive. In every room.'],
  ['dal-w-006', 'Jasmine', 26, '07-17', 160, 'curvy', 'social', [M], ['something_that_grows', 'casual'], 'regularly', 'christian', 'democrat',
    ['words_of_affirmation', 'physical_touch'], ['quality_time', 'physical_touch'], 'no_kids', 'wants_first', [], 'exploring', 'situationship', ['condoms_always'],
    "Marketing at a beauty brand, weekend DJ on the side. Brunch is a sport and I'm undefeated. Bring good energy and I'll match it.",
    [['tell_me_something', 'I have DJed three weddings and cried at all of them.'], ['morning_or_night', 'Night. Do not talk to me before coffee.'], ['dating_philosophy', 'Effort is attractive. So is a good playlist.']],
    'Sweet till you earn spicy.'],
  ['dal-w-007', 'Rachel', 30, '09-03', 166, 'slim', 'thinker', [M], ['monogamy', 'something_that_grows'], 'socially', 'jewish', 'center_left',
    ['quality_time', 'words_of_affirmation'], ['quality_time', 'acts_of_service'], 'no_kids', 'wants_first', ['different_politics'], 'monogamous', 'solo_play', ['safe_sex_only', 'recent_sti_screening'],
    "Data scientist at a fintech in Plano. I read on planes, debate on porches and plan trips around bookstores.",
    [['controversy', 'Most "hot takes" are just lukewarm takes said loudly.'], ['current_obsession', 'Learning Italian before a trip I have not booked yet.'], ['how_i_argue', 'I want to understand first. Then I want to win.']],
    'Brainy. Curious. Patient — mostly.'],
  ['dal-w-008', 'Taylor', 24, '12-12', 169, 'average', 'easygoing', [M, W], ['casual', 'something_that_grows'], 'socially', 'agnostic', 'center_left',
    ['physical_touch', 'quality_time'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'multi_play', ['safe_sex_only', 'condoms_always'],
    "Grad student at SMU, part-time barista, full-time dog mom. I'm the friend who knows every taco truck worth stopping for.",
    [['recharge', 'Dog park, iced coffee, phone on do not disturb.'], ['perfect_day', 'Trinity Groves food crawl and a sunset from the bridge.'], ['tell_me_something', 'I have a tattoo I designed myself. It is a taco.']],
    'Easygoing. Open to whatever feels right.'],
  ['dal-w-009', 'Lauren', 33, '04-25', 167, 'athletic', 'outdoorsy', [M], ['monogamy'], 'socially', 'christian', 'center_right',
    ['acts_of_service', 'physical_touch'], ['quality_time', 'acts_of_service'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Veterinarian with two rescue dogs and a lake-weekend habit. I'll pick a campfire over a club every time.",
    [['green_flag', 'Animals and kids like me. That has to count for something.'], ['love_looks_like', 'Making coffee for two without being asked.'], ['at_my_best', 'Out on the water with zero cell service.']],
    'Warm. Grounded. Takes her time.'],
  ['dal-w-010', 'Sierra', 28, '10-19', 171, 'slim', 'creative', [M], ['something_that_grows'], 'socially', 'spiritual', 'democrat',
    ['words_of_affirmation', 'quality_time'], ['words_of_affirmation', 'physical_touch'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['safe_sex_only', 'discreet_required'],
    "Copywriter by day, improv performer by night. I will laugh at your jokes if they're good and tell you if they're not.",
    [['misunderstood', 'People think I am always on. I am an introvert with good stage skills.'], ['unusual_skill', 'I can improvise a toast for any occasion on the spot.'], ['what_i_want', 'Someone who is funny on purpose and kind by default.']],
    'Witty first. Wicked later.'],

  // ── Dallas men ──
  ['dal-m-001', 'Tyler', 30, '02-11', 185, 'athletic', 'driven', [W], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'center_right',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'physical_touch'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'situationship', ['safe_sex_only'],
    "Finance in Uptown, Rangers season tickets, learning to cook something other than steak. I work hard so the weekends feel earned.",
    [['green_flag', 'I remember what you told me last week.'], ['five_years', 'A house with a big backyard and a dog that runs it.'], ['the_ask', 'Someone who knows what they want and says it.']],
    'Confident, attentive, never in a rush.'],
  ['dal-m-002', 'Marcus', 32, '06-28', 188, 'muscular', 'athlete', [W], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'democrat',
    ['physical_touch', 'acts_of_service'], ['physical_touch', 'quality_time'], 'no_kids', 'wants_first', [], 'monogamous', 'play_partner', ['safe_sex_only'],
    "High school football coach and strength trainer. Big on discipline, bigger on Sunday dinners with my family in DeSoto.",
    [['proud_of', 'Three of my players were the first in their families to go to college.'], ['at_my_best', 'Early mornings, team around me, coffee in hand.'], ['love_looks_like', 'Protecting your peace, not just your time.']],
    'Strong, steady, and present.'],
  ['dal-m-003', 'Ethan', 27, '09-15', 178, 'slim', 'thinker', [W], ['something_that_grows', 'monogamy'], 'socially', 'agnostic', 'center_left',
    ['quality_time', 'words_of_affirmation'], ['quality_time', 'acts_of_service'], 'no_kids', 'undecided', [], 'monogamous', 'solo_play', ['safe_sex_only', 'recent_sti_screening'],
    "Software engineer in Richardson, amateur astronomer, overthinker in recovery. I'll send you podcast episodes and ask what you thought.",
    [['current_obsession', 'Building a telescope mount out of an old bike frame.'], ['how_i_argue', 'Calmly. I would rather solve it than win it.'], ['controversy', 'Most meetings could be a text.']],
    'Thoughtful. Asks first.'],
  ['dal-m-004', 'Andre', 29, '12-03', 183, 'athletic', 'social', [W], ['casual', 'something_that_grows'], 'regularly', 'christian', 'democrat',
    ['physical_touch', 'words_of_affirmation'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['condoms_always'],
    "Restaurant GM in Deep Ellum. I know where to eat, where to dance and where to get the best late-night tacos. Let me show you around.",
    [['perfect_day', 'Late brunch, golf at Topgolf, live music till close.'], ['unusual_skill', 'I can make any cocktail you can name.'], ['dating_philosophy', 'Good food, good company, the rest takes care of itself.']],
    'Smooth, social, a little trouble.'],
  ['dal-m-005', 'Cody', 34, '03-07', 180, 'average', 'outdoorsy', [W], ['monogamy'], 'socially', 'christian', 'republican',
    ['acts_of_service', 'physical_touch'], ['quality_time', 'physical_touch'], 'has_kids', 'open_to_more', ['heavy_drinker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Electrician, dad to a ten-year-old who beats me at fishing. I grill, I fix things and I'll always open your door.",
    [['what_i_want', 'Someone to build a simple, good life with.'], ['friendship_test', 'Help me move something heavy. I will return the favor forever.'], ['recharge', 'Truck, lake, rod in the water.']],
    'Simple, honest, and loyal.'],
  ['dal-m-006', 'Daniel', 26, '05-22', 175, 'slim', 'creative', [W, M], ['something_that_grows', 'casual'], 'socially', 'atheist', 'democrat',
    ['words_of_affirmation', 'quality_time'], ['words_of_affirmation', 'quality_time'], 'no_kids', 'doesnt_want_any', [], 'exploring', 'multi_play', ['safe_sex_only', 'condoms_always'],
    "Photographer and part-time film teacher. I notice light first, people second, and I'm working on the order.",
    [['misunderstood', 'Shy, until I am not.'], ['tell_me_something', 'I shot my first wedding on a disposable camera.'], ['perfect_day', 'Golden hour at the Arboretum and a long dinner after.']],
    'Curious about everything.'],
  ['dal-m-007', 'Jordan', 31, '08-30', 186, 'muscular', 'driven', [W], ['monogamy', 'something_that_grows'], 'socially', 'catholic', 'independent',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'quality_time'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'play_partner', ['safe_sex_only', 'recent_sti_screening'],
    "Started a landscaping company at 22, now we have 30 trucks. I still mow my own lawn on Saturdays. Old habits.",
    [['proud_of', 'Hiring my dad when his job got cut.'], ['learned_hard_way', 'You cannot outwork a bad partnership.'], ['the_ask', 'Ambitious, kind, and up for a road trip.']],
    'Built from scratch. Patient with the good stuff.'],
  ['dal-m-008', 'Luis', 28, '11-11', 177, 'average', 'family', [W], ['monogamy'], 'never', 'catholic', 'center_left',
    ['acts_of_service', 'quality_time'], ['quality_time', 'words_of_affirmation'], 'no_kids', 'wants_first', ['heavy_drinker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Middle school math teacher in Oak Cliff. My mom's tamales are the best in Dallas and I'll prove it at Christmas.",
    [['green_flag', 'I call my grandmother every Sunday.'], ['love_looks_like', 'Being someone you can count on, every time.'], ['five_years', 'Married, a couple of kids, still teaching.']],
    'Gentle. Takes it slow.'],
  ['dal-m-009', 'Blake', 25, '04-04', 182, 'athletic', 'easygoing', [W], ['casual', 'something_that_grows'], 'socially', 'agnostic', 'center_right',
    ['physical_touch', 'quality_time'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['condoms_always'],
    "Sales rep, pickup basketball regular, aspiring smoker of the perfect brisket. Not in a rush, but not playing games either.",
    [['recharge', 'Pickup game, then a nap.'], ['controversy', 'Brisket does not need sauce. Fight me.'], ['morning_or_night', 'Night. My best ideas show up at midnight.']],
    'Laid back, good hands, better jokes.'],
  ['dal-m-010', 'Nathan', 36, '07-08', 184, 'average', 'thinker', [W], ['monogamy', 'something_that_grows'], 'socially', 'spiritual', 'independent',
    ['quality_time', 'words_of_affirmation'], ['quality_time', 'physical_touch'], 'no_kids', 'open_to_more', ['different_politics'], 'monogamous', 'solo_play', ['safe_sex_only', 'recent_sti_screening'],
    "Architect, divorced, better for it. I renovate old houses in Lakewood and have learned patience the hard way.",
    [['learned_hard_way', 'Love is a verb. Feelings are the easy part.'], ['what_i_want', 'Depth. Someone who wants the real conversation.'], ['at_my_best', 'Saturday morning, a pencil and a problem to solve.']],
    'Grown. Knows what he wants.'],

  // ── Houston women ──
  ['hou-w-001', 'Ashley', 29, '02-19', 164, 'curvy', 'social', [M], ['something_that_grows', 'monogamy'], 'socially', 'christian', 'democrat',
    ['words_of_affirmation', 'physical_touch'], ['quality_time', 'physical_touch'], 'no_kids', 'wants_first', [], 'monogamous', 'situationship', ['safe_sex_only'],
    "Oil and gas HR by day, Montrose bar crawl captain by night. Born and raised in Houston, I'll defend it to anyone who complains about the humidity.",
    [['perfect_day', 'Crawfish, cold drinks and a long patio afternoon.'], ['controversy', 'Houston food beats Austin food. Easily.'], ['dating_philosophy', 'Be fun, be honest, be on time.']],
    'Bubbly. Then bold.'],
  ['hou-w-002', 'Priya', 31, '06-06', 162, 'slim', 'driven', [M], ['monogamy', 'something_that_grows'], 'socially', 'hindu', 'center_left',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'quality_time'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'solo_play', ['safe_sex_only', 'recent_sti_screening'],
    "Cardiology fellow at the Medical Center. Long shifts, short temper for flakiness, big heart for people who show up.",
    [['green_flag', 'I make time for the people I care about, even on call.'], ['what_i_want', 'A real partnership. Two busy people who choose each other.'], ['recharge', 'A long bath, a long book and my phone on silent.']],
    'Selective. Intentional. Worth the wait.'],
  ['hou-w-003', 'Vanessa', 27, '09-24', 167, 'athletic', 'athlete', [M], ['something_that_grows', 'casual'], 'socially', 'catholic', 'independent',
    ['physical_touch', 'acts_of_service'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'play_partner', ['safe_sex_only', 'condoms_always'],
    "Spin instructor and nutrition coach in the Heights. I'll get you up at 6am and you'll thank me by 8.",
    [['at_my_best', 'Right after a class where everyone left it all on the bike.'], ['unusual_skill', 'I can meal prep a week of food in two hours.'], ['how_i_argue', 'Direct. I would rather say it than stew on it.']],
    'High energy. Keeps up.'],
  ['hou-w-004', 'Maria', 33, '12-15', 160, 'full_figured', 'family', [M], ['monogamy'], 'never', 'catholic', 'center_right',
    ['acts_of_service', 'quality_time'], ['quality_time', 'acts_of_service'], 'has_kids', 'open_to_more', ['heavy_drinker', 'cigarette_smoker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Elementary school principal and proud mom of twins. Sunday mass, Sunday barbacoa. Looking for a man who's kind to waiters and patient with kids.",
    [['love_looks_like', 'Packing lunches and leaving a note in one.'], ['proud_of', 'Running a school where every kid feels seen.'], ['the_ask', 'Kind, steady, and good with a grill.']],
    'Traditional. Warm. Surprising.'],
  ['hou-w-005', 'Chloe', 25, '03-28', 170, 'slim', 'creative', [M, W], ['something_that_grows', 'casual'], 'socially', 'agnostic', 'democrat',
    ['words_of_affirmation', 'quality_time'], ['words_of_affirmation', 'physical_touch'], 'no_kids', 'doesnt_want_any', [], 'exploring', 'multi_play', ['safe_sex_only', 'discreet_required'],
    "Muralist with paint on most of my clothes. You've probably walked past my work in EaDo without knowing it.",
    [['tell_me_something', 'I painted my first mural at 16, without permission.'], ['current_obsession', 'Natural dyes from things I find at farmers markets.'], ['misunderstood', 'Intense about art, chill about everything else.']],
    'Colorful. Open. Unpredictable.'],
  ['hou-w-006', 'Nicole', 30, '07-01', 166, 'average', 'thinker', [M], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'center_left',
    ['quality_time', 'words_of_affirmation'], ['quality_time', 'words_of_affirmation'], 'no_kids', 'wants_first', ['different_politics'], 'monogamous', 'situationship', ['safe_sex_only', 'recent_sti_screening'],
    "Aerospace engineer near NASA in Clear Lake. Yes, I work on rockets. No, I can't tell you about it. Yes, I'll explain it anyway.",
    [['unusual_skill', 'I can explain orbital mechanics with a coffee cup and a sugar packet.'], ['controversy', 'Space is the most underrated date topic.'], ['how_i_argue', 'With data, then with feelings.']],
    'Nerdy, warm, quietly bold.'],
  ['hou-w-007', 'Destiny', 28, '10-08', 168, 'curvy', 'social', [M], ['casual', 'something_that_grows'], 'regularly', 'christian', 'democrat',
    ['physical_touch', 'words_of_affirmation'], ['physical_touch', 'quality_time'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['condoms_always'],
    "Realtor who never stops talking and never misses a Rockets game. I host the best game nights in Midtown.",
    [['friendship_test', 'Come to game night and talk a little trash.'], ['morning_or_night', 'Night. My open houses start at noon for a reason.'], ['perfect_day', 'Rooftop brunch, a showing, and a playoff game.']],
    'Big laugh. Bigger energy.'],
  ['hou-w-008', 'Hannah', 26, '05-13', 172, 'athletic', 'outdoorsy', [M], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'center_right',
    ['acts_of_service', 'physical_touch'], ['quality_time', 'physical_touch'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Environmental scientist, weekend kayaker on Buffalo Bayou. I'm happiest outside, a little sunburnt, with a cold drink.",
    [['recharge', 'Paddling at sunrise before the city wakes up.'], ['green_flag', 'I will always pack you snacks.'], ['five_years', 'Land outside the city with room for a garden and a dog.']],
    'Easygoing. Sun-warmed.'],
  ['hou-w-009', 'Gabriela', 35, '01-09', 163, 'average', 'driven', [M], ['monogamy'], 'socially', 'catholic', 'independent',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'acts_of_service'], 'no_kids', 'open_to_more', [], 'monogamous', 'play_partner', ['safe_sex_only', 'recent_sti_screening'],
    "Immigration attorney, first-gen, fluent in Spanish and sarcasm. I fight hard at work so I want peace at home.",
    [['proud_of', 'Reuniting families who did not think it was possible.'], ['learned_hard_way', 'Peace is not boring. It is the goal.'], ['what_i_want', 'Someone secure enough to be gentle.']],
    'Fierce. Then tender.'],
  ['hou-w-010', 'Kennedy', 24, '08-21', 165, 'slim', 'easygoing', [M], ['casual', 'something_that_grows'], 'socially', 'agnostic', 'center_left',
    ['physical_touch', 'quality_time'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['safe_sex_only', 'condoms_always'],
    "UH grad, working in social media and figuring out the rest. I'll try any restaurant once and most of them twice.",
    [['current_obsession', 'Ranking every pho spot on Bellaire Boulevard.'], ['tell_me_something', 'I have a spreadsheet of every restaurant I have been to.'], ['dating_philosophy', 'If it is easy, it is right.']],
    'Low-key, curious, fun.'],

  // ── Houston men ──
  ['hou-m-001', 'Chris', 30, '04-17', 183, 'athletic', 'driven', [W], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'center_right',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'physical_touch'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'situationship', ['safe_sex_only'],
    "Petroleum engineer who'd rather be fishing in Galveston. I travel for work, so when I'm home I'm actually home.",
    [['green_flag', 'When I am with you, the phone stays in my pocket.'], ['the_ask', 'Independent, warm, and down for a beach weekend.'], ['at_my_best', 'On a boat, early, with the sun coming up.']],
    'Steady. Attentive. Patient.'],
  ['hou-m-002', 'Jamal', 33, '10-02', 190, 'muscular', 'athlete', [W], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'democrat',
    ['physical_touch', 'acts_of_service'], ['physical_touch', 'quality_time'], 'no_kids', 'wants_first', [], 'monogamous', 'play_partner', ['safe_sex_only'],
    "Firefighter, Third Ward born and raised. I cook for the whole station and I'll cook for you too.",
    [['unusual_skill', 'I can feed thirty people out of one kitchen.'], ['love_looks_like', 'Showing up first and staying last.'], ['proud_of', 'Every person we got home safe.']],
    'Strong, protective, gentle with it.'],
  ['hou-m-003', 'Kevin', 28, '06-14', 175, 'slim', 'thinker', [W], ['something_that_grows', 'monogamy'], 'socially', 'atheist', 'center_left',
    ['quality_time', 'words_of_affirmation'], ['quality_time', 'acts_of_service'], 'no_kids', 'undecided', [], 'monogamous', 'solo_play', ['safe_sex_only', 'recent_sti_screening'],
    "Biomedical researcher at Rice. I spend my days with cells and my nights with jazz records and a long list of questions.",
    [['current_obsession', 'Learning every Coltrane solo by ear.'], ['how_i_argue', 'I ask questions until we both understand.'], ['misunderstood', 'Reserved at first. I warm up fast with the right people.']],
    'Thoughtful. Asks what you like.'],
  ['hou-m-004', 'Diego', 27, '02-26', 180, 'athletic', 'social', [W], ['casual', 'something_that_grows'], 'regularly', 'catholic', 'democrat',
    ['physical_touch', 'words_of_affirmation'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['condoms_always'],
    "Bartender turned bar owner in Montrose. Salsa on Thursdays, soccer on Sundays. Life's too short for bad music.",
    [['perfect_day', 'Soccer in the morning, tacos, dancing till late.'], ['unusual_skill', 'I can teach anyone to salsa in one song.'], ['dating_philosophy', 'Chemistry first. Everything else is details.']],
    'Smooth moves, literally.'],
  ['hou-m-005', 'Ryan', 35, '11-30', 182, 'average', 'family', [W], ['monogamy'], 'never', 'christian', 'republican',
    ['acts_of_service', 'quality_time'], ['quality_time', 'words_of_affirmation'], 'has_kids', 'open_to_more', ['heavy_drinker'], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Single dad, small business owner in Katy. My daughter and my faith come first. Looking for someone kind, honest and ready.",
    [['what_i_want', 'A partner to build a family with, not just a date.'], ['love_looks_like', 'Pancakes on Saturday, church on Sunday.'], ['learned_hard_way', 'Patience is the whole game.']],
    'Gentle and old-school.'],
  ['hou-m-006', 'Trevor', 26, '09-09', 178, 'slim', 'creative', [W], ['something_that_grows', 'casual'], 'socially', 'spiritual', 'democrat',
    ['words_of_affirmation', 'quality_time'], ['words_of_affirmation', 'quality_time'], 'no_kids', 'doesnt_want_any', [], 'exploring', 'multi_play', ['safe_sex_only', 'condoms_always'],
    "Sound engineer at a Midtown studio, musician on the side. I'll make you a playlist and it'll be uncomfortably accurate.",
    [['tell_me_something', 'I have produced two albums you have never heard of.'], ['recharge', 'Studio, headphones, three hours gone.'], ['controversy', 'Most music sounds better on vinyl. Yes, really.']],
    'Rhythm. Intuition. Patience.'],
  ['hou-m-007', 'Brandon', 31, '03-03', 187, 'muscular', 'driven', [W], ['monogamy', 'something_that_grows'], 'socially', 'christian', 'independent',
    ['acts_of_service', 'quality_time'], ['words_of_affirmation', 'quality_time'], 'no_kids', 'wants_first', ['cigarette_smoker'], 'monogamous', 'play_partner', ['safe_sex_only', 'recent_sti_screening'],
    "Commercial pilot based out of IAH. Half my week is in the air, the other half I'm planning where to take you.",
    [['five_years', 'Captain, a house in the Heights and someone to fly home to.'], ['green_flag', 'I land when I say I will.'], ['perfect_day', 'Short hop to New Orleans for beignets and back by dinner.']],
    'Calm under pressure.'],
  ['hou-m-008', 'Isaac', 29, '12-24', 176, 'average', 'outdoorsy', [W], ['monogamy', 'something_that_grows'], 'socially', 'jewish', 'center_left',
    ['acts_of_service', 'physical_touch'], ['quality_time', 'physical_touch'], 'no_kids', 'wants_first', [], 'monogamous', 'solo_play', ['safe_sex_only'],
    "Urban planner who bikes to work, which in Houston makes me either brave or confused. Weekends are for Memorial Park and long dinners.",
    [['controversy', 'Houston could be the best bike city in Texas. Hear me out.'], ['recharge', 'A long ride and a longer lunch.'], ['friendship_test', 'Help me find the best kolache in town.']],
    'Easy company. Good listener.'],
  ['hou-m-009', 'Derek', 37, '05-05', 181, 'average', 'thinker', [W], ['monogamy', 'something_that_grows'], 'socially', 'agnostic', 'independent',
    ['quality_time', 'words_of_affirmation'], ['quality_time', 'physical_touch'], 'no_kids', 'open_to_more', ['different_politics'], 'monogamous', 'solo_play', ['safe_sex_only', 'recent_sti_screening'],
    "Professor of history at UH. I'll ruin every historical movie for you and somehow you'll enjoy it.",
    [['unusual_skill', 'I can tell you what happened on any date in Texas history.'], ['at_my_best', 'Lecturing to a room that actually wants to be there.'], ['what_i_want', 'A great conversation that never really ends.']],
    'Grown, curious, unhurried.'],
  ['hou-m-010', 'Austin', 24, '08-16', 184, 'athletic', 'easygoing', [W], ['casual', 'something_that_grows'], 'socially', 'christian', 'center_right',
    ['physical_touch', 'quality_time'], ['physical_touch', 'words_of_affirmation'], 'no_kids', 'undecided', [], 'exploring', 'situationship', ['condoms_always'],
    "Yes, my name is Austin and I live in Houston. Construction project manager, weekend golfer, always down for a crawfish boil.",
    [['tell_me_something', 'I have been asked if I am lost about a thousand times.'], ['perfect_day', 'Early tee time, crawfish, a nap on the porch.'], ['morning_or_night', 'Morning. Job sites start at six.']],
    'Laid back, quick to laugh.'],
]

// ─── Builders ────────────────────────────────────────────────────────────────


// Birth year so that age is right on TODAY.
function birthday(age, mmdd) {
  const [mm, dd] = mmdd.split('-').map(Number)
  const hadBirthday = mm < TODAY.getUTCMonth() + 1 || (mm === TODAY.getUTCMonth() + 1 && dd <= TODAY.getUTCDate())
  return `${TODAY.getUTCFullYear() - age - (hadBirthday ? 0 : 1)}-${mmdd}`
}

const BODY_PREFS = {
  women: ['athletic', 'average', 'muscular', 'slim'],
  men: ['athletic', 'average', 'curvy', 'slim'],
}

function build(p) {
  const [id, name, age, mmdd, heightCm, bodyType, archetype, attractedTo, openTo, drinkingHabit, religion, politicalView,
    loveLangGive, loveLangReceive, parentalCurrent, parentalIntent, dealbreakers, relationshipStyle, playStyle,
    playNonNegotiables, bio, prompts, playBio] = p
  const a = ARCHETYPES[archetype]
  if (!a) throw new Error(`${id}: unknown archetype ${archetype}`)
  const uid = `zbot-${id}`
  const city = CITIES[id.slice(0, 3)]
  const isWoman = id.includes('-w-')
  const ageMin = Math.max(21, age - 4)
  const ageMax = age + 6
  const seeking = attractedTo.length > 1 ? ['everyone'] : attractedTo
  const root = {
    uid, displayName: name, age, birthday: birthday(age, mmdd),
    genderIdentity: isWoman ? 'woman' : 'man', attractedTo: seeking, showOrientation: false,
    relationshipStatus: 'single', openTo,
    bodyType, heightCm,
    lifestyleTags: a.lifestyleTags, habitTags: a.habitTags, drinkingHabit, religion, politicalView,
    personalityTraits: a.personalityTraits, relationshipValues: a.relationshipValues, weekendVibes: a.weekendVibes,
    loveLangGive, loveLangReceive, bio,
    promptAnswers: prompts.map(([promptId, answer]) => ({ promptId, answer })),
    parentalCurrent, parentalIntent,
    conflictStyle: a.conflictStyle, togethernessStyle: a.togethernessStyle, stressResponse: a.stressResponse,
    dealbreakers, seekingTraits: a.seekingTraits,
    seekingBodyTypes: seeking.includes('everyone') ? ['athletic', 'average', 'slim'] : BODY_PREFS[attractedTo[0]],
    ageMin, ageMax, radiusMiles: 25,
    // City centre — public, not anyone's home. No _location / geohash (raw
    // coordinates any signed-in user could read; see scrub-raw-location.mjs).
    locationLabel: city.label, locationLat: city.lat, locationLng: city.lng,
    verificationStatus: 'phone_verified', phoneVerified: true, isBot: true, reportCount: 0, isSuspended: false,
    subscriptionTier: 'elite', sparkVisibility: 'active',
    publicKey: '', relationshipStyle, sortKey: Math.random(),
  }
  // Stage 2: nothing Play on the public doc — the intent/mode go to the
  // owner-only private/profile, Play fields to playProfile/data.
  const meta = { intent: 'open', mode: 'spark' }
  const play = {
    uid, displayName: name, genderIdentity: root.genderIdentity, attractedTo: seeking,
    spiceLevel: a.spiceLevel, playInterestTags: a.playInterestTags, playNonNegotiables, playStyle, playBio,
    promptAnswers: a.playPrompts.map(([promptId, answer]) => ({ promptId, answer })),
    ageMin, ageMax, radiusMiles: 25, orientation: seeking, intent: 'open',
    playVisibility: 'active', playOnboardingComplete: true,
  }
  // Austin bot whose photos this one borrows by default.
  const n = Number(id.slice(-3))
  const photoSource = `zbot-${isWoman ? 'w' : 'm'}-${String(id.startsWith('hou') ? n + 10 : n).padStart(3, '0')}`
  return { uid, root, play, meta, photoSource }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const credential = existsSync(SERVICE_ACCOUNT)
  ? cert(JSON.parse(readFileSync(SERVICE_ACCOUNT, 'utf8')))
  : applicationDefault()
initializeApp({ credential, projectId: 'zylove' })
const db = getFirestore()

const photoMap = photosArg ? JSON.parse(readFileSync(resolve(photosArg), 'utf8')) : {}
const bots = PERSONAS.map(build)
const uids = new Set(bots.map((b) => b.uid))
if (uids.size !== bots.length) throw new Error('Duplicate uid in PERSONAS')

let created = 0
let skipped = 0
const summary = {}
for (const bot of bots) {
  const ref = db.doc(`users/${bot.uid}`)
  if ((await ref.get()).exists) {
    console.log(`${bot.uid}: already exists — skipped`)
    skipped++
    continue
  }
  const photos = Array.isArray(photoMap[bot.uid])
    ? photoMap[bot.uid]
    : ((await db.doc(`users/${bot.photoSource}`).get()).data()?.photoURLs ?? [])
  const key = `${bot.root.locationLabel} ${bot.root.genderIdentity}`
  summary[key] = (summary[key] ?? 0) + 1
  console.log(
    `${apply ? 'create' : 'would create'} ${bot.uid}: ${bot.root.displayName}, ${bot.root.age} (${bot.root.birthday}) · ` +
      `${bot.root.attractedTo.join('/')} · ${bot.root.locationLabel} · ${photos.length} photo(s) from ${
        photoMap[bot.uid] ? 'map' : bot.photoSource
      }`,
  )
  if (!apply) {
    created++
    continue
  }
  const now = FieldValue.serverTimestamp()
  const batch = db.batch()
  batch.set(ref, { ...bot.root, photoURLs: photos, identityLockedAt: now, createdAt: now, lastActive: now, profileUpdatedAt: now })
  batch.set(ref.collection('playProfile').doc('data'), { ...bot.play, photoURLs: photos, createdAt: now, lastUpdated: now })
  batch.set(ref.collection('private').doc('profile'), bot.meta)
  await batch.commit()
  created++
}

console.log(`\n${bots.length} personas · ${apply ? 'created' : 'to create'} ${created} · skipped ${skipped}`, summary)
if (!apply) console.log('Dry run — re-run with --apply to write.')
