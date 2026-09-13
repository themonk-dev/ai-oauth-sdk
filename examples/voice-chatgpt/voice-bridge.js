/**
 * A GPT Live voice call on a ChatGPT subscription, brokered by `codex app-server`.
 *
 * Codex already knows how to open a realtime WebRTC call against
 * `chatgpt.com/backend-api/codex` with a subscription token. This file speaks
 * its JSON-RPC protocol over stdio, hands it the browser's SDP offer, and
 * returns the answer. Audio then flows browser ↔ OpenAI directly; this process
 * only sees control messages (handoffs to the execution agent, tool calls).
 *
 * Verified against the openai/codex app-server protocol on 2026-09-13:
 *   initialize → thread/start → thread/realtime/start {transport: webrtc, version: v3}
 *   ← thread/realtime/sdp {sdp}          (the answer)
 *   ← thread/realtime/itemAdded          (handoff_request items)
 *   ← thread/realtime/error | closed
 *   → item/tool/call                     (server asks us to run a dynamic tool)
 *
 * This is a private ChatGPT transport, not the public Realtime API. It can
 * change without notice.
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { chatgptPlanType, codexAuthJson } from '@ai-oauth-sdk/core'

const SPEAK_TOOL = 'speak_to_user'

const DEFAULT_EXECUTION_INSTRUCTIONS =
  'You are the execution side of one native realtime voice assistant. Requests arrive inside ' +
  '<realtime_delegation>. Use dynamic tools whenever private data or an external action is needed. ' +
  'After completing a request, call speak_to_user exactly once with a concise result.'

const DEFAULT_REALTIME_PROMPT =
  'You are the native realtime voice surface of one assistant. Keep speech natural, concise, and ' +
  'interruptible. Answer ordinary conversation directly. For requests requiring tools, private data, ' +
  'or actions, use the native backend handoff to the execution agent.'

/** Only what a child process needs to reach the network; no app secrets. */
const INHERITED_ENV = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
]

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

export class CodexVoiceSession {
  id = crypto.randomUUID()
  #options
  #listeners = new Set()
  #process
  #home
  #threadId
  #requestId = 0
  #pending = new Map()
  #waiters = new Map()
  #closed = false
  #closePromise

  /**
   * @param {object} options
   * @param {string} options.codexBin           path to the `codex` executable
   * @param {{accessToken: string, accountId: string, idToken?: string, refreshToken?: string}} options.tokens
   * @param {() => Promise<{accessToken: string, accountId: string, idToken?: string}>} [options.refreshTokens]
   * @param {Array<{name: string, description: string, inputSchema: object}>} [options.tools]
   * @param {(call: {callId: string, name: string, arguments: object}) => Promise<unknown>} [options.executeTool]
   * @param {string} [options.executionInstructions]
   * @param {string} [options.realtimePrompt]
   */
  constructor(options) {
    if (!options.tokens?.accessToken || !options.tokens?.accountId) {
      throw new TypeError('A ChatGPT access token and account id are required.')
    }

    this.#options = { tools: [], ...options }
  }

  /** Exchanges the browser's SDP offer for the answer. Resolves once GPT Live has the call. */
  async start({ sdp, voice = 'juniper', model, reasoningEffort = 'low' }) {
    if (!sdp?.trim()) {
      throw new TypeError('`sdp` must be a non-empty WebRTC offer.')
    }

    if (this.#process) {
      throw new Error('Session already started.')
    }

    const home = join(tmpdir(), `ai-oauth-voice-${this.id}`)
    await mkdir(home, { recursive: false, mode: 0o700 })
    this.#home = home

    try {
      await this.#writeAuth(this.#options.tokens)
      // The feature flag reads as "removed" in codex ≥ 0.154 (it is on by default now) but is still accepted.
      this.#process = spawn(this.#options.codexBin, ['--enable', 'realtime_conversation', 'app-server', '--stdio'], {
        cwd: home,
        env: Object.fromEntries([
          ['CODEX_HOME', home],
          ['RUST_LOG', process.env.RUST_LOG ?? 'warn'],
          ...INHERITED_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
        ]),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.#process.once('error', (error) => this.#onProcessStop(error))
      this.#process.once('exit', () => this.#onProcessStop(new Error('codex app-server exited.')))
      this.#process.stdin.on('error', (error) => this.#onProcessStop(error))
      createInterface({ input: this.#process.stdout }).on('line', (line) => this.#onLine(line))
      createInterface({ input: this.#process.stderr }).on('line', (line) => {
        if (/ERROR|WARN/.test(line)) {this.#emit({ type: 'log', message: line.replace(/\x1b\[[0-9;]*m/g, '') })}
      })

      // codex derives its upstream User-Agent from clientInfo. The desktop app
      // is the client ChatGPT Voice ships in, so present as it does.
      await this.#call('initialize', {
        clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version: '1' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: true,
          mcpServerOpenaiFormElicitation: true,
          optOutNotificationMethods: [],
        },
      })
      this.#notify('initialized', {})

      const instructions = this.#options.executionInstructions ?? DEFAULT_EXECUTION_INSTRUCTIONS
      const thread = await this.#call('thread/start', {
        cwd: home,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        threadSource: 'realtime_voice',
        baseInstructions: instructions,
        developerInstructions: instructions,
        dynamicTools: [...this.#options.tools.map((t) => ({ type: 'function', ...t })), speakTool()],
        ...(model ? { model } : {}),
        config: { model_reasoning_effort: reasoningEffort },
      })
      this.#threadId = thread?.thread?.id

      if (typeof this.#threadId !== 'string') {
        throw new Error('app-server returned no thread id.')
      }

      // The answer arrives as a notification, not in the start result. Wait for
      // either it or an error so a refused call fails now rather than after a timeout.
      const answer = this.#waitFor('thread/realtime/sdp', 'thread/realtime/error', 30_000)
      await this.#call('thread/realtime/start', {
        threadId: this.#threadId,
        outputModality: 'audio',
        clientManagedHandoffs: false,
        flushTranscriptTailOnSessionEnd: true,
        codexResponsesAsItems: false,
        includeStartupContext: false,
        prompt: this.#options.realtimePrompt ?? DEFAULT_REALTIME_PROMPT,
        transport: { type: 'webrtc', sdp },
        version: 'v3',
        voice,
      }, 45_000)
      const { sdp: answerSdp } = await answer

      if (typeof answerSdp !== 'string' || !answerSdp.trimStart().startsWith('v=0')) {
        throw new Error('app-server returned an invalid SDP answer.')
      }

      this.#emit({ type: 'session.started' })

      return answerSdp
    } catch (error) {
      await this.close().catch(() => {})
      throw error
    }
  }

  onEvent(listener) {
    this.#listeners.add(listener)

    return () => this.#listeners.delete(listener)
  }

  /** Speaks text through the live call (used for tool results). */
  async speak(text) {
    if (!this.#threadId || !text?.trim()) {
      return
    }

    await this.#call('thread/realtime/appendSpeech', { threadId: this.#threadId, text: text.trim() })
  }

  close() {
    return (this.#closePromise ??= this.#closeInternal())
  }

  async #closeInternal() {
    this.#closed = true

    try {
      if (this.#threadId && this.#process?.exitCode === null) {
        await this.#call('thread/realtime/stop', { threadId: this.#threadId }, 5_000).catch(() => {})
      }

      try {
        this.#process?.stdin.end()
      } catch {
        // already gone
      }

      const proc = this.#process

      if (proc && proc.exitCode === null && proc.signalCode === null) {
        if (!(await exited(proc, 2_000))) {
          proc.kill('SIGTERM')

          if (!(await exited(proc, 2_000))) {
            proc.kill('SIGKILL')
          }
        }
      }
    } finally {
      this.#rejectAll(new Error('Voice session closed.'))

      try {
        if (this.#home) {await rm(this.#home, { recursive: true, force: true })}
      } finally {
        this.#emit({ type: 'session.closed' })
      }
    }
  }

  async #writeAuth(tokens) {
    // `codexAuthJson` encodes what codex requires of this file (a claims JWT
    // for id_token, a string for refresh_token); a null in either makes codex
    // silently run unauthenticated.
    await writeFile(join(this.#home, 'auth.json'), JSON.stringify(codexAuthJson(tokens)), { mode: 0o600 })
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  #onLine(line) {
    let message

    try { message = JSON.parse(line) } catch { return }

    const { id, method } = message
    const hasId = typeof id === 'string' || typeof id === 'number'

    if (hasId && ('result' in message || 'error' in message) && this.#pending.has(id)) {
      const pending = this.#pending.get(id)
      clearTimeout(pending.timer)
      this.#pending.delete(id)

      if (message.error) {pending.reject(new Error(message.error.message ?? `${pending.method} failed`))}
      else {pending.resolve(message.result)}

      return
    }

    if (typeof method !== 'string') {
      return
    }

    const params = isRecord(message.params) ? message.params : {}

    for (const waiter of this.#waiters.get(method) ?? []) {
      waiter(params)
    }

    if (hasId) {
      this.#onServerRequest(id, method, params).catch((error) => this.#onProcessStop(error))
    } else {
      this.#onNotification(method, params)
    }
  }

  async #onServerRequest(id, method, params) {
    try {
      if (method === 'attestation/generate') {
        // Not a Codex desktop build; the server accepts an explicit "unsupported" token.
        this.#send({ id, result: { token: unsupportedAttestationToken() } })

        return
      }

      if (method === 'account/chatgptAuthTokens/refresh') {
        const fresh = await this.#options.refreshTokens?.()

        if (!fresh?.accessToken || !fresh.accountId) {
          throw new Error('Token refresh is not available for this session.')
        }

        await this.#writeAuth({ ...this.#options.tokens, ...fresh })
        this.#send({ id, result: { accessToken: fresh.accessToken, chatgptAccountId: fresh.accountId, chatgptPlanType: chatgptPlanType(fresh) } })

        return
      }

      if (method === 'item/tool/call') {
        await this.#onToolCall(id, params)

        return
      }

      this.#send({ id, error: { code: -32601, message: `Unsupported request: ${method}` } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (method === 'item/tool/call') {
        this.#send({ id, result: toolResponse({ status: 'error', message }, false) })
        this.#emit({ type: 'tool.failed', callId: params.callId, name: params.tool, message })
      } else {
        this.#send({ id, error: { code: -32000, message } })
        this.#emit({ type: 'error', message })
      }
    }
  }

  async #onToolCall(id, params) {
    const { callId, tool: name } = params
    const args = isRecord(params.arguments) ? params.arguments : {}

    if (typeof callId !== 'string' || typeof name !== 'string') {
      throw new Error('Invalid dynamic-tool request.')
    }

    this.#emit({ type: 'tool.running', callId, name })

    if (name === SPEAK_TOOL) {
      if (typeof args.text !== 'string' || !args.text.trim()) {
        throw new Error('speak_to_user requires text.')
      }

      await this.speak(args.text)
      this.#send({ id, result: toolResponse({ status: 'spoken' }) })
      this.#emit({ type: 'tool.completed', callId, name })

      return
    }

    if (!this.#options.tools.some((t) => t.name === name)) {throw new Error(`Unregistered tool: ${name}`)}

    if (!this.#options.executeTool) {
      throw new Error('No executeTool handler configured.')
    }

    const output = await this.#options.executeTool({ callId, name, arguments: args })
    this.#send({ id, result: toolResponse(output) })
    this.#emit({ type: 'tool.completed', callId, name })
  }

  #onNotification(method, params) {
    if (method === 'thread/realtime/itemAdded') {
      const item = isRecord(params.item) ? params.item : {}

      if (item.type === 'handoff_request') {
        this.#emit({ type: 'handoff', transcript: String(item.input_transcript ?? item.input ?? '') })
      }
    } else if (method === 'thread/realtime/error') {
      this.#emit({ type: 'error', message: String(params.message ?? 'The realtime service reported an error.') })
    } else if (method === 'thread/realtime/closed') {
      void this.close().catch(() => {})
    }
  }

  #call(method, params, timeoutMs = 30_000) {
    const id = ++this.#requestId

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}.`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })

      try {
        this.#send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  /** Resolves with the first `okMethod` notification, rejects on `errorMethod` or timeout. */
  #waitFor(okMethod, errorMethod, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.#waiters.get(okMethod)?.delete(onOk)
        this.#waiters.get(errorMethod)?.delete(onError)
        this.#waiters.get('$close')?.delete(onClose)
      }
      const onOk = (params) => { cleanup(); resolve(params) }
      const onError = (params) => { cleanup(); reject(new Error(String(params.message ?? 'Realtime start failed.'))) }
      const onClose = (error) => { cleanup(); reject(error) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${okMethod}.`)) }, timeoutMs)

      for (const [m, fn] of [[okMethod, onOk], [errorMethod, onError], ['$close', onClose]]) {
        if (!this.#waiters.has(m)) {
          this.#waiters.set(m, new Set())
        }

        this.#waiters.get(m).add(fn)
      }
    })
  }

  #notify(method, params) { this.#send({ method, params }) }

  #send(message) {
    if (!this.#process?.stdin.writable) {
      throw new Error('codex app-server is not running.')
    }

    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onProcessStop(error) {
    if (!this.#closed) {this.#emit({ type: 'error', message: `codex app-server stopped: ${error.message}` })}

    this.#rejectAll(error)
    void this.close().catch(() => {})
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer); pending.reject(error)
    }

    this.#pending.clear()

    for (const fn of this.#waiters.get('$close') ?? []) {
      fn(error)
    }

    this.#waiters.clear()
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A listener must not break the protocol loop.
      }
    }
  }
}

function speakTool() {
  return {
    type: 'function',
    name: SPEAK_TOOL,
    description: 'Speak one concise result through the active native GPT Live session.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  }
}

function toolResponse(output, success = true) {
  const text = JSON.stringify(output)

  if (text === undefined) {
    throw new TypeError('Tool output must be JSON-serializable.')
  }

  return { success, contentItems: [{ type: 'inputText', text }] }
}

function exited(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { proc.removeListener('exit', onExit); resolve(false) }, timeoutMs)
    proc.once('exit', onExit)
  })
}

/** A CBOR map `{error_code: 1, bundle_id: "com.openai.codex"}`, the shape codex uses for "no attestation". */
function unsupportedAttestationToken() {
  const text = (s) => Uint8Array.from([0x60 + s.length, ...Buffer.from(s)])
  const bytes = Uint8Array.from([0xa2, ...text('error_code'), 0x01, ...text('bundle_id'), ...text('com.openai.codex')])

  return `v1.${Buffer.from(bytes).toString('base64url')}`
}
