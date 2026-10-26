// Builds the race view as it stood at a given instant. Replay and live mode both
// go through here; the only difference is where `now` comes from.

import type { ChampionshipRow, LeaderboardRow, Mode, RaceState, Tyre, ClockState } from '../shared/types.ts'
import type { Interval, Lap, Position, SessionData } from './session-data.ts'

const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1]

// A car that hasn't crossed the line for this many of the leader's laps is treated as retired.
const RETIRED_AFTER_LAPS = 2.5

export function pointsFor(position: number | null, sessionName: string): number {
  if (!position) return 0
  const table = sessionName === 'Sprint' ? SPRINT_POINTS : RACE_POINTS
  return table[position - 1] ?? 0
}

interface Series<T> { times: number[]; rows: T[] }

function groupByDriver<T extends { driver_number: number }>(rows: T[], time: (row: T) => string | null): Map<number, Series<T>> {
  const map = new Map<number, Series<T>>()
  for (const row of rows) {
    const t = time(row)
    if (!t) continue
    let s = map.get(row.driver_number)
    if (!s) map.set(row.driver_number, (s = { times: [], rows: [] }))
    s.times.push(Date.parse(t))
    s.rows.push(row)
  }
  for (const s of map.values()) {
    const order = s.times.map((_, i) => i).sort((a, b) => s.times[a] - s.times[b])
    s.times = order.map((i) => s.times[i])
    s.rows = order.map((i) => s.rows[i])
  }
  return map
}

// Last row at or before `now` (binary search).
function latestAt<T>(series: Series<T> | undefined, now: number): T | undefined {
  if (!series) return undefined
  let lo = 0
  let hi = series.times.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (series.times[mid] <= now) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 ? series.rows[found] : undefined
}

// Indexes are rebuilt only when the underlying data changes, not on every tick.
export interface Indexed {
  data: SessionData
  positions: Map<number, Series<Position>>
  intervals: Map<number, Series<Interval>>
  laps: Map<number, Series<Lap>>
}

export function indexSession(data: SessionData): Indexed {
  return {
    data,
    positions: groupByDriver(data.positions, (r) => r.date),
    intervals: groupByDriver(data.intervals, (r) => r.date),
    laps: groupByDriver(data.laps, (r) => r.date_start),
  }
}

function currentTyre(data: SessionData, driver: number, lap: number): { tyre: Tyre | null; pitStops: number } {
  const stints = data.stints
    .filter((s) => s.driver_number === driver && (s.lap_start ?? 1) <= Math.max(lap, 1))
    .sort((a, b) => a.stint_number - b.stint_number)
  const stint = stints.at(-1)
  if (!stint) return { tyre: null, pitStops: 0 }
  return {
    tyre: {
      compound: stint.compound ?? 'UNKNOWN',
      age: (stint.tyre_age_at_start ?? 0) + Math.max(0, lap - (stint.lap_start ?? 1)),
      stint: stint.stint_number,
    },
    pitStops: stint.stint_number - 1,
  }
}

function trackStatus(data: SessionData, now: number): { status: string; lastMessage: string | null } {
  let status = 'GREEN'
  let lastMessage: string | null = null
  for (const rc of data.raceControl) {
    if (Date.parse(rc.date) > now) break
    lastMessage = rc.message
    const msg = rc.message.toUpperCase()
    if (rc.category === 'SafetyCar') {
      if (msg.includes('VIRTUAL SAFETY CAR DEPLOYED') || msg.includes('VSC DEPLOYED')) status = 'VSC'
      else if (msg.includes('SAFETY CAR DEPLOYED')) status = 'SAFETY CAR'
      else if (msg.includes('ENDING') || msg.includes('IN THIS LAP')) status = status === 'VSC' ? 'VSC ENDING' : 'SC IN THIS LAP'
    } else if (rc.category === 'Flag' && rc.scope === 'Track') {
      if (rc.flag === 'RED') status = 'RED FLAG'
      else if (rc.flag === 'CHEQUERED') status = 'CHEQUERED'
      else if (rc.flag === 'GREEN' || rc.flag === 'CLEAR') status = 'GREEN'
    }
  }
  return { status, lastMessage }
}

export function buildRaceState(
  ix: Indexed,
  now: number,
  mode: Mode,
  clock: Omit<ClockState, 'now'>,
): Omit<RaceState, 'live_available'> {
  const { data } = ix
  const sessionName = data.session.session_name
  const { status, lastMessage } = trackStatus(data, now)

  const lapNow = new Map<number, Lap | undefined>()
  for (const d of data.drivers) lapNow.set(d.driver_number, latestAt(ix.laps.get(d.driver_number), now))

  // Retirement heuristic: the leader keeps crossing the line, this car doesn't.
  const lapStarts = [...lapNow.values()].map((l) => (l?.date_start ? Date.parse(l.date_start) : 0))
  const freshest = Math.max(0, ...lapStarts)
  const durations = data.laps.map((l) => l.lap_duration).filter((d): d is number => !!d).sort((a, b) => a - b)
  const typicalLapMs = (durations[Math.floor(durations.length / 2)] ?? 100) * 1000

  const racing = new Set(data.positions.map((p) => p.driver_number))
  const leaderboard: LeaderboardRow[] = data.drivers
    .filter((d) => racing.has(d.driver_number))
    .map((d) => {
      const lap = lapNow.get(d.driver_number)
      const lapNumber = lap?.lap_number ?? 0
      const lastStart = lap?.date_start ? Date.parse(lap.date_start) : 0
      // Measured against the freshest crossing, so a red flag (nobody crossing) doesn't retire everyone.
      const out = lapNumber > 0 && freshest - lastStart > RETIRED_AFTER_LAPS * typicalLapMs
      const position = latestAt(ix.positions.get(d.driver_number), now)?.position ?? null
      const interval = latestAt(ix.intervals.get(d.driver_number), now)
      const previousLap = ix.laps.get(d.driver_number)?.rows.findLast(
        (l) => l.lap_number < lapNumber && l.lap_duration !== null,
      )
      const { tyre, pitStops } = currentTyre(data, d.driver_number, lapNumber)
      return {
        position,
        driver_number: d.driver_number,
        acronym: d.name_acronym,
        full_name: d.full_name,
        team_name: d.team_name,
        team_colour: `#${d.team_colour ?? '888888'}`,
        headshot_url: d.headshot_url,
        gap_to_leader: interval?.gap_to_leader ?? null,
        interval: interval?.interval ?? null,
        lap: lap?.lap_number ?? null,
        last_lap_time: previousLap?.lap_duration ?? null,
        tyre,
        pit_stops: pitStops,
        out,
        points_for_position: out ? 0 : pointsFor(position, sessionName),
      }
    })
    .sort((a, b) => Number(a.out) - Number(b.out) || (a.position ?? 99) - (b.position ?? 99))

  return {
    mode,
    session: data.session,
    clock: { ...clock, now: new Date(now).toISOString() },
    lap: Math.max(0, ...leaderboard.map((r) => r.lap ?? 0)),
    total_laps: data.totalLaps,
    track_status: status,
    last_message: lastMessage,
    leaderboard,
    championship: projectChampionship(ix.data, leaderboard),
  }
}

function projectChampionship(data: SessionData, leaderboard: LeaderboardRow[]): ChampionshipRow[] {
  const gained = new Map(leaderboard.map((r) => [r.driver_number, r.points_for_position]))
  const drivers = new Map(data.drivers.map((d) => [d.driver_number, d]))
  const numbers = new Set([...data.championship.map((c) => c.driver_number), ...leaderboard.map((r) => r.driver_number)])
  const start = new Map(data.championship.map((c) => [c.driver_number, c]))

  const rows = [...numbers].map((n) => {
    const d = drivers.get(n)
    const s = start.get(n)
    const points_gained = gained.get(n) ?? 0
    return {
      driver_number: n,
      acronym: d?.name_acronym ?? `#${n}`,
      full_name: d?.full_name ?? `Car ${n}`,
      team_colour: `#${d?.team_colour ?? '888888'}`,
      position_start: s?.position || numbers.size,
      points_start: s?.points ?? 0,
      points_gained,
      points_projected: (s?.points ?? 0) + points_gained,
      position_projected: 0,
    }
  })

  // Ties keep the pre-race order (a stand-in for F1's count-back on best results).
  rows.sort((a, b) => b.points_projected - a.points_projected || a.position_start - b.position_start)
  rows.forEach((r, i) => (r.position_projected = i + 1))
  return rows
}
