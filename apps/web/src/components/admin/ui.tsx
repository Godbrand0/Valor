'use client'

// Shared look for the three admin screens (/admin, /admin/analytics, /admin/groups).
// Presentation only: class constants and small components, no data or business logic,
// so a page can adopt them without changing what it does.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'

/* ── class constants ─────────────────────────────────────────────────────── */

export const INPUT =
  'px-3 py-2 rounded-lg bg-black/40 border border-valor-border text-sm text-white placeholder:text-slate-600 ' +
  'focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/25 transition-colors'

export const LABEL = 'text-[10px] uppercase tracking-[0.18em] font-semibold text-slate-500'

const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold tracking-wide transition ' +
  'active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100'

export const BTN_GOLD =
  `${BTN_BASE} font-black text-black bg-linear-to-b from-amber-300 to-amber-500 ` +
  'shadow-[0_6px_18px_-8px_rgba(234,179,8,0.7)] hover:from-amber-200 hover:to-amber-400 disabled:shadow-none'
export const BTN_GHOST =
  `${BTN_BASE} text-slate-300 border border-valor-border bg-white/[0.02] hover:border-amber-500/50 hover:text-white`
export const BTN_DANGER =
  `${BTN_BASE} text-red-300 border border-red-500/35 bg-red-500/[0.04] hover:bg-red-500/10 hover:border-red-400/60`
export const BTN_WARN =
  `${BTN_BASE} text-amber-300 border border-amber-500/40 bg-amber-500/[0.04] hover:bg-amber-500/10`
export const BTN_OK =
  `${BTN_BASE} font-black text-black bg-linear-to-b from-emerald-300 to-emerald-500 hover:from-emerald-200 hover:to-emerald-400`

export const PILL =
  'px-3 py-1.5 rounded-full text-xs font-bold border transition-colors border-valor-border text-slate-400 ' +
  'hover:text-white hover:border-slate-500 bg-white/[0.02]'
export const PILL_ON =
  'px-3 py-1.5 rounded-full text-xs font-black border transition-colors border-transparent text-black ' +
  'bg-linear-to-b from-amber-300 to-amber-500 shadow-[0_4px_14px_-6px_rgba(234,179,8,0.7)]'

export const PANEL =
  'relative rounded-2xl border border-valor-border bg-linear-to-b from-[#13131c] to-[#0c0c13] p-4 sm:p-5 ' +
  'before:absolute before:inset-x-8 before:top-0 before:h-px before:bg-linear-to-r ' +
  'before:from-transparent before:via-amber-500/45 before:to-transparent before:pointer-events-none'

export const SUBPANEL = 'rounded-xl border border-valor-border/80 bg-black/25 p-3'

/* ── count-up ────────────────────────────────────────────────────────────── */

/** Eases a number up from its previous value. Snaps when the user prefers reduced motion. */
export function useCountUp(target: number, duration = 1100): number {
  const [val, setVal] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if (!Number.isFinite(target)) return
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { from.current = target; setVal(target); return }
    const start = from.current
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      const eased = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)
      setVal(start + (target - start) * eased)
      from.current = start + (target - start) * eased
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const v = useCountUp(value)
  return <>{format ? format(v) : Math.round(v).toLocaleString('en-US')}</>
}

/** 2410000 -> "2.41M"; under 100k stays exact. */
export const compact = (v: number, from = 1e5) =>
  Math.abs(v) >= from ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : Math.round(v).toLocaleString('en-US')

/* ── building blocks ─────────────────────────────────────────────────────── */

export function PageHeader({
  kicker = 'Admin', title, sub, actions,
}: { kicker?: string; title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-[0.32em] font-bold text-amber-500">{kicker}</p>
        <h1 className="font-[family-name:var(--font-family-display)] font-black text-white text-2xl sm:text-3xl tracking-wide leading-tight mt-1">{title}</h1>
        {sub && <p className="text-xs text-slate-500 mt-1.5 max-w-[60ch]">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}

/** Section heading with a hairline that fades out. */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-[11px] uppercase tracking-[0.24em] font-bold text-slate-400 min-w-0">{children}</h2>
      <div className="h-px flex-1 min-w-4 bg-linear-to-r from-valor-border to-transparent" />
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

/** A stat tile. Pass a number as `count` to animate it; `value` is shown as-is otherwise. */
export function Stat({
  label, value, count, format, sub, unit, dim,
}: { label: string; value?: ReactNode; count?: number; format?: (n: number) => string; sub?: ReactNode; unit?: string; dim?: boolean }) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-valor-border bg-linear-to-b from-[#14141d] to-[#0d0d14] p-4 flex flex-col gap-1.5 transition-colors hover:border-amber-500/40">
      <div className="absolute -top-10 -right-10 w-28 h-28 rounded-full bg-amber-500/[0.07] blur-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
      <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-bold">{label}</p>
      <p className={`font-[family-name:var(--font-family-display)] font-black text-2xl leading-none tabular-nums ${dim ? 'text-slate-600' : 'bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent'}`}>
        {count !== undefined ? <CountUp value={count} format={format} /> : value}
        {unit && <span className="ml-1.5 font-sans text-[11px] font-semibold tracking-normal text-slate-500">{unit}</span>}
      </p>
      {sub && <p className="text-[10px] text-slate-500 leading-snug">{sub}</p>}
    </div>
  )
}

export function Badge({ tone = 'slate', children }: { tone?: 'slate' | 'gold' | 'green' | 'red' | 'cyan'; children: ReactNode }) {
  const tones = {
    slate: 'text-slate-400 border-slate-600/60 bg-white/[0.03]',
    gold: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
    green: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
    red: 'text-red-300 border-red-500/40 bg-red-500/10',
    cyan: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  } as const
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** Header row for a collapsible panel. Replaces the old "▸ Title" text button. */
export function PanelToggle({
  open, onClick, title, hint,
}: { open: boolean; onClick: () => void; title: string; hint?: string }) {
  return (
    <button onClick={onClick} aria-expanded={open} className="group flex items-center gap-3 text-left w-full">
      <span className={`grid place-items-center w-6 h-6 rounded-md border border-valor-border text-amber-400 text-[10px] transition-transform ${open ? 'rotate-90' : ''} group-hover:border-amber-500/50`}>
        ▶
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] uppercase tracking-[0.22em] font-bold text-slate-300 group-hover:text-white transition-colors">{title}</span>
        {hint && <span className="block text-[11px] text-slate-600 normal-case tracking-normal font-normal mt-0.5">{hint}</span>}
      </span>
    </button>
  )
}

/** Gold-framed card used by the sign-in prompts. */
export function SignInCard({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className={`${PANEL} max-w-md mx-auto text-center py-10 px-6 flex flex-col items-center gap-3`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/valor-mark.png" alt="" className="w-14 drop-shadow-[0_0_18px_rgba(234,179,8,0.45)]" />
      <h1 className="font-[family-name:var(--font-family-display)] font-black text-xl text-white tracking-wide">{title}</h1>
      <p className="text-sm text-slate-400">{body}</p>
      <a href={href} className={`${BTN_GOLD} mt-2 px-5 py-2.5 text-sm`}>{cta}</a>
    </div>
  )
}

/** Hero banner for a page: game art behind the title, with a slot for at-a-glance cards. */
export function PageBanner({
  kicker, title, sub, actions, aside,
}: { kicker: string; title: string; sub?: ReactNode; actions?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-valor-border isolate">
      <div aria-hidden className="absolute inset-0 -z-20 opacity-55" style={{ background: 'url(/art/hero.webp) 72% 18% / cover' }} />
      <div aria-hidden className="absolute inset-0 -z-10" style={{ background: 'linear-gradient(95deg, #07070d 18%, rgba(7,7,13,0.86) 48%, rgba(7,7,13,0.35) 100%)' }} />
      <div aria-hidden className="absolute inset-x-10 top-0 h-px bg-linear-to-r from-transparent via-amber-500/60 to-transparent" />
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 p-6 sm:p-8">
        <div className="min-w-0 max-w-xl">
          <p className="text-[10px] uppercase tracking-[0.34em] font-bold text-amber-500">{kicker}</p>
          <h1 className="font-[family-name:var(--font-family-display)] font-black text-white text-3xl sm:text-4xl tracking-wide leading-tight mt-1.5">{title}</h1>
          {sub && <p className="text-sm text-slate-400 mt-2.5 leading-relaxed">{sub}</p>}
          {actions && <div className="flex items-center gap-2 flex-wrap mt-5">{actions}</div>}
        </div>
        {aside && <div className="grid sm:grid-cols-2 lg:flex lg:flex-col gap-3 lg:w-72 shrink-0">{aside}</div>}
      </div>
    </div>
  )
}

/** Slide-over panel from the right. Esc or a click on the scrim closes it. */
export function Drawer({
  open, onClose, kicker, title, sub, children,
}: { open: boolean; onClose: () => void; kicker?: string; title: string; sub?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim" className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-[2px]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
          />
          <motion.aside
            key="panel" role="dialog" aria-modal="true" aria-label={title}
            className="fixed inset-y-0 right-0 z-[71] w-full max-w-xl flex flex-col border-l border-valor-border bg-[#0a0a11] shadow-[-30px_0_60px_-30px_rgba(0,0,0,0.9)]"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 34, stiffness: 340 }}
          >
            <div className="relative flex items-start justify-between gap-4 px-6 py-5 border-b border-valor-border/80">
              <div aria-hidden className="absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-amber-500/60 to-transparent" />
              <div className="min-w-0">
                {kicker && <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-amber-500">{kicker}</p>}
                <h2 className="font-[family-name:var(--font-family-display)] font-black text-white text-xl tracking-wide mt-0.5">{title}</h2>
                {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
              </div>
              <button onClick={onClose} aria-label="Close" className="shrink-0 grid place-items-center w-8 h-8 rounded-lg border border-valor-border text-slate-400 hover:text-white hover:border-amber-500/50 transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
