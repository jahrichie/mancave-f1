// Types shared by the server and the web client.

export type Mode = 'live' | 'replay'

export interface SessionInfo {
  session_key: number
  meeting_key: number
  session_name: string
  session_type: string
  location: string
  country_name: string
  circuit_short_name: string
  date_start: string
  date_end: string
  year: number
}

export interface Tyre {
  compound: string
  age: number
  stint: number
}

export interface LeaderboardRow {
  position: number | null
  driver_number: number
  acronym: string
  full_name: string
  team_name: string
  team_colour: string
  headshot_url: string | null
  gap_to_leader: number | string | null
  interval: number | string | null
  lap: number | null
  last_lap_time: number | null
  tyre: Tyre | null
  pit_stops: number
  out: boolean
  points_for_position: number
}

export interface ChampionshipRow {
  driver_number: number
  acronym: string
  full_name: string
  team_colour: string
  position_start: number
  points_start: number
  points_gained: number
  points_projected: number
  position_projected: number
}

export interface ClockState {
  now: string
  start: string
  end: string
  playing: boolean
  speed: number
}

export interface RaceState {
  mode: Mode
  session: SessionInfo
  clock: ClockState
  lap: number
  total_laps: number | null
  track_status: string
  last_message: string | null
  leaderboard: LeaderboardRow[]
  championship: ChampionshipRow[]
  // A race is on right now and the server has OpenF1 credentials to follow it.
  live_available: boolean
}

export type StreamMessage =
  | { type: 'state'; state: RaceState }
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string }
