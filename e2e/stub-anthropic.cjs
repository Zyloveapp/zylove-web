// TEST HARNESS ONLY (preloaded into emulator function processes via
// NODE_OPTIONS). Answers requests to api.anthropic.com with a canned reply so
// AI paths (bot replies, openers, bios) run offline. Every other request is
// untouched.
const realFetch = globalThis.fetch
if (realFetch && !globalThis.__anthropicStub) {
  globalThis.__anthropicStub = true
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    if (url.startsWith('https://nominatim.openstreetmap.org/')) {
      return new Response(JSON.stringify({ address: { city: 'Austin', 'ISO3166-2-lvl4': 'US-TX' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.startsWith('https://api.anthropic.com/')) {
      const body = { id: 'stub', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'E2E stub reply 👋' }], usage: { input_tokens: 1, output_tokens: 1 } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return realFetch(input, init)
  }
}
