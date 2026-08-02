import { useEffect, useState } from 'react'

const COMMAND = 'npx @ai-oauth-sdk/cli login openai'

/** What the CLI actually prints, minus the ANSI colour. */
const OUTPUT = [
  '  Opening https://auth.openai.com/oauth/authorize',
  '  Waiting for the redirect',
  '✓ Signed in to ChatGPT (OpenAI)',
  '  token expires in 7h 59m',
]

const SNIPPETS = {
  node: `import { login, publicClientIds } from 'ai-oauth-sdk/node'

const { accessToken } = await login('openai', {
  clientId: publicClientIds.openai,
})`,
  browser: `import { loginWithPopup } from 'ai-oauth-sdk/browser'

// From a click handler, or the popup is blocked.
const tokens = await loginWithPopup('claude', {
  clientId,
  redirectUri,
})`,
  react: `import { popupReceiver } from 'ai-oauth-sdk/browser'
import { useAuth } from '@ai-oauth-sdk/react'

const { login, tokens } = useAuth({
  provider: 'gemini',
  clientId,
  receiver: popupReceiver(),
})`,
}

type Tab = 'terminal' | keyof typeof SNIPPETS

const TABS: { key: Tab; label: string }[] = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'node', label: 'Node' },
  { key: 'browser', label: 'Browser' },
  { key: 'react', label: 'React' },
]

const TYPING_MS = 55
const SETTLE_MS = 700
const LINE_MS = 550
const REPEAT_MS = 4200

/** Steps 0..length type the command; the rest reveal one output line each. */
const TYPED_STEPS = COMMAND.length
const LAST_STEP = TYPED_STEPS + OUTPUT.length

function delayFor(step: number) {
  if (step < TYPED_STEPS) {
    return TYPING_MS
  }

  if (step === TYPED_STEPS) {
    return SETTLE_MS
  }

  return step === LAST_STEP ? REPEAT_MS : LINE_MS
}

/**
 * Runs the whole cycle off one counter, so a single timer drives both the
 * typing and the output and the two cannot drift apart.
 */
function useTypingCycle(enabled: boolean) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!enabled) {
      return
    }

    const timer = setTimeout(
      () => setStep((current) => (current === LAST_STEP ? 0 : current + 1)),
      delayFor(step),
    )

    return () => clearTimeout(timer)
  }, [enabled, step])

  if (!enabled) {
    return { command: COMMAND, lines: OUTPUT, caret: false }
  }

  return {
    command: COMMAND.slice(0, step),
    lines: OUTPUT.slice(0, Math.max(0, step - TYPED_STEPS)),
    caret: true,
  }
}

/**
 * The animation only starts after mount, so the prerendered HTML carries the
 * finished state. Anyone with JavaScript off, or with reduced motion asked for,
 * keeps that.
 */
function useAnimationEnabled() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setEnabled(true)
    }
  }, [])

  return enabled
}

export function CodeShowcase() {
  const [tab, setTab] = useState<Tab>('terminal')
  const animated = useAnimationEnabled()
  const cycle = useTypingCycle(animated && tab === 'terminal')

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-lp-panel">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3">
        <div className="flex">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              data-active={entry.key === tab}
              className="relative cursor-pointer px-3.5 py-3.5 font-mono text-xs text-neutral-500 transition-colors hover:text-neutral-100 data-[active=true]:text-neutral-100"
            >
              {entry.label}
              {entry.key === tab && (
                <span className="absolute inset-x-2.5 -bottom-px h-0.5 bg-neutral-200" />
              )}
            </button>
          ))}
        </div>
        <span className="hidden font-mono text-[11px] text-neutral-600 sm:block">
          127.0.0.1:8976
        </span>
      </div>

      {tab === 'terminal' ? (
        <div className="min-h-[184px] overflow-x-auto px-5.5 pt-6.5 pb-8.5 font-mono text-sm leading-loose">
          <div className="whitespace-pre text-neutral-200">
            <span className="text-neutral-500">$ </span>
            {cycle.command}
            {cycle.caret && (
              <span className="ml-0.5 inline-block h-4 w-2 -translate-y-px animate-caret bg-neutral-200 align-middle" />
            )}
          </div>
          {cycle.lines.map((line) => (
            <div key={line} className="whitespace-pre text-neutral-400">
              {line}
            </div>
          ))}
        </div>
      ) : (
        <pre className="min-h-[184px] overflow-x-auto px-5.5 pt-6.5 pb-8.5 font-mono text-[13.5px] leading-[1.9] text-neutral-200">
          {SNIPPETS[tab]}
        </pre>
      )}
    </div>
  )
}
