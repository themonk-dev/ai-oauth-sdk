/**
 * Voice on a ChatGPT subscription, with the token owned by the browser.
 *
 * The page signs in with `ai-oauth-sdk` (device flow, straight against
 * auth.openai.com — its endpoints allow browser CORS) and keeps the token in
 * `sessionStorage`, the same model as chat.themonk.dev. This server holds no
 * accounts and no session store. For a voice call the browser sends its access
 * token once, this process hands it to a private `codex app-server` for the
 * lifetime of the call, and deletes it with the call.
 *
 *   node server.js            # http://localhost:3100
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openai, publicClientIds, refreshTokens } from '@ai-oauth-sdk/core'

import { CodexVoiceSession } from './voice-bridge.js'

const PORT = Number(process.env.PORT ?? 3100)
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// The local workspace build of the SDK's CDN bundle, and the codex binary this
// example depends on. Neither needs a global install.
const sdkGlobal = join(dirname(require.resolve('ai-oauth-sdk/package.json')), 'dist/ai-oauth-sdk.global.js')
const codexBin = join(here, 'node_modules/.bin/codex')

const MAX_BODY = 256 * 1024
const SESSION_TTL_MS = 30 * 60 * 1000

/** One demo tool, so "what time is it?" shows a native handoff round-trip. */
const tools = [{
  name: 'get_local_time',
  description: "Returns the server's current local date and time.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}]
async function executeTool({ name }) {
  if (name === 'get_local_time') {return { now: new Date().toString() }}

  throw new Error(`Unknown tool ${name}`)
}

/** @type {Map<string, {session: CodexVoiceSession, owner: string, queued: object[], subscribers: Set<Function>, expires: NodeJS.Timeout}>} */
const sessions = new Map()

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let size = 0

  for await (const chunk of req) {
    size += chunk.length

    if (size > MAX_BODY) {throw Object.assign(new Error('Request body too large.'), { status: 413 })}

    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Expected a JSON body.'), { status: 400 })
  }
}

/** The browser proves ownership of a call by presenting the same bearer it started it with. */
function bearer(req) {
  const value = req.headers.authorization ?? ''

  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}
function sameSecret(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b)

  return x.length === y.length && timingSafeEqual(x, y)
}

async function closeSession(id) {
  const managed = sessions.get(id)

  if (!managed) {
    return false
  }

  sessions.delete(id)
  clearTimeout(managed.expires)
  await managed.session.close()

  return true
}

async function startVoice(req, res) {
  const accessToken = bearer(req)
  const accountId = String(req.headers['x-chatgpt-account-id'] ?? '')

  if (!accessToken || !accountId) {return json(res, 401, { error: 'not_authenticated', message: 'Send Authorization: Bearer <access token> and x-chatgpt-account-id.' })}

  const body = await readJson(req)

  if (typeof body.sdp !== 'string' || !body.sdp.trim()) {return json(res, 400, { error: 'invalid_request', message: 'Expected a non-empty `sdp`.' })}

  const voice = typeof body.voice === 'string' && /^[a-z]{2,16}$/.test(body.voice) ? body.voice : 'juniper'
  const model = typeof body.model === 'string' && body.model.length <= 64 ? body.model : undefined

  // One live call per token: starting a new one ends the previous.
  for (const [id, managed] of sessions) {if (sameSecret(managed.owner, accessToken)) {await closeSession(id)}}

  const tokens = {
    accessToken,
    accountId,
    idToken: typeof body.idToken === 'string' ? body.idToken : undefined,
    // Optional. Without it the call cannot outlive the access token.
    refreshToken: typeof body.refreshToken === 'string' ? body.refreshToken : undefined,
  }
  const session = new CodexVoiceSession({
    codexBin,
    tokens,
    tools,
    executeTool,
    ...(tokens.refreshToken
      ? {
          // codex asks for this when the access token expires mid-call. The SDK's
          // core refresh already knows OpenAI's token endpoint and body shape.
          async refreshTokens() {
            const fresh = await refreshTokens({
              provider: openai,
              clientId: publicClientIds.openai,
              tokens: { ...tokens, tokenType: 'Bearer', provider: 'openai', raw: {} },
            })
            Object.assign(tokens, { accessToken: fresh.accessToken, idToken: fresh.idToken ?? tokens.idToken, refreshToken: fresh.refreshToken ?? tokens.refreshToken })

            return { accessToken: fresh.accessToken, accountId: fresh.accountId ?? accountId, idToken: tokens.idToken }
          },
        }
      : {}),
  })
  const managed = { session, owner: accessToken, queued: [], subscribers: new Set(), expires: undefined }
  session.onEvent((event) => {
    if (managed.subscribers.size === 0) {
      managed.queued.push(event)

      if (managed.queued.length > 256) {
        managed.queued.shift()
      }
    } else {
      for (const fn of managed.subscribers) {
        fn(event)
      }
    }

    if (event.type === 'session.closed' && sessions.get(session.id) === managed) {
      sessions.delete(session.id)
      clearTimeout(managed.expires)
    }
  })

  let answer

  try {
    answer = await session.start({ sdp: body.sdp, voice, model })
  } catch (error) {
    return json(res, 502, { error: 'voice_start_failed', message: error instanceof Error ? error.message : String(error) })
  }

  managed.expires = setTimeout(() => void closeSession(session.id), SESSION_TTL_MS).unref()
  sessions.set(session.id, managed)
  json(res, 201, { sessionId: session.id, sdp: answer })
}

function ownedSession(req, res, id) {
  const managed = sessions.get(id)

  if (!managed || !sameSecret(managed.owner, bearer(req))) {
    json(res, 404, { error: 'session_not_found' })

    return undefined
  }

  return managed
}

function streamEvents(req, res, managed) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  const write = (event) => res.write(`${JSON.stringify(event)}\n`)
  const listener = (event) => {
    write(event)

    if (event.type === 'session.closed') {
      stop()
    }
  }
  const keepalive = setInterval(() => write({ type: 'keepalive' }), 15_000)
  const stop = () => {
    clearInterval(keepalive)
    managed.subscribers.delete(listener)
    res.end()
  }
  managed.subscribers.add(listener)

  for (const event of managed.queued.splice(0)) {
    write(event)
  }

  req.on('close', stop)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  try {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })

      return res.end(await readFile(join(here, 'index.html')))
    }

    if (req.method === 'GET' && path === '/vendor/ai-oauth-sdk.global.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })

      return res.end(await readFile(sdkGlobal))
    }

    if (req.method === 'POST' && path === '/api/voice/start') {
      return await startVoice(req, res)
    }

    const match = /^\/api\/voice\/([A-Za-z0-9-]+)(?:\/(events))?$/.exec(path)

    if (match) {
      const managed = ownedSession(req, res, match[1])

      if (!managed) {
        return
      }

      if (req.method === 'GET' && match[2] === 'events') {
        return streamEvents(req, res, managed)
      }

      if (req.method === 'DELETE' && !match[2]) { await closeSession(match[1]);

 return json(res, 200, { status: 'closed' }) }
    }

    json(res, 404, { error: 'not_found' })
  } catch (error) {
    json(res, error.status ?? 500, { error: 'request_failed', message: error.message })
  }
})

server.listen(PORT, () => {
  console.log(`\n  ChatGPT voice on your subscription → http://localhost:${PORT}\n  sdk:   ${sdkGlobal}\n  codex: ${codexBin}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.all([...sessions.keys()].map(closeSession))
    process.exit(0)
  })
}
