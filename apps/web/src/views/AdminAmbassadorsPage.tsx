'use client'

import { useCallback, useEffect, useState } from 'react'
import { BTN_GHOST, BTN_GOLD, INPUT, LABEL, PANEL, PageBanner, SectionTitle, SignInCard, Badge } from '@/components/admin/ui'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const SESSION_KEY = 'valor-admin-session'

interface Ambassador { code: string; wallet: string; name: string; location: string; active: boolean; verified: number; last_7d: number }

function loadToken(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as { token: string; expires_at: number }
    return s.expires_at * 1000 > Date.now() ? s.token : null
  } catch { return null }
}

export default function AdminAmbassadorsPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [list, setList] = useState<Ambassador[]>([])
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [username, setUsername] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => { setToken(loadToken()); setReady(true) }, [])

  const authed = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } }),
    [token],
  )

  const load = useCallback(async () => {
    const res = await authed('/admin/ambassadors')
    if (res.ok) setList((await res.json()).ambassadors ?? [])
    else if (res.status === 401) setToken(null)
  }, [authed])

  useEffect(() => { if (token) void load() }, [token, load])

  async function create() {
    setMsg(null)
    const res = await authed('/admin/ambassadors', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim().toLowerCase(), name: name.trim(), location: location.trim(), username: username.trim() }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok) { setCode(''); setName(''); setLocation(''); setUsername(''); setMsg('Ambassador added.'); await load() }
    else setMsg((j as { error?: string }).error ?? 'Could not add ambassador')
  }

  async function toggle(a: Ambassador) {
    await authed(`/admin/ambassadors/${a.code}/active`, { method: 'POST', body: JSON.stringify({ active: !a.active }) })
    await load()
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const total = list.reduce((s, a) => s + a.verified, 0)

  // Totals per location, so you can see which school brings in the most.
  const byLocation = new Map<string, number>()
  list.forEach((a) => byLocation.set(a.location || 'No location', (byLocation.get(a.location || 'No location') ?? 0) + a.verified))
  const locations = [...byLocation.entries()].sort((a, b) => b[1] - a[1])

  if (!ready) return null
  if (!token) {
    return <SignInCard title="Ambassadors admin" body="Sign in on the Season ops page first, then come back here in the same tab." href="/admin" cta="Go to Season ops" />
  }

  return (
    <div className="w-full flex flex-col gap-8">
      <PageBanner
        kicker="Community"
        title="Ambassadors"
        sub="Each ambassador has a code and a link. A player counts once they are GoodDollar-verified and signed up with it."
        aside={
          <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
            <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Verified players brought in</p>
            <p className="font-[family-name:var(--font-family-display)] font-black text-3xl leading-none mt-1.5 tabular-nums bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">{total.toLocaleString()}</p>
          </div>
        }
      />

      {msg && (
        <div role="status" className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200 flex items-center justify-between gap-3">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} aria-label="Dismiss" className="text-amber-400/70 hover:text-amber-300 text-lg leading-none">×</button>
        </div>
      )}

      <div className="grid lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 flex flex-col gap-3 min-w-0">
          <SectionTitle>Leaderboard</SectionTitle>
          {list.length === 0 && <p className="text-slate-600 text-sm">No ambassadors yet. Add the first one.</p>}
          {list.map((a, i) => {
            const link = `${origin}/a/${a.code}`
            return (
              <div key={a.code} className={PANEL}>
                <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
                  <span className="w-8 h-8 shrink-0 grid place-items-center rounded-full text-xs font-black tabular-nums text-slate-400 border border-valor-border">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-bold flex items-center gap-2 flex-wrap">
                      {a.name}
                      {a.location && <Badge tone="slate">{a.location}</Badge>}
                      {!a.active && <Badge tone="red">off</Badge>}
                    </p>
                    <p className="text-slate-500 text-xs mt-0.5">code <span className="font-mono text-amber-300">{a.code}</span> · <span className="font-mono">{link}</span></p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-amber-300 font-black text-xl tabular-nums leading-none">{a.verified}</p>
                    <p className="text-[10px] text-slate-500 mt-1">+{a.last_7d} this week</p>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => void navigator.clipboard?.writeText(link).then(() => setMsg(`Copied ${link}`))} className={BTN_GHOST}>Copy link</button>
                  <button onClick={() => void toggle(a)} className={BTN_GHOST}>{a.active ? 'Turn off' : 'Turn on'}</button>
                </div>
              </div>
            )
          })}
        </section>

        <div className="lg:col-span-5 flex flex-col gap-6 min-w-0 lg:sticky lg:top-24">
          <section className="flex flex-col gap-3">
            <SectionTitle>Add an ambassador</SectionTitle>
            <div className={`${PANEL} flex flex-col gap-3`}>
              <p className="text-slate-500 text-xs">They must already have a Valor account and be verified. Use their in-game username.</p>
              <label className="flex flex-col gap-1.5"><span className={LABEL}>Player username</span>
                <input value={username} onChange={(e) => setUsername(e.target.value)} className={INPUT} placeholder="Metacourier1" /></label>
              <label className="flex flex-col gap-1.5"><span className={LABEL}>Display name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} placeholder="Tobi" /></label>
              <label className="flex flex-col gap-1.5"><span className={LABEL}>School or location</span>
                <input value={location} onChange={(e) => setLocation(e.target.value)} className={INPUT} placeholder="UI Ibadan" /></label>
              <label className="flex flex-col gap-1.5"><span className={LABEL}>Code (said out loud, 3-24 letters, digits, dashes)</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} className={INPUT} placeholder="tobi-ui" /></label>
              <button onClick={() => void create()} disabled={!code || !name || !username} className={`${BTN_GOLD} disabled:opacity-40`}>Add ambassador</button>
            </div>
          </section>

          {locations.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionTitle>By location</SectionTitle>
              <div className={`${PANEL} flex flex-col gap-2`}>
                {locations.map(([loc, n]) => (
                  <div key={loc} className="flex items-center justify-between text-sm">
                    <span className="text-slate-300">{loc}</span>
                    <span className="text-amber-300 font-black tabular-nums">{n}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
