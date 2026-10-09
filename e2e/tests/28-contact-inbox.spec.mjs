import { test, expect } from '@playwright/test'
import { resetEmulators, seedUser, signIn, offline, quietFirstRun, callAs, idTokenFor, db, Timestamp, CONTEXT, PROJECT } from './helpers.mjs'

// The /contact form through submitContactMessage (signed out, per-address
// and daily limits), the retired public forms, and the admin inbox
// (/admin/contact) with its audited callables and its admin alert
// (functions/src/contactMessages.ts). The address rules (last
// X-Forwarded-For hop, so a spoofed first hop gets no fresh allowance) and
// the field checks are unit-tested (functions/test/contactMessages.test.ts):
// the emulator has no front end appending the real hop.
const SHOTS = new URL('../../shots/', import.meta.url).pathname
const FN = `http://127.0.0.1:5311/${PROJECT}/us-central1`
const FBASE = `http://127.0.0.1:8390/v1/projects/${PROJECT}/databases/(default)/documents`

test.beforeEach(resetEmulators)

const MESSAGE = { name: 'Ann', email: 'ann@example.com', topic: 'Press or media', message: 'Hello from the contact form.' }

// A callable with no sign-in, as a visitor's browser calls it.
async function callAnon(fn, data) {
  const r = await fetch(`${FN}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || body.error) throw new Error(`${fn} → HTTP ${r.status} ${JSON.stringify(body.error ?? body)}`)
  return body.result
}

// A direct client create through the Firestore REST API (signed out, or as uid).
async function restCreate(path, fields, uid = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (uid) headers.Authorization = `Bearer ${await idTokenFor(uid)}`
  return (await fetch(`${FBASE}/${path}`, { method: 'PATCH', headers, body: JSON.stringify({ fields }) })).status
}

const messages = async () => (await db.collection('contactMessages').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const typeOf = async (uid, type) => (await db.doc(`adminNotificationState/${uid}`).get()).data()?.types?.[type] ?? null

test('contact: a signed-out visitor sends the form; the message is stored server-side with no address', async ({ browser }) => {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  const { errors } = await offline(page)
  await page.goto('/contact')
  await page.getByPlaceholder('Your name').fill('Ann')
  await page.getByPlaceholder('Email address').fill('Ann@Example.com')
  await page.locator('select').selectOption('Press or media')
  await page.getByPlaceholder('Your message').fill('Hello from the contact form.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Message received.')).toBeVisible({ timeout: 20000 })
  expect(errors).toEqual([])
  await ctx.close()

  const [m] = await messages()
  expect(m).toMatchObject({ name: 'Ann', email: 'ann@example.com', topic: 'Press or media', message: 'Hello from the contact form.', handled: false, uid: null })
  expect(m.createdAt).toBeInstanceOf(Timestamp)
  expect(Object.keys(m).sort()).toEqual(['createdAt', 'email', 'handled', 'id', 'message', 'name', 'topic', 'uid'])
  expect(JSON.stringify(m)).not.toMatch(/127\.0\.0\.1|::1/)

  // Signed in: the sender's account is kept with it.
  const me = await seedUser('Riley')
  await callAs(me.uid, 'submitContactMessage', MESSAGE)
  expect((await messages()).some((x) => x.uid === me.uid)).toBe(true)

  // Bad fields are refused.
  await expect(callAnon('submitContactMessage', { ...MESSAGE, email: 'nope' })).rejects.toThrow(/valid email/)
  await expect(callAnon('submitContactMessage', { ...MESSAGE, message: 'x'.repeat(1001) })).rejects.toThrow(/message/)
  await expect(callAnon('submitContactMessage', { ...MESSAGE, handled: true })).rejects.toThrow(/Unknown field/)
})

test('contact: the 6th message in an hour from one address is refused; the daily cap holds', async () => {
  for (let i = 0; i < 5; i++) await callAnon('submitContactMessage', { ...MESSAGE, message: `Message ${i}` })
  await expect(callAnon('submitContactMessage', MESSAGE)).rejects.toThrow(/resource-exhausted|Too many requests/i)
  expect((await messages()).length).toBe(5)
  // The rate-limit doc is keyed by a hash, never the address.
  const limits = await db.collection('rateLimits').get()
  expect(limits.docs.some((d) => /^ip_[0-9a-f]{32}$/.test(d.id) && Array.isArray(d.data().contactMessage))).toBe(true)
  expect(limits.docs.some((d) => /127\.0\.0\.1|::1/.test(d.id))).toBe(false)

  // The daily total across every address.
  await db.collection('rateLimits').doc('_contactMessages').set({ daily: Array.from({ length: 200 }, (_, i) => Date.now() - i * 1000) })
  await db.collection('rateLimits').get().then((s) => Promise.all(s.docs.filter((d) => d.id.startsWith('ip_')).map((d) => d.ref.delete())))
  await expect(callAnon('submitContactMessage', MESSAGE)).rejects.toThrow(/resource-exhausted|Too many requests/i)
  expect((await messages()).length).toBe(5)
})

test('contact: no client can create contactMessages, waitlist or foundingApplications directly', async () => {
  const me = await seedUser('Riley')
  const str = (v) => ({ stringValue: v })
  const contact = { name: str('Ann'), email: str('ann@example.com'), topic: str(''), message: str('Hi') }
  const waitlist = { email: str('ann@example.com'), source: str('web') }
  const founding = { name: str('Ann'), email: str('ann@example.com'), instagram: str(''), why: str('Because') }
  for (const uid of [null, me.uid]) {
    expect(await restCreate('contactMessages/direct', contact, uid)).toBe(403)
    expect(await restCreate(`waitlist/${encodeURIComponent('ann@example.com')}`, waitlist, uid)).toBe(403)
    expect(await restCreate(`foundingApplications/${encodeURIComponent('ann@example.com')}`, founding, uid)).toBe(403)
  }
  // Nor read one.
  await callAnon('submitContactMessage', MESSAGE)
  const [m] = await messages()
  expect((await fetch(`${FBASE}/contactMessages/${m.id}`, { headers: { Authorization: `Bearer ${await idTokenFor(me.uid)}` } })).status).toBe(403)
})

test('contact inbox: admins list, mark handled and delete (each audited); non-admins are refused; a new message alerts admins', async () => {
  const admin = await seedUser('Kim', { isAdmin: true })
  const me = await seedUser('Riley')
  await callAs(admin.uid, 'adminSetNotificationSettings', { consent: true })
  await callAnon('submitContactMessage', { ...MESSAGE, message: 'First' })
  await expect.poll(async () => (await typeOf(admin.uid, 'contactMessage'))?.lastSentAt ?? null, { timeout: 20000 }).not.toBeNull()
  await new Promise((r) => setTimeout(r, 1100))
  await callAnon('submitContactMessage', { ...MESSAGE, message: 'Second' })

  // Non-admins: every callable refused.
  const [first] = await messages()
  await expect(callAs(me.uid, 'adminListContactMessages', {})).rejects.toThrow(/Admins only/)
  await expect(callAs(me.uid, 'adminSetContactHandled', { id: first.id, handled: true })).rejects.toThrow(/Admins only/)
  await expect(callAs(me.uid, 'adminDeleteContactMessage', { id: first.id })).rejects.toThrow(/Admins only/)
  await expect(callAnon('adminListContactMessages', {})).rejects.toThrow(/unauthenticated|Login required/i)

  // Newest first, unhandled by default.
  let list = await callAs(admin.uid, 'adminListContactMessages', {})
  expect(list.messages.map((m) => m.message)).toEqual(['Second', 'First'])
  expect(list.more).toBe(false)
  const second = list.messages[0]

  await callAs(admin.uid, 'adminSetContactHandled', { id: second.id, handled: true })
  expect((await db.doc(`contactMessages/${second.id}`).get()).data()).toMatchObject({ handled: true, handledBy: admin.uid })
  expect((await callAs(admin.uid, 'adminListContactMessages', { filter: 'unhandled' })).messages.map((m) => m.message)).toEqual(['First'])
  expect((await callAs(admin.uid, 'adminListContactMessages', { filter: 'handled' })).messages.map((m) => m.message)).toEqual(['Second'])
  expect((await callAs(admin.uid, 'adminListContactMessages', { filter: 'all' })).messages.length).toBe(2)
  // And back.
  await callAs(admin.uid, 'adminSetContactHandled', { id: second.id, handled: false })
  const back = (await db.doc(`contactMessages/${second.id}`).get()).data()
  expect(back.handled).toBe(false)
  expect(back.handledBy).toBeUndefined()

  await callAs(admin.uid, 'adminDeleteContactMessage', { id: second.id })
  expect((await db.doc(`contactMessages/${second.id}`).get()).exists).toBe(false)
  list = await callAs(admin.uid, 'adminListContactMessages', { filter: 'all' })
  expect(list.messages.map((m) => m.message)).toEqual(['First'])

  const actions = (await db.collection('adminAudit').where('actor', '==', admin.uid).get()).docs.map((d) => d.data())
  for (const action of ['contact.list', 'contact.handled', 'contact.unhandled', 'contact.delete']) {
    expect(actions.some((a) => a.action === action), action).toBe(true)
  }
  expect(actions.find((a) => a.action === 'contact.delete').target).toBe(second.id)
  // The audit log holds ids, never the message or the sender.
  expect(JSON.stringify(actions)).not.toMatch(/ann@example\.com|Second|First/)
})

test('contact inbox: the admin page renders at 1280 and 390 with no sideways scroll, and marks a message handled', async ({ browser }) => {
  const admin = await seedUser('Kim', { isAdmin: true })
  await callAnon('submitContactMessage', {
    ...MESSAGE,
    email: `${'long'.repeat(20)}@example.com`,
    message: `A long message with an unbroken run: ${'x'.repeat(300)}\nand a second line.`,
  })
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ ...CONTEXT, viewport })
    const page = await ctx.newPage()
    await offline(page)
    await quietFirstRun(page, admin.uid)
    await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), admin.uid)
    await signIn(page, admin.phone, { expectPath: /\/discover/ })
    await page.goto('/settings')
    await page.getByRole('button', { name: /Contact messages/ }).click()
    await expect(page).toHaveURL(/\/admin\/contact$/)
    await expect(page.getByRole('heading', { name: 'Contact messages' })).toBeVisible()
    await expect(page.getByText('and a second line.', { exact: false })).toBeVisible({ timeout: 20000 })
    for (const btn of await page.getByRole('button', { name: /Mark handled|Delete/ }).all()) {
      const box = await btn.boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `${SHOTS}admin-contact-${viewport.width}.png`, fullPage: true })
    await ctx.close()
  }

  // A non-admin is sent away from the page.
  const me = await seedUser('Riley')
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await offline(page)
  await quietFirstRun(page, me.uid)
  await page.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), me.uid)
  await signIn(page, me.phone, { expectPath: /\/discover/ })
  await page.goto('/admin/contact')
  await expect(page).toHaveURL(/\/discover/)
  await ctx.close()

  // Marking handled from the page moves it out of "To handle".
  const actx = await browser.newContext({ ...CONTEXT, viewport: { width: 390, height: 844 } })
  const apage = await actx.newPage()
  await offline(apage)
  await quietFirstRun(apage, admin.uid)
  await apage.addInitScript((u) => sessionStorage.setItem(`zylove_profile_question_${u}`, '{}'), admin.uid)
  await signIn(apage, admin.phone, { expectPath: /\/discover/ })
  await apage.goto('/admin/contact')
  await apage.getByRole('button', { name: 'Mark handled' }).click()
  await expect(apage.getByText('Nothing to handle.')).toBeVisible({ timeout: 20000 })
  expect((await messages())[0].handled).toBe(true)
  await apage.getByRole('button', { name: 'Handled', exact: true }).click()
  await expect(apage.getByRole('button', { name: 'Mark not handled' })).toBeVisible({ timeout: 20000 })
  await actx.close()
})
