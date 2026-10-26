// Loads everything a race view needs for one session. Replay loads it all once
// (cached on disk once the session is over); live mode keeps it topped up with
// incremental polls.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { get } from './openf1.ts'
import type { SessionInfo } from '../shared/types.ts'

export interface Driver {
  driver_number: number
  name_acronym: string
  full_name: string
  team_name: string
  team_colour: string | null
  headshot_url: string | null
}
export interface Position { date: string; driver_number: number; position: number }
export interface Interval {
  date: string
  driver_number: number
  gap_to_leader: number | string | null
  interval: number | string | null
}
export interface Lap {
  driver_number: number
  lap_number: number
  date_start: string | null
  lap_duration: number | null
}
export interface Stint {
  driver_number: number
  stint_number: number
  lap_start: number | null
  lap_end: number | null
  compound: string | null
  tyre_age_at_start: number | null
}
export interface RaceControl {
  date: string
  category: string
  flag: string | null
  scope: string | null
  message: string
  lap_number: number | null
}
export interface ChampionshipEntry { driver_number: number; position: number; points: number }

export interface SessionData {
  session: SessionInfo
  drivers: Driver[]
  positions: Position[]
  intervals: Interval[]
  laps: Lap[]
  stints: Stint[]
  raceControl: RaceControl[]
  // Drivers' championship as it stood before this session started.
  championship: ChampionshipEntry[]
  totalLaps: number | null
}

const CACHE_DIR = new URL('../.cache/', import.meta.url)

export async function getSession(sessionKey: number | 'latest'): Promise<SessionInfo> {
  const [session] = await get<SessionInfo>('sessions', { session_key: sessionKey })
  if (!session) throw new Error(`Session ${sessionKey} not found`)
  return session
}

export function listRaceSessions(year: number): Promise<SessionInfo[]> {
  return get<SessionInfo>('sessions', { year, session_type: 'Race' })
}

export function isFinished(session: SessionInfo): boolean {
  return Date.parse(session.date_end) + 60 * 60_000 < Date.now()
}

const byDate = <T extends { date: string }>(a: T, b: T) => a.date.localeCompare(b.date)

export async function loadSession(
  session: SessionInfo,
  onProgress: (message: string) => void = () => {},
): Promise<SessionData> {
  const cacheFile = new URL(`session-${session.session_key}.json`, CACHE_DIR)
  if (isFinished(session)) {
    try {
      return JSON.parse(await readFile(cacheFile, 'utf8')) as SessionData
    } catch {
      // Not cached yet.
    }
  }

  const q = { session_key: session.session_key }
  onProgress('Loading drivers…')
  const drivers = await get<Driver>('drivers', q)
  onProgress('Loading positions…')
  const positions = (await get<Position>('position', q)).sort(byDate)
  onProgress('Loading intervals…')
  const intervals = (await get<Interval>('intervals', q)).sort(byDate)
  onProgress('Loading laps…')
  const laps = await get<Lap>('laps', q)
  onProgress('Loading tyres…')
  const stints = await get<Stint>('stints', q)
  onProgress('Loading race control…')
  const raceControl = (await get<RaceControl>('race_control', q)).sort(byDate)
  onProgress('Loading championship…')
  const championship = await loadChampionshipBefore(session)
  await addMissingDrivers(drivers, championship)

  const results = isFinished(session)
    ? await get<{ number_of_laps: number | null }>('session_result', q)
    : []
  const totalLaps = Math.max(0, ...results.map((r) => r.number_of_laps ?? 0)) || null

  const data: SessionData = { session, drivers, positions, intervals, laps, stints, raceControl, championship, totalLaps }
  if (isFinished(session)) {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(cacheFile, JSON.stringify(data))
  }
  return data
}

interface ChampionshipDriver {
  driver_number: number
  session_key: number
  position_start: number | null
  position_current: number | null
  points_start: number | null
  points_current: number | null
}

// Standings before `session`: its own points_start if OpenF1 has published it,
// otherwise the result of the previous points-scoring session of the season.
async function loadChampionshipBefore(session: SessionInfo): Promise<ChampionshipEntry[]> {
  const own = await get<ChampionshipDriver>('championship_drivers', { session_key: session.session_key })
  if (own.some((c) => c.points_start !== null)) {
    return own.map((c) => ({ driver_number: c.driver_number, position: c.position_start ?? 0, points: c.points_start ?? 0 }))
  }

  const earlier = (await listRaceSessions(session.year))
    .filter((s) => s.date_start < session.date_start)
    .sort((a, b) => b.date_start.localeCompare(a.date_start))
  for (const prev of earlier) {
    const rows = await get<ChampionshipDriver>('championship_drivers', { session_key: prev.session_key })
    if (rows.length) {
      return rows.map((c) => ({ driver_number: c.driver_number, position: c.position_current ?? 0, points: c.points_current ?? 0 }))
    }
  }
  return []
}

// Championship drivers who aren't racing this session (e.g. replaced) still need a name.
async function addMissingDrivers(drivers: Driver[], championship: ChampionshipEntry[]) {
  const known = new Set(drivers.map((d) => d.driver_number))
  for (const { driver_number } of championship) {
    if (known.has(driver_number)) continue
    const rows = await get<Driver>('drivers', { driver_number })
    const latest = rows.at(-1)
    drivers.push(
      latest ?? { driver_number, name_acronym: `#${driver_number}`, full_name: `Car ${driver_number}`, team_name: '', team_colour: null, headshot_url: null },
    )
  }
}

// Live mode: pull everything newer than what we hold. Laps are re-read for the
// last few minutes because a lap row is created at the start of the lap and
// only gets its duration once it's completed.
export async function pollSession(data: SessionData): Promise<void> {
  const q = { session_key: data.session.session_key }
  const lastDate = <T extends { date: string }>(rows: T[]) => rows.at(-1)?.date ?? data.session.date_start

  data.positions.push(...(await get<Position>('position', { ...q, 'date>': lastDate(data.positions) })).sort(byDate))
  data.intervals.push(...(await get<Interval>('intervals', { ...q, 'date>': lastDate(data.intervals) })).sort(byDate))
  data.raceControl.push(...(await get<RaceControl>('race_control', { ...q, 'date>': lastDate(data.raceControl) })).sort(byDate))
  data.stints = await get<Stint>('stints', q)

  const since = new Date(Date.now() - 5 * 60_000).toISOString()
  for (const lap of await get<Lap>('laps', { ...q, 'date_start>': since })) {
    const i = data.laps.findIndex((l) => l.driver_number === lap.driver_number && l.lap_number === lap.lap_number)
    if (i >= 0) data.laps[i] = lap
    else data.laps.push(lap)
  }
}
