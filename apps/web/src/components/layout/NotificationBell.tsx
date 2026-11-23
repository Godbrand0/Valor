'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, MessageCircle, UserPlus, Swords, Coins, ReceiptText, Gift, Flag, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useNotifications, type NotificationItem } from '@/hooks/useNotifications'

const KIND: Record<string, { Icon: LucideIcon; color: string }> = {
  message:     { Icon: MessageCircle, color: '#38bdf8' },
  friend:      { Icon: UserPlus,      color: '#a78bfa' },
  duel:        { Icon: Swords,        color: '#f97316' },
  money:       { Icon: Coins,         color: '#eab308' },
  transaction: { Icon: ReceiptText,   color: '#22c55e' },
  claim:       { Icon: Gift,          color: '#eab308' },
  campaign:    { Icon: Flag,          color: '#ef4444' },
  drop:        { Icon: Sparkles,      color: '#c084fc' },
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** The bell in the top bar: everything that came in — messages, money,
 *  completed transactions, live campaigns, new drops, things to claim. */
export function NotificationBell({ wallet, accent }: { wallet: string; accent: string }) {
  const router = useRouter()
  const { items, unread, loading, error, signedIn, markSeen, signIn } = useNotifications(wallet)
  const [open, setOpen] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside tap / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && unread > 0) void markSeen()
  }

  const go = (n: NotificationItem) => {
    setOpen(false)
    if (n.url) router.push(n.url)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={toggle}
        className="relative flex items-center justify-center w-8 h-8 rounded transition-opacity"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', opacity: open || unread > 0 ? 1 : 0.6, color: unread > 0 ? accent : undefined }}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-black flex items-center justify-center"
            style={{ background: '#ef4444', color: '#fff', boxShadow: '0 0 0 2px rgba(4,3,12,0.95)' }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="fixed sm:absolute left-3 right-3 sm:left-auto sm:right-0 top-[calc(env(safe-area-inset-top,0px)+60px)] sm:top-10 sm:w-[360px] rounded-lg overflow-hidden z-[60]"
          style={{
            background: 'rgba(10,9,20,0.98)',
            border: '1px solid rgba(42,42,58,0.9)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
          }}
        >
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(42,42,58,0.7)' }}>
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-white">Notifications</span>
            {items.length > 0 && <span className="text-[10px] text-slate-500">{items.length}</span>}
          </div>

          <div className="max-h-[min(70vh,460px)] overflow-y-auto">
            {!signedIn ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-slate-400 mb-3">Sign in to see your messages, payments and rewards.</p>
                <button
                  onClick={async () => { setSigningIn(true); try { await signIn() } finally { setSigningIn(false) } }}
                  disabled={signingIn}
                  className="px-4 py-2 rounded text-[11px] font-black uppercase tracking-wider"
                  style={{ background: accent, color: '#04030c', opacity: signingIn ? 0.6 : 1 }}
                >
                  {signingIn ? 'Check your wallet…' : 'Sign in'}
                </button>
              </div>
            ) : loading ? (
              <p className="px-4 py-6 text-center text-xs text-slate-500">Loading…</p>
            ) : error ? (
              <p className="px-4 py-6 text-center text-xs text-slate-500">Couldn&apos;t load notifications. Try again in a moment.</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-slate-500">You&apos;re all caught up.</p>
            ) : (
              <ul>
                {items.map((n) => {
                  const k = KIND[n.kind] ?? { Icon: Bell, color: '#94a3b8' }
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => go(n)}
                        className="w-full text-left flex gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
                        style={{ borderBottom: '1px solid rgba(42,42,58,0.4)', background: n.unread ? 'rgba(234,179,8,0.04)' : undefined }}
                      >
                        <span className="mt-0.5 flex-none w-7 h-7 rounded-full flex items-center justify-center" style={{ background: `${k.color}18`, color: k.color }}>
                          <k.Icon size={14} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-start justify-between gap-2">
                            <span className="text-[13px] font-bold text-white leading-snug break-words">{n.title}</span>
                            <span className="flex-none text-[10px] text-slate-500 mt-0.5">{ago(n.created_at)}</span>
                          </span>
                          {n.body && <span className="block text-xs text-slate-400 mt-0.5 leading-snug break-words">{n.body}</span>}
                        </span>
                        {n.unread && <span className="flex-none mt-2 w-1.5 h-1.5 rounded-full" style={{ background: '#ef4444' }} aria-label="unread" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
