// Admin notifications: toggles, batching, the daily cap, quiet hours, urgent
// bypass and the privacy of every text.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  type AdminEvent,
  type AdminNotifySettings,
  type AdminNotifyState,
  CAP_NOTICE,
  DAILY_CAP,
  EVENTS,
  TOGGLE_KEYS,
  applyPatch,
  emptyState,
  flush,
  normalizeSettings,
  normalizeState,
  onEvent,
  parsePatch,
  smsEventFor,
  summaryText,
} from '../src/adminAlertsCore'

const MIN = 60_000
// 2026-10-08 12:00 Central (CDT, UTC-5).
const NOON = Date.UTC(2026, 9, 8, 17, 0)
const at = (hour: number, minute = 0, day = 8) => Date.UTC(2026, 9, day, hour + 5, minute)

const optedIn = (patch: Partial<AdminNotifySettings> = {}): AdminNotifySettings => ({
  ...normalizeSettings({ smsConsent: { at: 1, version: 'test' } }),
  ...patch,
})

function run(events: [AdminEvent, number][], settings = optedIn(), state = emptyState()) {
  const texts: string[] = []
  for (const [type, now] of events) {
    const out = onEvent(state, settings, type, 1, {}, now)
    state = out.state
    texts.push(...out.texts)
  }
  return { state, texts }
}

// ─── Settings and toggles ────────────────────────────────────────────────────

test('defaults: every SMS toggle on, push off, quiet hours off 22:00-07:00 Central, no opt-in', () => {
  const s = normalizeSettings(undefined)
  assert.equal(s.sms.all, true)
  assert.ok(TOGGLE_KEYS.every((k) => s.sms.events[k] === true))
  assert.equal(s.push.all, false)
  assert.deepEqual(s.quietHours, { enabled: false, from: '22:00', until: '07:00', timezone: 'America/Chicago' })
  assert.equal(s.smsConsent, null)
  assert.deepEqual(s.excludedUids, [])
})

test('a missing toggle is on; a stored one is kept', () => {
  const s = normalizeSettings({ sms: { all: true, events: { newAccount: false, bogus: false } } })
  assert.equal(s.sms.events.newAccount, false)
  assert.equal(s.sms.events.profileCompleted, true)
  assert.equal('bogus' in s.sms.events, false)
})

test('no texts without the admin opt-in', () => {
  assert.equal(smsEventFor(normalizeSettings({}), { type: 'childSafety', n: 1, detail: {} }), null)
})

test('the SMS master switch off silences every event, urgent included', () => {
  const s = optedIn()
  s.sms.all = false
  for (const type of Object.keys(EVENTS) as AdminEvent[]) {
    assert.equal(smsEventFor(s, { type, n: 1, detail: {}, reasons: ['scam_trap'] }), null, type)
  }
})

test('each toggle controls its own event and no other', () => {
  for (const key of TOGGLE_KEYS.filter((k) => !k.startsWith('trust'))) {
    const s = optedIn()
    s.sms.events[key] = false
    assert.equal(smsEventFor(s, { type: key as AdminEvent, n: 1, detail: {} }), null, key)
    const other = TOGGLE_KEYS.find((k) => k !== key && !k.startsWith('trust')) as AdminEvent
    assert.ok(smsEventFor(s, { type: other, n: 1, detail: {} }), `${key} turned off ${other}`)
  }
})

test('push toggles never send a text (push is stored for later)', () => {
  const s = optedIn()
  s.push.all = false
  s.push.events.photoReview = false
  assert.ok(smsEventFor(s, { type: 'photoReview', n: 1, detail: {} }))
})

test('a trust flag counts under its first family that is on', () => {
  const s = optedIn()
  const flag = { type: 'trustFlag' as const, n: 1, detail: {}, reasons: ['duplicate_photo', 'scam_trap', 'fast_swipes'] }
  assert.deepEqual(smsEventFor(s, flag)?.detail, { scam: 1 })
  s.sms.events.trustScam = false
  assert.deepEqual(smsEventFor(s, flag)?.detail, { photo: 1 })
  s.sms.events.trustPhoto = false
  assert.deepEqual(smsEventFor(s, flag)?.detail, { other: 1 })
  s.sms.events.trustOther = false
  assert.equal(smsEventFor(s, flag), null)
  assert.deepEqual(smsEventFor(s, { ...flag, reasons: ['country_mismatch'] })?.detail, { device: 1 })
  assert.deepEqual(smsEventFor(s, { ...flag, reasons: ['contact_rush'] })?.detail, { contact: 1 })
})

test('settings patches: unknown keys and bad values are refused', () => {
  assert.throws(() => parsePatch({ phone: '+15555550100' }))
  assert.throws(() => parsePatch({ sms: { events: { nope: true } } }))
  assert.throws(() => parsePatch({ sms: { all: 'yes' } }))
  assert.throws(() => parsePatch({ quietHours: { from: '25:00' } }))
  assert.throws(() => parsePatch({ quietHours: { timezone: 'Mars/Base' } }))
  assert.throws(() => parsePatch({ excludedUids: ['a/b'] }))
  assert.deepEqual(parsePatch({ sms: { events: { newAccount: false } } }), { sms: { events: { newAccount: false } } })
})

test('applyPatch reports what changed (for the audit log), and only that', () => {
  const before = optedIn()
  const { next, changed } = applyPatch(before, parsePatch({ sms: { all: false, events: { newAccount: false, photoReview: true } }, quietHours: { enabled: true } }), NOON)
  assert.equal(next.sms.all, false)
  assert.deepEqual(changed, { 'sms.all': [true, false], 'sms.events.newAccount': [true, false], 'quietHours.enabled': [false, true] })
  const ex = applyPatch(before, { excludedUids: ['testA', 'testB'] }, NOON)
  assert.deepEqual(ex.changed.excludedUids, [{ count: 0 }, { count: 2, added: 2, removed: 0 }])
  assert.equal(JSON.stringify(ex.changed).includes('testA'), false)
})

test('opting in records the time and version; opting out clears it', () => {
  const s = normalizeSettings({})
  const on = applyPatch(s, { consent: true }, NOON)
  assert.equal(on.next.smsConsent?.at, NOON)
  assert.deepEqual(on.changed.smsConsent, [false, true])
  assert.equal(applyPatch(on.next, { consent: false }, NOON).next.smsConsent, null)
})

// ─── Batching ────────────────────────────────────────────────────────────────

test('the first event texts at once; more within 10 minutes are counted, then sent together', () => {
  const { state, texts } = run([
    ['photoReview', NOON],
    ['photoReview', NOON + 1 * MIN],
    ['photoReview', NOON + 2 * MIN],
    ['photoReview', NOON + 3 * MIN],
  ])
  assert.deepEqual(texts, ['Zylove admin: 1 photo needs review. zylove.app/admin/photos'])
  assert.deepEqual(flush(state, optedIn(), NOON + 9 * MIN).texts, [])
  assert.deepEqual(flush(state, optedIn(), NOON + 10 * MIN).texts, ['Zylove admin: 3 photos need review. zylove.app/admin/photos'])
})

test('an event after a quiet window texts at once again', () => {
  const { texts } = run([
    ['reportNew', NOON],
    ['reportNew', NOON + 11 * MIN],
  ])
  assert.equal(texts.length, 2)
})

test('event types batch independently', () => {
  const { texts } = run([
    ['photoReview', NOON],
    ['appeal', NOON + MIN],
    ['evidence', NOON + 2 * MIN],
    ['photoReview', NOON + 3 * MIN],
  ])
  assert.equal(texts.length, 3)
})

test('new accounts and completed profiles batch over 30 minutes, with the span', () => {
  const s = optedIn()
  let state = emptyState()
  const texts: string[] = []
  for (const [type, now, detail] of [
    ['newAccount', NOON, {}],
    ['newAccount', NOON + 5 * MIN, {}],
    ['newAccount', NOON + 6 * MIN, {}],
    ['profileCompleted', NOON + 7 * MIN, { spark: 1 }],
    ['profileCompleted', NOON + 8 * MIN, { play: 1 }],
    ['profileCompleted', NOON + 9 * MIN, { play: 1 }],
  ] as [AdminEvent, number, Record<string, number>][]) {
    const out = onEvent(state, s, type, 1, detail, now)
    state = out.state
    texts.push(...out.texts)
  }
  assert.deepEqual(texts, ['Zylove admin: 1 new account. zylove.app/admin/activity', 'Zylove admin: 1 profile completed (1 Spark). zylove.app/admin/activity'])
  assert.deepEqual(flush(state, s, NOON + 20 * MIN).texts, [])
  const out = flush(state, s, NOON + 40 * MIN)
  assert.deepEqual(out.texts, [
    'Zylove admin: 2 new accounts in the last 40 min. zylove.app/admin/activity',
    'Zylove admin: 2 profiles completed (2 Play). zylove.app/admin/activity',
  ])
})

// ─── Daily cap ───────────────────────────────────────────────────────────────

test(`after ${DAILY_CAP} texts in a day: one cap notice, then held until a catch-up summary at 8 AM`, () => {
  const s = optedIn()
  let state: AdminNotifyState = emptyState()
  const texts: string[] = []
  // 25 sends: alternate types every 11 minutes.
  const types: AdminEvent[] = ['reportNew', 'photoReview', 'appeal', 'evidence', 'deletionRequest']
  for (let i = 0; i < DAILY_CAP; i++) {
    const out = onEvent(state, s, types[i % types.length], 1, {}, at(8) + i * 11 * MIN)
    state = out.state
    texts.push(...out.texts)
  }
  assert.equal(texts.length, DAILY_CAP)
  const t1 = at(14)
  let out = onEvent(state, s, 'founderMessage', 1, {}, t1)
  assert.deepEqual(out.texts, [CAP_NOTICE])
  out = onEvent(out.state, s, 'founderMessage', 1, {}, t1 + MIN)
  out = onEvent(out.state, s, 'newAccount', 1, {}, t1 + 2 * MIN)
  assert.deepEqual(out.texts, [], 'no second cap notice')
  // Still held after midnight, until 8 AM.
  assert.deepEqual(flush(out.state, s, at(23)).texts, [])
  assert.deepEqual(flush(out.state, s, at(7, 55, 9)).texts, [])
  const morning = flush(out.state, s, at(8, 0, 9))
  assert.deepEqual(morning.texts, ['Zylove admin since last night: 2 founder messages, 1 new account. zylove.app/admin'])
  assert.equal(morning.state.pausedUntil, null)
  // The new day counts from that summary.
  assert.equal(morning.state.day.sent, 1)
})

test('F-070: a cap hit before 8 AM starts a fresh count when the pause lifts', () => {
  const s = optedIn()
  // Capped at 3 AM on the 9th: paused until 8 AM the same day.
  let state = normalizeState({ day: { date: '2026-10-09', sent: DAILY_CAP }, pausedUntil: at(8, 0, 9) })
  let out = onEvent(state, s, 'reportNew', 1, {}, at(3, 0, 9))
  assert.deepEqual(out.texts, [])
  const morning = flush(out.state, s, at(8, 0, 9))
  assert.equal(morning.texts.length, 1, 'the catch-up summary')
  assert.equal(morning.state.pausedUntil, null)
  assert.equal(morning.state.day.sent, 1, 'counted from the summary, not from the cap')
  // The next alert that morning texts — it isn't paused again until tomorrow.
  state = morning.state
  out = onEvent(state, s, 'photoReview', 1, {}, at(9, 0, 9))
  assert.equal(out.texts.length, 1)
  assert.equal(out.state.pausedUntil, null)
})

test('F-070: urgent texts count once per reported person per hour', () => {
  const s = optedIn()
  let state = emptyState()
  const texts: string[] = []
  for (let i = 0; i < 30; i++) {
    const out = onEvent(state, s, 'reportUrgent', 1, {}, NOON + i * MIN, 'victim')
    state = out.state
    texts.push(...out.texts)
  }
  assert.equal(texts.length, 1, 'thirty reports about one person: one text')
  // Someone else is texted about at once; the same person again after an hour.
  assert.equal(onEvent(state, s, 'reportUrgent', 1, {}, NOON + 31 * MIN, 'someone-else').texts.length, 1)
  assert.equal(onEvent(state, s, 'reportUrgent', 1, {}, NOON + 61 * MIN, 'victim').texts.length, 1)
})

test('urgent texts go through past the daily cap', () => {
  const s = optedIn()
  const state = normalizeState({ day: { date: '2026-10-08', sent: DAILY_CAP }, pausedUntil: at(8, 0, 9) })
  const out = onEvent(state, s, 'scamSuspend', 1, {}, at(15))
  assert.deepEqual(out.texts, ['Zylove admin URGENT: 1 account auto-suspended for scam reports. zylove.app/admin/trust'])
})

// ─── Quiet hours ─────────────────────────────────────────────────────────────

test('quiet hours hold non-urgent texts and send one summary when they end', () => {
  const s = optedIn()
  s.quietHours.enabled = true
  let state = emptyState()
  const texts: string[] = []
  const night: [AdminEvent, number, Record<string, number>][] = [
    ['newAccount', at(22, 30), {}],
    ['newAccount', at(23), {}],
    ['profileCompleted', at(1, 0, 9), { spark: 1 }],
    ['photoReview', at(3, 0, 9), {}],
    ['newAccount', at(4, 0, 9), {}],
  ]
  for (const [type, now, detail] of night) {
    const out = onEvent(state, s, type, 1, detail, now)
    state = out.state
    texts.push(...out.texts)
    state = flush(state, s, now + 5 * MIN).state
  }
  assert.deepEqual(texts, [])
  assert.deepEqual(flush(state, s, at(6, 55, 9)).texts, [])
  const out = flush(state, s, at(7, 0, 9))
  assert.deepEqual(out.texts, ['Zylove admin overnight: 1 photo to review, 3 new accounts, 1 profile completed. zylove.app/admin'])
  assert.deepEqual(flush(out.state, s, at(7, 5, 9)).texts, [], 'sent once')
})

test('urgent texts go through during quiet hours', () => {
  const s = optedIn()
  s.quietHours.enabled = true
  for (const type of ['childSafety', 'scamSuspend', 'reportUrgent', 'evidenceExpiring'] as AdminEvent[]) {
    assert.equal(onEvent(emptyState(), s, type, 1, {}, at(2, 0, 9)).texts.length, 1, type)
  }
})

test('quiet hours off: nothing held at night', () => {
  assert.equal(run([['photoReview', at(2, 0, 9)]]).texts.length, 1)
})

// ─── Urgent ──────────────────────────────────────────────────────────────────

test('urgent events skip the batching window', () => {
  const { texts } = run([
    ['childSafety', NOON],
    ['childSafety', NOON + MIN],
    ['reportUrgent', NOON + 2 * MIN],
  ])
  assert.deepEqual(texts, [
    'Zylove admin URGENT: 1 child-safety report needs review now. zylove.app/admin/reports',
    'Zylove admin URGENT: 1 child-safety report needs review now. zylove.app/admin/reports',
    'Zylove admin URGENT: 1 urgent report (felt unsafe / aggressive). zylove.app/admin/reports',
  ])
})

test('urgent runaway guard: past 10 in an hour, one text per 15 minutes with a count', () => {
  const s = optedIn()
  let state = emptyState()
  const texts: string[] = []
  for (let i = 0; i < 14; i++) {
    const out = onEvent(state, s, 'reportUrgent', 1, {}, NOON + i * MIN)
    state = out.state
    texts.push(...out.texts)
  }
  assert.equal(texts.length, 10)
  // The 10th went at minute 9: nothing until minute 24.
  assert.deepEqual(flush(state, s, NOON + 23 * MIN).texts, [])
  assert.deepEqual(flush(state, s, NOON + 24 * MIN).texts, ['Zylove admin URGENT: 4 urgent reports (felt unsafe / aggressive). zylove.app/admin/reports'])
})

// ─── Privacy and length ──────────────────────────────────────────────────────

const GSM7 = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/

function everyText(): string[] {
  const out: string[] = []
  for (const [type, def] of Object.entries(EVENTS)) {
    for (const n of [1, 2, 9999]) {
      const detail: Record<string, number> = type === 'trustFlag' ? { scam: n, photo: n, device: n, contact: n, other: n } : type === 'profileCompleted' ? { spark: n, play: n } : {}
      out.push(def.text(n, detail, null), def.text(n, detail, 999))
    }
  }
  out.push(CAP_NOTICE)
  out.push(summaryText('overnight', (Object.keys(EVENTS) as AdminEvent[]).map((t) => [t, 9999])))
  return out
}

test('every text is one GSM-7 segment: under 160 characters, no arrows or emoji', () => {
  for (const t of everyText()) {
    assert.ok(t.length <= 160, `${t.length}: ${t}`)
    assert.match(t, GSM7, t)
  }
})

test('no personal data in any text: only a type, counts and a link', () => {
  // Fixture identities that must never appear (the templates take none).
  const fixtures = ['Jordan', 'Austin', '+15125550123', '5125550123', 'user@example.com', 'seed-abc123', 'zbot-xyz']
  for (const t of everyText()) {
    assert.match(t, /^Zylove admin/, t)
    assert.equal(/@/.test(t), false, t)
    assert.equal(/\d{5,}/.test(t), false, `digit run in: ${t}`)
    for (const f of fixtures) assert.equal(t.includes(f), false, t)
    // Every link is into admin.
    for (const link of t.match(/\b[\w.]+\.\w+\/\S*/g) ?? []) assert.match(link, /^zylove\.app\/admin/, t)
  }
})

test('texts sent through the pipeline also pass the scan', () => {
  const s = optedIn()
  s.quietHours.enabled = true
  let state = emptyState()
  const texts: string[] = []
  const types = Object.keys(EVENTS) as AdminEvent[]
  for (let i = 0; i < 200; i++) {
    const out = onEvent(state, s, types[i % types.length], 1, types[i % types.length] === 'profileCompleted' ? { play: 1 } : {}, at(20) + i * 2 * MIN)
    state = out.state
    texts.push(...out.texts)
    const f = flush(state, s, at(20) + i * 2 * MIN + MIN)
    state = f.state
    texts.push(...f.texts)
  }
  assert.ok(texts.length > 10)
  for (const t of texts) {
    assert.ok(t.length <= 160, t)
    assert.equal(/\d{5,}/.test(t), false, t)
  }
})

test('a long summary is trimmed with "+ more"', () => {
  const t = summaryText('overnight', (Object.keys(EVENTS) as AdminEvent[]).map((x) => [x, 9999]))
  assert.ok(t.includes('+ more'), t)
  assert.ok(t.length <= 160)
})
