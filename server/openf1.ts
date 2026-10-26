// Thin OpenF1 REST client: serialises requests to stay under the rate limit,
// retries on 429, and attaches a bearer token when credentials are configured.

const BASE = 'https://api.openf1.org'
const MIN_SPACING_MS = 400

// Read lazily so the server can load .env before the first request.
export function hasCredentials(): boolean {
  return Boolean(process.env.OPENF1_USERNAME && process.env.OPENF1_PASSWORD)
}

let token: { value: string; expiresAt: number } | null = null

async function getToken(): Promise<string | null> {
  if (!hasCredentials()) return null
  if (token && Date.now() < token.expiresAt - 60_000) return token.value
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: process.env.OPENF1_USERNAME!, password: process.env.OPENF1_PASSWORD! }),
  })
  if (!res.ok) throw new Error(`OpenF1 token request failed: ${res.status}`)
  const body = (await res.json()) as { access_token: string; expires_in: string }
  token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 }
  return token.value
}

let queue: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

export type Query = Record<string, string | number | undefined>

// Keys may carry their own comparison operator: { 'date>': iso } becomes `date>2026-...`.
function toSearch(query: Query): string {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}${/[<>]=?$/.test(k) ? '' : '='}${encodeURIComponent(String(v))}`)
    .join('&')
}

export function get<T>(endpoint: string, query: Query = {}): Promise<T[]> {
  const run = async (): Promise<T[]> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + MIN_SPACING_MS - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastRequestAt = Date.now()

      const headers: Record<string, string> = { accept: 'application/json' }
      const t = await getToken()
      if (t) headers.Authorization = `Bearer ${t}`

      const res = await fetch(`${BASE}/v1/${endpoint}?${toSearch(query)}`, { headers })
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
      // OpenF1 answers 404 {"detail":"No results found."} for an empty result set.
      if (res.status === 404) return []
      if (!res.ok) throw new Error(`OpenF1 ${endpoint} failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as T[]
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
