import { popupReceiver } from '@ai-oauth-sdk/browser'
import { useAuth } from '@ai-oauth-sdk/react'
import { RiAddLine, RiArrowDownSLine, RiArrowUpLine, RiLock2Line } from '@remixicon/react'
import { useEffect, useRef, useState } from 'react'

import { demoProviders, reachableCount, type DemoProvider } from '@/lib/demo-providers'
import { ProviderMark } from './provider-mark'
import { streamReply, listModels } from './transport'

import type { FormEvent } from 'react'

export interface Message {
  role: 'user' | 'assistant'
  text: string
}

const EMPTY = 'Nothing here yet. Ask something and the session behind it does the rest.'

/**
 * One provider is active at a time, so one `useAuth` covers the flow. The rail's
 * other badges come from what is already in storage, which is a read rather than
 * eight more clients.
 */
export function Playground() {
  const [activeId, setActiveId] = useState(demoProviders[0]!.id)
  const [providersOpen, setProvidersOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState<string>()
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const threadRef = useRef<HTMLDivElement>(null)

  const active = demoProviders.find((entry) => entry.id === activeId) ?? demoProviders[0]!

  const { login, logout, tokens, isLoading } = useAuth({
    provider: active.id,
    ...(active.reachable?.requiresClientId ? { clientId: clientIdFor(active.id) } : {}),
    receiver: popupReceiver(),
  })

  const locked = !tokens

  // Newest message first became visible, so only follow the tail when the reader
  // is already there. Yanking them back mid-scroll is worse than not following.
  useEffect(() => {
    const el = threadRef.current

    if (el && el.scrollHeight - el.clientHeight - el.scrollTop > 4) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (!tokens?.accessToken) {
      setModels([])

      return
    }

    let live = true

    listModels(active, tokens.accessToken).then(
      (found) => {
        if (live) {
          setModels(found)
          setModel((current) => (current && found.includes(current) ? current : found[0]))
        }
      },
      () => {
        if (live) {
          setModels(active.reachable?.models ?? [])
        }
      },
    )

    return () => {
      live = false
    }
  }, [active, tokens?.accessToken])

  const select = (id: string) => {
    setActiveId(id)
    setProvidersOpen(false)
    setPickerOpen(false)
    setFailure(undefined)
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()

    const text = draft.trim()

    if (!text || busy || locked || !model) {
      return
    }

    const history = [...messages, { role: 'user' as const, text }]
    setMessages([...history, { role: 'assistant', text: '' }])
    setDraft('')
    setBusy(true)
    setFailure(undefined)

    try {
      for await (const chunk of streamReply(active, tokens.accessToken, model, history)) {
        setMessages((current) => {
          const next = [...current]
          const last = next[next.length - 1]!
          next[next.length - 1] = { ...last, text: last.text + chunk }

          return next
        })
      }
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : String(caught))
      setMessages((current) => current.slice(0, -1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-lp-line bg-lp-bg">
      <div className="flex items-center justify-between gap-3 border-b border-lp-line px-4 py-3">
        <div className="relative flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setProvidersOpen((open) => !open)
              setPickerOpen(false)
            }}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 transition-colors hover:bg-lp-hover"
          >
            <ProviderMark provider={active} />
            <RiArrowDownSLine className="size-3.5 text-lp-dim" />
          </button>

          <span className="flex items-center gap-2 font-mono text-xs text-lp-dim">
            <span
              className={`inline-block size-1.5 rounded-full ${locked ? 'bg-lp-tick' : 'bg-lp-fg'}`}
            />
            {locked ? 'not connected' : 'connected'}
          </span>

          {providersOpen && (
            <div className="absolute top-11 left-0 z-20 w-72 overflow-hidden rounded-xl border border-lp-line bg-lp-bg shadow-lg">
              <div className="border-b border-lp-line px-3 py-2 font-mono text-[11px] tracking-[0.04em] text-lp-faint uppercase">
                Providers · {reachableCount} reachable from a page
              </div>
              {demoProviders.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={!entry.reachable}
                  onClick={() => select(entry.id)}
                  title={entry.blockedBy}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors not-disabled:cursor-pointer not-disabled:hover:bg-lp-hover disabled:opacity-45"
                >
                  <ProviderMark provider={entry} />
                  <span className="shrink-0 font-mono text-[11px] text-lp-faint">
                    {entry.reachable ? 'available' : 'needs a server'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMessages([])}
          className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm text-lp-dim transition-colors hover:bg-lp-hover hover:text-lp-fg"
        >
          <RiAddLine className="size-3.5" />
          New chat
        </button>
      </div>

      <div className="relative">
        <div
          ref={threadRef}
          className={`h-[380px] overflow-y-auto px-6 py-6 ${locked ? 'blur-[5px]' : ''}`}
        >
          {messages.length === 0 && <p className="text-sm text-lp-faint">{EMPTY}</p>}

          <div className="flex flex-col gap-5">
            {messages.map((message, index) => (
              <div
                key={index}
                className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
              >
                <div
                  className={
                    message.role === 'user'
                      ? 'max-w-[80%] rounded-2xl bg-lp-surface px-4 py-2.5 text-sm whitespace-pre-wrap'
                      : 'max-w-[90%] text-sm leading-relaxed whitespace-pre-wrap text-lp-muted'
                  }
                >
                  {message.text || (busy ? '…' : '')}
                </div>
              </div>
            ))}
          </div>
        </div>

        {locked && <LockedOverlay provider={active} busy={isLoading} onConnect={() => login()} />}
      </div>

      {failure && (
        <p className="border-t border-lp-line px-6 py-3 text-sm text-lp-muted">{failure}</p>
      )}

      <form onSubmit={send} className="relative border-t border-lp-line p-3">
        {pickerOpen && models.length > 0 && (
          <div className="absolute bottom-16 left-3 z-20 max-h-56 w-64 overflow-y-auto rounded-xl border border-lp-line bg-lp-bg shadow-lg">
            {models.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => {
                  setModel(entry)
                  setPickerOpen(false)
                }}
                className={`block w-full cursor-pointer px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-lp-hover ${entry === model ? 'bg-lp-surface' : ''}`}
              >
                {entry}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl border border-lp-line px-3 py-2">
          <button
            type="button"
            disabled={locked || models.length === 0}
            onClick={() => setPickerOpen((open) => !open)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 font-mono text-xs text-lp-dim transition-colors not-disabled:cursor-pointer not-disabled:hover:bg-lp-hover disabled:opacity-45"
          >
            {model ?? 'no model'}
            <RiArrowDownSLine className="size-3" />
          </button>

          <textarea
            rows={1}
            value={draft}
            disabled={locked}
            placeholder={locked ? 'Connect a provider to start' : 'Ask something'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send(event)
              }
            }}
            className="min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-lp-faint"
          />

          <button
            type="submit"
            disabled={locked || busy || !draft.trim()}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-lp-button text-lp-button-fg transition-opacity not-disabled:cursor-pointer disabled:opacity-30"
          >
            <RiArrowUpLine className="size-4" />
          </button>
        </div>
      </form>

      {!locked && (
        <button
          type="button"
          onClick={() => logout()}
          className="w-full cursor-pointer border-t border-lp-line px-6 py-2.5 text-left font-mono text-[11px] text-lp-faint transition-colors hover:text-lp-fg"
        >
          Signed in{tokens.email ? ` as ${tokens.email}` : ''} · sign out
        </button>
      )}
    </div>
  )
}

function LockedOverlay({
  provider,
  busy,
  onConnect,
}: {
  provider: DemoProvider
  busy: boolean
  onConnect: () => void
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-lp-bg/60 px-8 text-center">
      <RiLock2Line className="size-5 text-lp-faint" />

      {provider.reachable ? (
        <>
          <p className="max-w-sm text-sm text-lp-muted">
            Sign in to {provider.name} in a popup. The token stays in this tab and never reaches a
            server of ours.
          </p>
          <button
            type="button"
            onClick={onConnect}
            disabled={busy}
            className="inline-flex h-10 cursor-pointer items-center rounded-lg bg-lp-button px-5 text-sm font-medium text-lp-button-fg transition-colors hover:bg-lp-button-hover disabled:opacity-60"
          >
            {busy ? 'Opening authorization…' : 'Connect now'}
          </button>
        </>
      ) : (
        <p className="max-w-md text-sm text-lp-muted">
          {provider.blockedBy}{' '}
          <a href="/docs/runtimes/browser#cors" className="underline underline-offset-4">
            Why a page cannot always finish the exchange
          </a>
          .
        </p>
      )}
    </div>
  )
}

/**
 * Google validates the redirect against the client id, and the published one is
 * a desktop client registered for loopback. A hosted page needs a Web client,
 * which is the reader's to create.
 */
function clientIdFor(id: string) {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(`demo:client-id:${id}`) ?? ''
}
