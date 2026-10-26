# Mancave F1

A realtime F1 race dashboard on top of the [OpenF1 API](https://openf1.org/docs/).

- **Race leaderboard**: position, gap and interval, last lap, current tyre compound and age, pit stops, and the points each driver would score at their current position. Rows slide when positions change.
- **Drivers' championship if the race ended now**: standings before the race, plus points gained at current positions, giving a projected total and position (▲▼ vs. before the race).

## Run it

```sh
npm install
npm run dev        # server on :3001 + Vite UI on http://localhost:5173
# or
npm run build && npm start   # everything on http://localhost:3001
```

Needs Node 23.6+ (the server is TypeScript run directly by Node).

## Live vs. replay

OpenF1 historical data is free, but **live data during a session needs a paid OpenF1 account**. Put the credentials in `.env` (see `.env.example`):

- **Without credentials** the app replays the latest finished race on a virtual clock (1×–60×, scrubbable). Any 2023+ race or sprint can be picked from the dropdown.
- **With credentials**, while a race or sprint is on the server switches to live mode on its own and polls OpenF1 every 6 s (the paid tier allows 60 requests a minute). A "Go live" button appears if you're watching a replay.

Both modes go through the same code (`server/race-state.ts` builds the view for "data as of time T"), so what you see in replay is what you'll see live.

## Layout

- `server/openf1.ts`: REST client (rate-limit spacing, 429 retry, bearer token)
- `server/session-data.ts`: loads a session's data (cached in `.cache/` once finished) and does incremental live polls
- `server/race-state.ts`: builds the leaderboard and projected championship at a point in time
- `server/controller.ts`: the replay/live clock; pushes state to browsers over Server-Sent Events every second
- `web/src/`: the React UI
- `shared/types.ts`: types shared by the server and the UI

## Known approximations

- **Retirements** are inferred: a car is marked OUT when it hasn't crossed the line for 2.5 typical laps while the leader has.
- **Championship ties** keep pre-race order. F1's real tie-break counts back best results.
- **Baseline standings** come from OpenF1's beta `championship_drivers` endpoint. If a live session hasn't published them yet, the result of the previous race or sprint is used instead.
