'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Users, Flame, Swords, UsersRound, Eye, LogIn, UserPlus, MessageCircle, Search, Link2, Check,
  Loader2, Radio, ChevronRight, X, Globe,
} from 'lucide-react'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useFriends } from '@/hooks/useFriends'
import { useDuelsAvailable } from '@/hooks/useDuels'
import {
  useMultiplayerLobby, lobbyName, partyJoinHref, watchHref,
  type LobbyPlayer, type LobbyMatch, type LobbyParty,
} from '@/hooks/useMultiplayerLobby'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const MIN_SEARCH_LEN = 2
const SEARCH_DEBOUNCE_MS = 300

interface SearchRow {
  wallet_address: string
  username: string | null
  character_name: string
  rank: string
}

const STATUS_META: Record<LobbyPlayer['status'], { label: string; cls: string }> = {
  online: { label: 'Online', cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  in_match: { label: 'In Face-Off', cls: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
  in_party_lobby: { label: 'In party', cls: 'text-sky-300 border-sky-500/30 bg-sky-500/10' },
  in_party_run: { label: 'Playing co-op', cls: 'text-sky-300 border-sky-500/30 bg-sky-500/10' },
}

function mmss(secs: number): string {
  const m = Math.floor(secs / 60), s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function challengeQs(wallet: string, name: string): string {
  return `?challenge=${encodeURIComponent(wallet)}&name=${encodeURIComponent(name)}`
}

/**
 * MULTIPLAYER LOBBY — one place for every way to play with other people.
 *
 *   - Modes: Face-Off (live, staked), Duels (async, staked), Co-op (free party).
 *   - Live now: every live Face-Off with a public WATCH link, and every public
 *     co-op party with a JOIN button.
 *   - Online: who is on right now and what they're doing. Tapping someone opens
 *     the actions that make sense for them — join their party, watch their
 *     match, challenge them, add them as a friend, or message a friend.
 *   - Find players: search everyone (online or not) and add friends.
 *
 * Viewable signed out: the live section is public (watch links work for anyone),
 * and the actions that need an account ask the visitor to sign in.
 */
export default function MultiplayerLobbyPage() {
  const router = useRouter()
  const { status, address } = useResolvedAuth()
  const player = usePlayerStore((s) => s.player)
  const me = address?.toLowerCase() ?? null
  const signedIn = status === 'ready' && !!address && !!player

  const { data, loading, unavailable, error } = useMultiplayerLobby()
  const duelsAvailable = useDuelsAvailable()
  const { friends, outgoing, sendRequest } = useFriends(signedIn ? address : undefined)

  const friendSet = useMemo(() => new Set(friends.map((f) => f.wallet.toLowerCase())), [friends])
  const pendingSet = useMemo(() => new Set(outgoing.map((f) => f.wallet.toLowerCase())), [outgoing])
  const onlineSet = useMemo(() => new Set((data?.players ?? []).map((p) => p.wallet)), [data])

  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const addFriend = async (wallet: string) => {
    if (!signedIn) { router.push('/'); return }
    setBusy(wallet)
    try {
      const r = await sendRequest(wallet)
      setNotice({
        text: r.already
          ? (r.status === 'accepted' ? "You're already friends" : 'Request already sent')
          : r.auto_accepted ? 'You are now friends' : 'Friend request sent',
        ok: true,
      })
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Could not send request', ok: false })
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 2600)
    return () => clearTimeout(t)
  }, [notice])

  // ── Find players (everyone, not just online) ────────────────────────────────
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchRow[]>([])
  const [searching, setSearching] = useState(false)
  const latestQuery = useRef('')
  useEffect(() => {
    const q = query.trim()
    latestQuery.current = q
    if (q.length < MIN_SEARCH_LEN) { setResults([]); setSearching(false); return }
    setSearching(true)
    const h = setTimeout(() => {
      fetch(`${API}/players/search?q=${encodeURIComponent(q)}&exclude=${me ?? ''}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: SearchRow[]) => { if (latestQuery.current === q) { setResults(rows); setSearching(false) } })
        .catch(() => { if (latestQuery.current === q) setSearching(false) })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(h)
  }, [query, me])

  const players = data?.players ?? []
  const fq = filter.trim().toLowerCase()
  const shownPlayers = fq ? players.filter((p) => lobbyName(p).toLowerCase().includes(fq)) : players
  const matches = data?.matches ?? []
  const parties = data?.parties ?? []
  const openParties = parties.filter((p) => p.joinable)

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6 py-2 relative z-10">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-emerald-400 mb-1">Play together</p>
          <h1 className="font-display font-black text-white text-3xl tracking-wide">Multiplayer</h1>
          <p className="text-slate-400 text-sm mt-1 flex items-center gap-2">
            <span className="relative flex w-2 h-2">
              <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-60" />
              <span className="relative w-2 h-2 rounded-full bg-emerald-400" />
            </span>
            {data ? `${data.online_count} online · ${matches.length} live ${matches.length === 1 ? 'match' : 'matches'} · ${openParties.length} open ${openParties.length === 1 ? 'party' : 'parties'}` : 'Checking who’s online…'}
          </p>
        </div>
      </div>

      {unavailable && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-amber-200 text-sm">
          The live lobby isn’t available on this server yet. You can still start any mode below.
        </div>
      )}
      {error && !unavailable && (
        <p role="alert" className="text-red-400 text-xs font-medium">{error}</p>
      )}

      {/* ── Modes ──────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionTitle>Choose a mode</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <ModeCard
            href="/faceoff" accent="#f97316" Icon={Flame} title="Face-Off"
            blurb="Live 1v1. Stake G$, winner takes the pot."
            disabled={!duelsAvailable} disabledNote="Not available right now"
          />
          <ModeCard
            href="/duels" accent="#eab308" Icon={Swords} title="Duels"
            blurb="Same run, played on your own time. Higher score wins."
            disabled={!duelsAvailable} disabledNote="Not available right now"
          />
          <ModeCard
            href="/endless/coop" accent="#10b981" Icon={UsersRound} title="Co-op"
            blurb="Free. Team up with up to 3 others against the waves."
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/endless/coop?public=1"
            className="inline-flex items-center gap-1.5 min-h-10 px-3 rounded-lg border border-emerald-500/40 text-emerald-300 text-xs font-bold hover:bg-emerald-500/10 transition-colors">
            <Globe size={14} /> Host a public party
          </Link>
          <Link href="/endless/coop"
            className="inline-flex items-center gap-1.5 min-h-10 px-3 rounded-lg border border-valor-border text-slate-300 text-xs font-bold hover:border-emerald-500/40 transition-colors">
            <LogIn size={14} /> Join with a code
          </Link>
        </div>
      </section>

      {/* ── Live now ───────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionTitle icon={<Radio size={14} className="text-red-400" />}>Live now</SectionTitle>
        {loading && !data ? (
          <Skeleton rows={2} />
        ) : matches.length === 0 && parties.length === 0 ? (
          <Empty>No live matches or open parties right now. Host a public party and others can jump in.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {matches.map((m) => <MatchRow key={m.duel_id} m={m} />)}
            {parties.map((p) => <PartyRow key={p.code} p={p} me={me} signedIn={signedIn} />)}
          </div>
        )}
      </section>

      {/* ── Online players ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <SectionTitle icon={<Users size={14} className="text-emerald-400" />}>Online ({data?.online_count ?? 0})</SectionTitle>
          {players.length > 6 && (
            <input
              value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…" aria-label="Filter online players"
              className="ml-auto w-36 min-h-9 rounded-lg border border-valor-border bg-valor-surface-2 px-3 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
            />
          )}
        </div>
        {loading && !data ? (
          <Skeleton rows={3} />
        ) : shownPlayers.length === 0 ? (
          <Empty>{fq ? 'Nobody online matches that name.' : 'Nobody else is online right now.'}</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {shownPlayers.map((p) => (
              <PlayerRow
                key={p.wallet} p={p}
                isMe={p.wallet === me}
                isFriend={friendSet.has(p.wallet)}
                isPending={pendingSet.has(p.wallet)}
                open={selected === p.wallet}
                onToggle={() => setSelected((s) => (s === p.wallet ? null : p.wallet))}
                signedIn={signedIn}
                duelsAvailable={duelsAvailable}
                busy={busy === p.wallet}
                onAddFriend={() => void addFriend(p.wallet)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Find players ───────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionTitle icon={<Search size={14} className="text-valor-gold" />}>Find players</SectionTitle>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by username or character name"
            aria-label="Search players"
            className="w-full min-h-11 rounded-lg border border-valor-border bg-valor-surface-2 pl-9 pr-9 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-valor-gold/50"
          />
          {searching && <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 animate-spin" />}
        </div>
        {query.trim().length >= MIN_SEARCH_LEN && !searching && results.length === 0 && (
          <Empty>No players found.</Empty>
        )}
        {results.length > 0 && (
          <div className="flex flex-col gap-2">
            {results.map((r) => {
              const w = r.wallet_address.toLowerCase()
              const name = r.username || r.character_name
              const isFriend = friendSet.has(w), isPending = pendingSet.has(w)
              return (
                <div key={w} className="rounded-xl border border-valor-border bg-valor-surface px-4 py-3 flex items-center gap-3">
                  <Avatar name={name} online={onlineSet.has(w)} />
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-bold text-sm truncate">{name}</p>
                    <p className="text-slate-500 text-[11px] uppercase tracking-wider">{r.rank}{onlineSet.has(w) ? ' · online' : ''}</p>
                  </div>
                  {r.username && (
                    <Link href={`/${r.username}`} className="shrink-0 text-slate-400 hover:text-white text-xs font-bold px-2">Profile</Link>
                  )}
                  <FriendButton isFriend={isFriend} isPending={isPending} busy={busy === w}
                    onAdd={() => void addFriend(w)} wallet={w} name={name} />
                </div>
              )
            })}
          </div>
        )}
      </section>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
            role="status"
            className={`fixed left-1/2 -translate-x-1/2 bottom-24 z-50 rounded-lg px-4 py-2.5 text-sm font-bold shadow-lg ${notice.ok ? 'bg-emerald-500 text-black' : 'bg-red-500 text-white'}`}
          >
            {notice.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 font-display font-black text-white text-sm uppercase tracking-wider">
      {icon}{children}
    </h2>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-valor-border px-4 py-5 text-center text-slate-500 text-sm">{children}</p>
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 rounded-xl border border-valor-border bg-valor-surface animate-pulse" />
      ))}
    </div>
  )
}

function Avatar({ name, online }: { name: string; online?: boolean }) {
  return (
    <div className="relative shrink-0 w-9 h-9 rounded-lg bg-valor-surface-2 border border-valor-border flex items-center justify-center font-display font-black text-sm text-slate-200">
      {name.slice(0, 1).toUpperCase()}
      {online && <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#04030c]" />}
    </div>
  )
}

function ModeCard({ href, accent, Icon, title, blurb, disabled, disabledNote }: {
  href: string; accent: string; Icon: typeof Flame; title: string; blurb: string; disabled?: boolean; disabledNote?: string
}) {
  const body = (
    <>
      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${accent}1a`, border: `1px solid ${accent}40` }}>
        <Icon size={22} style={{ color: accent }} strokeWidth={1.6} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-display font-black text-white text-lg leading-tight">{title}</p>
        <p className="text-slate-400 text-xs mt-0.5">{disabled ? disabledNote : blurb}</p>
      </div>
      {!disabled && <ChevronRight size={18} className="text-slate-600 shrink-0 sm:hidden" />}
    </>
  )
  const cls = 'rounded-2xl border p-4 flex sm:flex-col sm:items-start items-center gap-3 transition-colors'
  if (disabled) {
    return <div className={`${cls} opacity-50`} style={{ background: 'rgba(8,8,14,0.9)', borderColor: 'rgba(42,42,58,0.8)' }}>{body}</div>
  }
  return (
    <Link href={href} className={`${cls} hover:brightness-110`} style={{ background: 'rgba(8,8,14,0.9)', borderColor: `${accent}55` }}>
      {body}
    </Link>
  )
}

function MatchRow({ m }: { m: LobbyMatch }) {
  const [copied, setCopied] = useState(false)
  const [a, b] = m.players
  const copy = () => {
    const url = `${window.location.origin}${watchHref(m.duel_id)}`
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return (
    <div className="rounded-xl border border-orange-500/30 bg-orange-500/[0.05] px-4 py-3 flex items-center gap-3">
      <Flame size={18} className="text-orange-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-white font-bold text-sm truncate">
          {a ? lobbyName(a) : '?'} <span className="text-slate-500 font-normal">vs</span> {b ? lobbyName(b) : '?'}
        </p>
        <p className="text-slate-500 text-[11px] uppercase tracking-wider">
          Face-Off · {mmss(m.elapsed_secs)}{m.paused ? ' · paused (reconnecting)' : ''}
        </p>
      </div>
      <button onClick={copy} aria-label="Copy watch link"
        className="shrink-0 w-10 h-10 rounded-lg border border-valor-border text-slate-400 hover:text-white flex items-center justify-center">
        {copied ? <Check size={15} /> : <Link2 size={15} />}
      </button>
      <Link href={watchHref(m.duel_id)}
        className="shrink-0 min-h-10 px-3 rounded-lg bg-orange-500 text-black font-bold text-xs flex items-center gap-1.5 hover:bg-orange-400">
        <Eye size={14} /> Watch
      </Link>
    </div>
  )
}

function PartyRow({ p, me, signedIn }: { p: LobbyParty; me: string | null; signedIn: boolean }) {
  const mine = !!me && p.members.some((m) => m.wallet === me)
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] px-4 py-3 flex items-center gap-3">
      <UsersRound size={18} className="text-emerald-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-white font-bold text-sm truncate">{lobbyName(p.host)}’s party</p>
        <p className="text-slate-500 text-[11px] uppercase tracking-wider">
          Co-op · {p.size}/{p.max_size} · {p.started ? 'in a run' : 'waiting to start'}
        </p>
      </div>
      {mine ? (
        <span className="shrink-0 text-emerald-300 text-xs font-bold px-2">You’re in</span>
      ) : p.joinable ? (
        <Link href={signedIn ? partyJoinHref(p.code) : '/'}
          className="shrink-0 min-h-10 px-3 rounded-lg bg-emerald-500 text-black font-bold text-xs flex items-center gap-1.5 hover:bg-emerald-400">
          <LogIn size={14} /> {signedIn ? 'Join' : 'Sign in to join'}
        </Link>
      ) : (
        <span className="shrink-0 text-slate-500 text-xs font-bold px-2">{p.started ? 'In progress' : 'Full'}</span>
      )}
    </div>
  )
}

function FriendButton({ isFriend, isPending, busy, onAdd, wallet, name }: {
  isFriend: boolean; isPending: boolean; busy: boolean; onAdd: () => void; wallet: string; name: string
}) {
  if (isFriend) {
    return (
      <Link href={`/friends/chat/${wallet}?name=${encodeURIComponent(name)}`}
        className="shrink-0 min-h-10 px-3 rounded-lg bg-valor-gold text-black font-bold text-xs flex items-center gap-1.5 hover:bg-valor-gold-light">
        <MessageCircle size={14} /> Chat
      </Link>
    )
  }
  if (isPending) {
    return <span className="shrink-0 text-slate-500 text-xs font-bold px-2">Requested</span>
  }
  return (
    <button onClick={onAdd} disabled={busy}
      className="shrink-0 min-h-10 px-3 rounded-lg border border-valor-gold/50 text-valor-gold font-bold text-xs flex items-center gap-1.5 hover:bg-valor-gold/10 disabled:opacity-50">
      {busy ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Add
    </button>
  )
}

function PlayerRow({ p, isMe, isFriend, isPending, open, onToggle, signedIn, duelsAvailable, busy, onAddFriend }: {
  p: LobbyPlayer; isMe: boolean; isFriend: boolean; isPending: boolean; open: boolean; onToggle: () => void
  signedIn: boolean; duelsAvailable: boolean; busy: boolean; onAddFriend: () => void
}) {
  const name = lobbyName(p)
  const meta = STATUS_META[p.status]
  const canJoin = p.status === 'in_party_lobby' && p.party_joinable && !!p.party_code
  return (
    <div className={`rounded-xl border bg-valor-surface transition-colors ${open ? 'border-emerald-500/40' : 'border-valor-border'}`}>
      <button onClick={onToggle} disabled={isMe} aria-expanded={open}
        className="w-full px-4 py-3 flex items-center gap-3 text-left disabled:cursor-default">
        <Avatar name={name} online />
        <div className="min-w-0 flex-1">
          <p className="text-white font-bold text-sm truncate">
            {name}{isMe && <span className="text-slate-500 font-normal"> (you)</span>}
            {isFriend && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wider text-valor-gold">Friend</span>}
          </p>
          <p className="text-slate-500 text-[11px] uppercase tracking-wider truncate">{[p.rank, p.class].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider border rounded-sm px-1.5 py-0.5 ${meta.cls}`}>
          {canJoin ? 'Open party' : meta.label}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && !isMe && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="px-4 pb-3 flex flex-wrap gap-2">
              {!signedIn ? (
                <Link href="/" className="min-h-10 px-3 rounded-lg bg-emerald-500 text-black font-bold text-xs flex items-center gap-1.5">
                  <LogIn size={14} /> Sign in to play with {name}
                </Link>
              ) : (<>
                {canJoin && (
                  <Link href={partyJoinHref(p.party_code!)} className="min-h-10 px-3 rounded-lg bg-emerald-500 text-black font-bold text-xs flex items-center gap-1.5 hover:bg-emerald-400">
                    <LogIn size={14} /> Join party
                  </Link>
                )}
                {p.status === 'in_match' && p.duel_id && (
                  <Link href={watchHref(p.duel_id)} className="min-h-10 px-3 rounded-lg bg-orange-500 text-black font-bold text-xs flex items-center gap-1.5 hover:bg-orange-400">
                    <Eye size={14} /> Watch
                  </Link>
                )}
                {duelsAvailable && (<>
                  <Link href={`/faceoff${challengeQs(p.wallet, name)}`} className="min-h-10 px-3 rounded-lg border border-orange-500/50 text-orange-300 font-bold text-xs flex items-center gap-1.5 hover:bg-orange-500/10">
                    <Flame size={14} /> Face-Off
                  </Link>
                  <Link href={`/duels${challengeQs(p.wallet, name)}`} className="min-h-10 px-3 rounded-lg border border-valor-border text-slate-300 font-bold text-xs flex items-center gap-1.5 hover:border-valor-gold/50">
                    <Swords size={14} /> Duel
                  </Link>
                </>)}
                <FriendButton isFriend={isFriend} isPending={isPending} busy={busy} onAdd={onAddFriend} wallet={p.wallet} name={name} />
                {p.username && (
                  <Link href={`/${p.username}`} className="min-h-10 px-3 rounded-lg text-slate-400 hover:text-white font-bold text-xs flex items-center">
                    Profile
                  </Link>
                )}
              </>)}
              <button onClick={onToggle} aria-label="Close" className="ml-auto w-10 h-10 rounded-lg text-slate-500 hover:text-white flex items-center justify-center">
                <X size={15} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
