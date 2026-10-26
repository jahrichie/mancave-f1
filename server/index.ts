import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { Controller } from './controller.ts'
import { listRaceSessions } from './session-data.ts'

try {
  process.loadEnvFile()
} catch {
  // No .env file: run without OpenF1 credentials (replay only).
}

const PORT = Number(process.env.PORT ?? 3001)
const DIST = new URL('../dist/', import.meta.url)
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const controller = new Controller()

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return (raw ? JSON.parse(raw) : {}) as T
}

function stream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const unsubscribe = controller.subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`))
  req.on('close', unsubscribe)
}

async function serveStatic(path: string, res: ServerResponse) {
  const file = path === '/' || !extname(path) ? 'index.html' : path.slice(1)
  try {
    const body = await readFile(new URL(file, DIST))
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Not found (run `npm run build` to serve the UI from here, or use `npm run dev`)')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/stream':
        return stream(req, res)
      case 'GET /api/sessions': {
        const year = Number(url.searchParams.get('year') ?? new Date().getFullYear())
        const sessions = await listRaceSessions(year)
        return json(res, 200, sessions.filter((s) => Date.parse(s.date_start) < Date.now()))
      }
      case 'POST /api/replay': {
        const { session_key } = await readBody<{ session_key: number }>(req)
        controller.replay(session_key).catch((err) => controller.emit({ type: 'error', message: String(err.message ?? err) }))
        return json(res, 202, { ok: true })
      }
      case 'POST /api/live':
        await controller.goLive()
        return json(res, 200, { ok: true })
      case 'POST /api/control':
        controller.control(await readBody(req))
        return json(res, 200, { ok: true })
      default:
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
        return json(res, 404, { error: 'Not found' })
    }
  } catch (err) {
    console.error(err)
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, () => console.log(`mancave-f1 server on http://localhost:${PORT}`))
controller.init().catch((err) => {
  console.error('Startup failed:', err)
  controller.emit({ type: 'error', message: String(err.message ?? err) })
})
