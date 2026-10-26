// Owns the one session the app is showing (every screen sees the same race) and
// the clock that drives it: wall-clock time when live, a virtual clock when replaying.

import { hasCredentials } from './openf1.ts'
import { buildRaceState, indexSession, type Indexed } from './race-state.ts'
import { getSession, isFinished, listRaceSessions, loadSession, pollSession, type SessionData } from './session-data.ts'
import type { Mode, SessionInfo, StreamMessage } from '../shared/types.ts'

// 5 requests per poll; OpenF1 sponsor tier allows 60/min, so stay at ~50/min with headroom for the live check.
const LIVE_POLL_MS = 6000
const LIVE_CHECK_MS = 60_000

type Listener = (msg: StreamMessage) => void

export class Controller {
  mode: Mode = 'replay'
  ix: Indexed | null = null
  liveSession: SessionInfo | null = null
  followLive = true
  listeners = new Set<Listener>()
  last: StreamMessage = { type: 'loading', message: 'Starting…' }

  // Replay clock: virtual time = anchor + (wall time since anchoring) × speed.
  playing = true
  speed = 1
  anchorVirtual = 0
  anchorReal = 0
  start = 0
  end = 0

  pollTimer: NodeJS.Timeout | null = null
  loadToken = 0
  loading = false

  now(): number {
    if (this.mode === 'live') return Date.now()
    const t = this.playing ? this.anchorVirtual + (Date.now() - this.anchorReal) * this.speed : this.anchorVirtual
    return Math.min(Math.max(t, this.start), this.end)
  }

  reanchor(virtual = this.now()) {
    this.anchorVirtual = Math.min(Math.max(virtual, this.start), this.end)
    this.anchorReal = Date.now()
  }

  async init() {
    await this.checkLive()
    if (this.mode !== 'live') await this.replayLatest()
    setInterval(() => this.broadcastState(), 1000)
    setInterval(() => void this.checkLive(), LIVE_CHECK_MS)
  }

  async checkLive() {
    try {
      const latest = await getSession('latest')
      const now = Date.now()
      const isLive =
        latest.session_type === 'Race' &&
        now > Date.parse(latest.date_start) - 30 * 60_000 &&
        now < Date.parse(latest.date_end) + 30 * 60_000
      this.liveSession = isLive && hasCredentials() ? latest : null
      if (this.liveSession && this.followLive && (this.mode !== 'live' || this.ix?.data.session.session_key !== latest.session_key)) {
        await this.goLive()
      }
    } catch (err) {
      console.error('Live check failed:', err)
    }
  }

  async replayLatest() {
    const year = new Date().getFullYear()
    let sessions = (await listRaceSessions(year)).filter(isFinished)
    if (!sessions.length) sessions = (await listRaceSessions(year - 1)).filter(isFinished)
    const latest = sessions.sort((a, b) => a.date_start.localeCompare(b.date_start)).at(-1)
    if (!latest) throw new Error('No finished race sessions found')
    await this.replay(latest.session_key)
  }

  // Loads a session while holding off state broadcasts. Returns null if another
  // load started meanwhile, so the newer request wins.
  async load(message: string, session: () => Promise<SessionInfo>): Promise<{ data: SessionData; token: number } | null> {
    const token = ++this.loadToken
    this.stopPolling()
    this.loading = true
    this.emit({ type: 'loading', message })
    try {
      const data = await loadSession(await session(), (m) => this.emit({ type: 'loading', message: m }))
      return token === this.loadToken ? { data, token } : null
    } finally {
      if (token === this.loadToken) this.loading = false
    }
  }

  async replay(sessionKey: number) {
    this.followLive = false
    const loaded = await this.load('Loading session…', () => getSession(sessionKey))
    if (!loaded) return
    const { data } = loaded

    this.mode = 'replay'
    this.ix = indexSession(data)
    const lapStarts = data.laps.map((l) => (l.date_start ? Date.parse(l.date_start) : NaN)).filter(Number.isFinite)
    this.start = Math.min(...lapStarts) - 60_000
    this.end = Math.max(...lapStarts) + 5 * 60_000
    if (!Number.isFinite(this.start)) {
      this.start = Date.parse(data.session.date_start)
      this.end = Date.parse(data.session.date_end)
    }
    this.playing = true
    this.reanchor(this.start)
    this.broadcastState()
  }

  async goLive() {
    const live = this.liveSession
    if (!live) throw new Error('No live race session right now (or no OpenF1 credentials configured)')
    this.followLive = true
    const loaded = await this.load('Connecting to live session…', async () => live)
    if (!loaded) return
    const { data, token } = loaded

    this.mode = 'live'
    this.ix = indexSession(data)
    this.start = Date.parse(data.session.date_start)
    this.end = Date.parse(data.session.date_end)
    this.broadcastState()
    const poll = async () => {
      try {
        await pollSession(data)
        if (token === this.loadToken) this.ix = indexSession(data)
      } catch (err) {
        console.error('Live poll failed:', err)
      }
      if (token === this.loadToken) this.pollTimer = setTimeout(poll, LIVE_POLL_MS)
    }
    this.pollTimer = setTimeout(poll, LIVE_POLL_MS)
  }

  stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  control({ playing, speed, seek }: { playing?: boolean; speed?: number; seek?: number }) {
    if (this.mode !== 'replay') return
    this.reanchor(seek ?? this.now())
    if (playing !== undefined) this.playing = playing
    if (speed !== undefined && speed > 0) this.speed = speed
    this.broadcastState()
  }

  broadcastState() {
    if (!this.ix || this.loading) return
    const state = buildRaceState(this.ix, this.now(), this.mode, {
      start: new Date(this.start).toISOString(),
      end: new Date(this.end).toISOString(),
      playing: this.mode === 'live' || this.playing,
      speed: this.mode === 'live' ? 1 : this.speed,
    })
    this.emit({ type: 'state', state: { ...state, live_available: this.liveSession !== null } })
  }

  emit(msg: StreamMessage) {
    this.last = msg
    for (const l of this.listeners) l(msg)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.last)
    return () => this.listeners.delete(listener)
  }
}
