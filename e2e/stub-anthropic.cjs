// TEST HARNESS ONLY (preloaded into emulator function processes via
// NODE_OPTIONS). Answers requests to api.anthropic.com with a canned reply so
// AI paths (bot replies, openers, bios) run offline, and the T&S Phase 2
// photo checks (Sightengine for e2e-* photos, Vision, the metadata token).
// Every other request is untouched.
const realFetch = globalThis.fetch
if (realFetch && !globalThis.__anthropicStub) {
  globalThis.__anthropicStub = true
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    if (url.startsWith('https://nominatim.openstreetmap.org/')) {
      return new Response(JSON.stringify({ address: { city: 'Austin', 'ISO3166-2-lvl4': 'US-TX' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // T&S Phase 2 photo checks: only photos named e2e-* are answered (so the
    // other tests keep Sightengine unreachable → pending review). e2e-ai*:
    // AI-generated; e2e-stolen*: found on the web; e2e-nsfw*: over the
    // nudity limits (a content flag, F-081); any other e2e-*: clean.
    if (url.startsWith('http://metadata.google.internal/')) {
      return new Response(JSON.stringify({ access_token: 'e2e-token', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith('https://api.sightengine.com/') && init?.body instanceof FormData) {
      const name = init.body.get('media')?.name ?? ''
      if (name.startsWith('e2e-')) {
        const body = {
          status: 'success',
          nudity: name.startsWith('e2e-nsfw')
            ? { sexual_activity: 0.95, sexual_display: 0.95, erotica: 0.9, very_suggestive: 0.99 }
            : { sexual_activity: 0.01, sexual_display: 0.01, erotica: 0.01, very_suggestive: 0.01 },
          gore: { prob: 0.01 }, offensive: { prob: 0.01 }, faces: [{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }],
          type: { ai_generated: name.startsWith('e2e-ai') ? 0.97 : 0.02, deepfake: 0.01 },
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
    }
    if (url.startsWith('https://vision.googleapis.com/')) {
      const uri = JSON.parse(String(init?.body ?? '{}')).requests?.[0]?.image?.source?.imageUri ?? ''
      const stolen = /\/e2e-stolen[^/]*$/.test(uri)
      const page = { url: 'https://stock.example/photo-page', fullMatchingImages: [{ url: 'https://stock.example/photo.jpg' }] }
      const webDetection = stolen ? { fullMatchingImages: [{ url: 'https://stock.example/photo.jpg' }], pagesWithMatchingImages: [page] } : {}
      return new Response(JSON.stringify({ responses: [{ webDetection }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith('https://api.anthropic.com/')) {
      // Every prompt is logged for the specs (spec 43: how big a prompt got),
      // to .cache/anthropic-requests.jsonl. A prompt naming E2E-ANTHROPIC-500
      // is answered 500 (a failed call); E2E-ANTHROPIC-LINK, with a reply the
      // output filters drop.
      let prompt = ''
      try {
        const content = JSON.parse(String(init?.body ?? '{}')).messages?.[0]?.content
        prompt = typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      } catch {}
      try {
        require('node:fs').appendFileSync(require('node:path').join(__dirname, '.cache', 'anthropic-requests.jsonl'), `${JSON.stringify({ length: prompt.length, head: prompt.slice(0, 4000) })}\n`)
      } catch {}
      if (prompt.includes('E2E-ANTHROPIC-500')) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      const text = prompt.includes('E2E-ANTHROPIC-LINK') ? 'Find me at acme.io or 512 555 0123' : 'E2E stub reply 👋'
      const body = { id: 'stub', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn',
        content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return realFetch(input, init)
  }
}
