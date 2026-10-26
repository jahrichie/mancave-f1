import { useEffect, useState } from 'react'
import type { ChampionshipRow, LeaderboardRow, RaceState, SessionInfo } from '../../shared/types.ts'
import { api, useRaceStream } from './api.ts'

const ROW_HEIGHT = 44
const SPEEDS = [1, 4, 16, 60]

export function App() {
  const msg = useRaceStream()
  const [state, setState] = useState<RaceState | null>(null)

  useEffect(() => {
    if (msg?.type === 'state') setState(msg.state)
  }, [msg])

  const overlay = msg?.type === 'loading' || msg?.type === 'error' ? msg : null

  return (
    <div className="app">
      {state ? <Header state={state} /> : <header className="header"><h1>Mancave F1</h1></header>}
      {state && <Controls state={state} />}
      {overlay && <div className={`banner ${overlay.type}`}>{overlay.message}</div>}
      {state && (
        <main className="panels">
          <Leaderboard rows={state.leaderboard} />
          <Championship rows={state.championship} sessionName={state.session.session_name} />
        </main>
      )}
    </div>
  )
}

function Header({ state }: { state: RaceState }) {
  const { session } = state
  return (
    <header className="header">
      <div className="title">
        <span className={`mode ${state.mode}`}>{state.mode === 'live' ? '● LIVE' : 'REPLAY'}</span>
        <h1>
          {session.location} <span className="muted">{session.session_name} · {session.year}</span>
        </h1>
      </div>
      <div className="lap">
        LAP <strong>{state.lap || '–'}</strong>
        {state.total_laps && <span className="muted">/{state.total_laps}</span>}
      </div>
      <div className={`status status-${state.track_status.split(' ')[0].toLowerCase()}`}>{state.track_status}</div>
      {state.last_message && <div className="message">{state.last_message}</div>}
    </header>
  )
}

function Controls({ state }: { state: RaceState }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [year, setYear] = useState(state.session.year)
  const { clock } = state
  const start = Date.parse(clock.start)
  const end = Date.parse(clock.end)
  const now = Date.parse(clock.now)

  useEffect(() => {
    api.sessions(year).then(setSessions)
  }, [year])

  return (
    <div className="controls">
      <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
        {[2023, 2024, 2025, 2026].map((y) => <option key={y}>{y}</option>)}
      </select>
      <select
        value={state.session.session_key}
        onChange={(e) => api.replay(Number(e.target.value))}
      >
        {!sessions.some((s) => s.session_key === state.session.session_key) && (
          <option value={state.session.session_key}>{state.session.location} {state.session.session_name}</option>
        )}
        {sessions.map((s) => (
          <option key={s.session_key} value={s.session_key}>
            {s.date_start.slice(5, 10)} {s.location} {s.session_name}
          </option>
        ))}
      </select>

      {state.mode === 'replay' && (
        <>
          <button onClick={() => api.control({ playing: !clock.playing })}>{clock.playing ? '❚❚' : '▶'}</button>
          {SPEEDS.map((s) => (
            <button key={s} className={clock.speed === s ? 'active' : ''} onClick={() => api.control({ speed: s })}>
              {s}×
            </button>
          ))}
          <input
            className="scrubber"
            type="range"
            min={start}
            max={end}
            step={1000}
            value={now}
            onChange={(e) => api.control({ seek: Number(e.target.value) })}
          />
          <span className="muted elapsed">{formatElapsed(now - start)}</span>
        </>
      )}
      {state.live_available && state.mode !== 'live' && (
        <button className="go-live" onClick={() => api.live()}>● Go live</button>
      )}
    </div>
  )
}

// Rows are absolutely positioned and slide to their new slot, so overtakes animate.
function slotLayout<T>(rows: T[], key: (r: T) => number) {
  return {
    height: rows.length * ROW_HEIGHT,
    style: (index: number) => ({ transform: `translateY(${index * ROW_HEIGHT}px)` }),
    sorted: [...rows].map((r, i) => ({ r, i })).sort((a, b) => key(a.r) - key(b.r)),
  }
}

function Leaderboard({ rows }: { rows: LeaderboardRow[] }) {
  const slots = slotLayout(rows, (r) => r.driver_number)
  return (
    <section className="panel">
      <h2>Race</h2>
      <div className="grid-head leaderboard-cols">
        <span>Pos</span><span>Driver</span><span>Gap</span><span>Int</span><span>Last</span><span>Tyre</span><span>Pits</span><span>Pts</span>
      </div>
      <div className="rows" style={{ height: slots.height }}>
        {slots.sorted.map(({ r, i }) => (
          <div key={r.driver_number} className={`row leaderboard-cols ${r.out ? 'out' : ''}`} style={slots.style(i)}>
            <span className="pos">{r.out ? 'OUT' : r.position ?? '–'}</span>
            <Driver acronym={r.acronym} name={r.team_name} colour={r.team_colour} />
            <span className="num">{i === 0 && !r.out ? 'Leader' : formatGap(r.gap_to_leader)}</span>
            <span className="num muted">{i === 0 ? '' : formatGap(r.interval)}</span>
            <span className="num muted">{formatLap(r.last_lap_time)}</span>
            <TyreBadge row={r} />
            <span className="num muted">{r.pit_stops}</span>
            <span className={`num points ${r.points_for_position ? '' : 'zero'}`}>
              {r.points_for_position ? `+${r.points_for_position}` : '–'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function Championship({ rows, sessionName }: { rows: ChampionshipRow[]; sessionName: string }) {
  const slots = slotLayout(rows, (r) => r.driver_number)
  return (
    <section className="panel">
      <h2>Drivers' championship <span className="muted">if the {sessionName.toLowerCase()} ended now</span></h2>
      <div className="grid-head champ-cols">
        <span>Pos</span><span></span><span>Driver</span><span>Before</span><span>+Race</span><span>Total</span>
      </div>
      <div className="rows" style={{ height: slots.height }}>
        {slots.sorted.map(({ r, i }) => {
          const moved = r.position_start - r.position_projected
          return (
            <div key={r.driver_number} className="row champ-cols" style={slots.style(i)}>
              <span className="pos">{r.position_projected}</span>
              <span className={`delta ${moved > 0 ? 'up' : moved < 0 ? 'down' : ''}`}>
                {moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : ''}
              </span>
              <Driver acronym={r.acronym} name={r.full_name} colour={r.team_colour} />
              <span className="num muted">{formatPoints(r.points_start)}</span>
              <span className={`num points ${r.points_gained ? '' : 'zero'}`}>{r.points_gained ? `+${r.points_gained}` : '–'}</span>
              <span className="num total">{formatPoints(r.points_projected)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Driver({ acronym, name, colour }: { acronym: string; name: string; colour: string }) {
  return (
    <span className="driver">
      <span className="team-bar" style={{ background: colour }} />
      <strong>{acronym}</strong>
      <span className="muted team">{name}</span>
    </span>
  )
}

const COMPOUNDS: Record<string, string> = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' }

function TyreBadge({ row }: { row: LeaderboardRow }) {
  if (!row.tyre) return <span className="muted">–</span>
  const { compound, age } = row.tyre
  return (
    <span className="tyre" title={`${compound}, ${age} laps old`}>
      <span className={`compound c-${compound.toLowerCase()}`}>{COMPOUNDS[compound] ?? '?'}</span>
      <span className="muted">{age}L</span>
    </span>
  )
}

function formatGap(v: number | string | null): string {
  if (v === null) return ''
  return typeof v === 'number' ? `+${v.toFixed(3)}` : v
}

function formatLap(seconds: number | null): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  return `${m}:${(seconds - m * 60).toFixed(3).padStart(6, '0')}`
}

function formatPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1)
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
