'use client'

import { useCallback, useEffect, useState } from 'react'
import { BTN_GHOST, BTN_GOLD, INPUT, LABEL, PANEL, PageBanner, SectionTitle, SignInCard, Badge } from '@/components/admin/ui'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
// Same key AdminPage writes, so signing in there signs you in here (same tab).
const SESSION_KEY = 'valor-admin-session'

interface AdminGroup { id: string; slug: string; name: string; active: boolean; members: number }
interface BoardEntry { rank: number; wallet_address: string; username: string | null; waves: number; joined_at: string }
interface AdminSeason { id: string; name: string; starts_at: string; ends_at: string | null; prize_pool_g: number; payout_status: string; payout_group: string | null }
interface Board { group: { slug: string; name: string }; season: { id: string; name: string } | null; entries: BoardEntry[] }

function loadToken(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as { token: string; expires_at: number }
    return s.expires_at * 1000 > Date.now() ? s.token : null
  } catch {
    return null
  }
}

// Top three get a medal so the people who are about to be paid stand out on the board.
const MEDAL: Record<number, string> = { 1: '#fde047', 2: '#cbd5e1', 3: '#d97706' }

export default function AdminGroupsPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [groups, setGroups] = useState<AdminGroup[]>([])
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [seasons, setSeasons] = useState<AdminSeason[]>([])
  const [pickSeason, setPickSeason] = useState('')
  const [pickGroup, setPickGroup] = useState('')

  useEffect(() => { setToken(loadToken()); setReady(true) }, [])

  const authed = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } }),
    [token],
  )

  const load = useCallback(async () => {
    const res = await authed('/admin/groups')
    if (res.ok) setGroups((await res.json()).groups ?? [])
    else if (res.status === 401) setToken(null)
  }, [authed])

  const loadSeasons = useCallback(async () => {
    const res = await authed('/admin/groups/seasons')
    if (res.ok) {
      const list: AdminSeason[] = (await res.json()).seasons ?? []
      setSeasons(list)
      setPickSeason((cur) => cur || list[0]?.id || '')
    }
  }, [authed])

  useEffect(() => { if (token) { void load(); void loadSeasons() } }, [token, load, loadSeasons])

  async function setPayoutGroup(slugOrNull: string | null) {
    if (!pickSeason) return
    const s = seasons.find((x) => x.id === pickSeason)
    const label = slugOrNull ? `Pay the prize of "${s?.name}" to ${slugOrNull} members only?` : `Clear the group restriction on "${s?.name}"?`
    if (!window.confirm(label)) return
    setMsg(null)
    const res = await authed(`/admin/seasons/${pickSeason}/payout-group`, { method: 'POST', body: JSON.stringify({ slug: slugOrNull }) })
    const j = await res.json().catch(() => ({}))
    setMsg(res.ok ? 'Saved.' : (j as { error?: string }).error ?? 'Could not save')
    if (res.ok) await loadSeasons()
  }

  async function create() {
    setMsg(null)
    const res = await authed('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: slug.trim().toLowerCase(), name: name.trim(), description: description.trim() }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok) { setSlug(''); setName(''); setDescription(''); setMsg('Group created.'); await load() }
    else setMsg((j as { error?: string }).error ?? 'Could not create group')
  }

  async function showBoard(s: string) {
    if (open === s) { setOpen(null); setBoard(null); return }
    setOpen(s); setBoard(null)
    const res = await fetch(`${API}/groups/${encodeURIComponent(s)}/board?limit=100`)
    if (res.ok) setBoard(await res.json())
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const totalMembers = groups.reduce((s, g) => s + g.members, 0)

  if (!ready) return null
  if (!token) {
    return <SignInCard title="Groups admin" body="Sign in on the Season ops page first, then come back here in the same tab." href="/admin" cta="Go to Season ops" />
  }

  const selectedSeason = seasons.find((x) => x.id === pickSeason)

  return (
    <div className="w-full flex flex-col gap-8">
      <PageBanner
        kicker="Community"
        title="Groups"
        sub="Schools and communities. Each has a join link and its own leaderboard, and a season prize can be restricted to one group."
        aside={<>
          <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
            <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Groups</p>
            <p className="font-[family-name:var(--font-family-display)] font-black text-3xl leading-none mt-1.5 tabular-nums bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">{groups.length}</p>
          </div>
          <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
            <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Members</p>
            <p className="font-[family-name:var(--font-family-display)] font-black text-3xl leading-none mt-1.5 tabular-nums bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">{totalMembers.toLocaleString()}</p>
          </div>
        </>}
      />

      {msg && (
        <div role="status" className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200 flex items-center justify-between gap-3">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} aria-label="Dismiss" className="text-amber-400/70 hover:text-amber-300 text-lg leading-none">×</button>
        </div>
      )}

      <div className="grid lg:grid-cols-12 gap-6 items-start">
      <section className="lg:col-span-7 flex flex-col gap-3 min-w-0">
        <SectionTitle>Your groups</SectionTitle>
        {groups.length === 0 && <p className="text-slate-600 text-sm">No groups yet. Create the first one below.</p>}
        {groups.map((g) => {
          const link = `${origin}/join/${g.slug}`
          const isOpen = open === g.slug
          return (
            <div key={g.id} className={`${PANEL} ${isOpen ? 'border-amber-500/30' : ''} transition-colors`}>
              <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
                <div className="w-10 h-10 shrink-0 rounded-xl grid place-items-center border border-amber-500/30 bg-amber-500/10 font-[family-name:var(--font-family-display)] font-black text-amber-300">
                  {g.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-bold flex items-center gap-2 flex-wrap">
                    {g.name}
                    <Badge tone="slate">{g.members} member{g.members === 1 ? '' : 's'}</Badge>
                    {!g.active && <Badge tone="red">inactive</Badge>}
                  </p>
                  <p className="text-slate-500 text-xs truncate font-mono mt-0.5">{link}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => void navigator.clipboard?.writeText(link).then(() => setMsg(`Copied ${link}`))} className={BTN_GHOST}>Copy link</button>
                  <button onClick={() => void showBoard(g.slug)} className={isOpen ? BTN_GOLD : BTN_GHOST}>{isOpen ? 'Hide board' : 'Board'}</button>
                </div>
              </div>

              {isOpen && (
                <div className="mt-4 pt-4 border-t border-valor-border/70">
                  {!board ? <p className="text-slate-600 text-sm">loading…</p> : (
                    <>
                      <p className="text-[10px] uppercase tracking-[0.22em] font-bold text-slate-500 mb-2.5">
                        {board.season ? `Season: ${board.season.name}` : 'No season yet'}
                      </p>
                      {board.entries.length === 0 ? <p className="text-slate-600 text-sm">No scores yet.</p> : (
                        <div className="flex flex-col rounded-xl border border-valor-border overflow-hidden bg-black/25">
                          {board.entries.map((e) => (
                            <div key={e.wallet_address} className={`flex items-center gap-3 px-3 py-2 text-sm border-b border-valor-border/60 last:border-0 ${e.rank <= 3 ? 'bg-amber-500/[0.04]' : ''}`}>
                              <span className="w-7 h-7 shrink-0 grid place-items-center rounded-full text-[11px] font-black tabular-nums"
                                style={MEDAL[e.rank] ? { background: `${MEDAL[e.rank]}22`, color: MEDAL[e.rank], border: `1px solid ${MEDAL[e.rank]}55` } : { color: '#64748b' }}>
                                {e.rank}
                              </span>
                              <span className="text-white w-28 truncate font-semibold">{e.username ?? '(no username)'}</span>
                              <span className="flex-1 text-slate-500 text-xs font-mono truncate">{e.wallet_address}</span>
                              <span className="text-amber-300 font-black tabular-nums">{e.waves}<span className="text-slate-600 font-normal text-[10px] ml-0.5">w</span></span>
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-[10px] text-slate-600 mt-3">Full wallets shown so you can confirm the top 3 are real members before paying.</p>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </section>

        <div className="lg:col-span-5 flex flex-col gap-6 min-w-0 lg:sticky lg:top-24">
      <section className="flex flex-col gap-3">
        <SectionTitle>Season prize goes to</SectionTitle>
        <div className={`${PANEL} flex flex-col gap-3`}>
          <p className="text-slate-500 text-xs">Everyone can play and appears on the board. This limits who is paid. Set it before you run the payout; it locks once winners are committed.</p>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Season</span>
            <select value={pickSeason} onChange={(e) => setPickSeason(e.target.value)} className={INPUT}>
              {seasons.map((s) => (
                <option key={s.id} value={s.id} className="bg-black">
                  {s.name} · {s.prize_pool_g.toLocaleString()} G$ · {s.payout_group ? `${s.payout_group} only` : 'overall board'}
                </option>
              ))}
            </select>
          </label>
          {selectedSeason && (
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-500">
              <Badge tone={selectedSeason.payout_group ? 'gold' : 'slate'}>{selectedSeason.payout_group ? `${selectedSeason.payout_group} only` : 'overall board'}</Badge>
              <Badge tone={selectedSeason.payout_status === 'paid' ? 'green' : 'slate'}>{selectedSeason.payout_status}</Badge>
              <span>{selectedSeason.prize_pool_g.toLocaleString()} G$ pool</span>
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Group</span>
            <select value={pickGroup} onChange={(e) => setPickGroup(e.target.value)} className={INPUT}>
              <option value="" className="bg-black">Choose a group…</option>
              {groups.map((g) => <option key={g.id} value={g.slug} className="bg-black">{g.name}</option>)}
            </select>
          </label>
          <div className="flex gap-3">
            <button onClick={() => void setPayoutGroup(pickGroup)} disabled={!pickSeason || !pickGroup} className={`${BTN_GOLD} flex-1 py-2.5`}>
              Pay this group only
            </button>
            <button onClick={() => void setPayoutGroup(null)} disabled={!pickSeason} className={`${BTN_GHOST} py-2.5`}>
              Clear
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>New group</SectionTitle>
        <div className={`${PANEL} flex flex-col gap-3`}>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Slug</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. unilag, becomes /join/unilag" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Display name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. UNILAG" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Description <span className="normal-case tracking-normal text-slate-600 font-normal">(optional)</span></span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="University of Lagos" className={INPUT} />
          </label>
          <button onClick={() => void create()} disabled={!slug.trim() || !name.trim()} className={`${BTN_GOLD} py-2.5 mt-1`}>
            Create group
          </button>
        </div>
      </section>
        </div>
      </div>
    </div>
  )
}
