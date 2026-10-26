import { useEffect, useState } from 'react'
import type { SessionInfo, StreamMessage } from '../../shared/types.ts'

export function useRaceStream(): StreamMessage | null {
  const [msg, setMsg] = useState<StreamMessage | null>(null)
  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => setMsg(JSON.parse(e.data) as StreamMessage)
    return () => es.close()
  }, [])
  return msg
}

async function post(path: string, body: unknown = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText)
}

export const api = {
  sessions: async (year: number): Promise<SessionInfo[]> => (await fetch(`/api/sessions?year=${year}`)).json(),
  replay: (session_key: number) => post('/api/replay', { session_key }),
  live: () => post('/api/live'),
  control: (body: { playing?: boolean; speed?: number; seek?: number }) => post('/api/control', body),
}
