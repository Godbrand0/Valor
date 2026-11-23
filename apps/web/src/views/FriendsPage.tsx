'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { Users, UserPlus, UserMinus, Swords, MessageCircle, Search, Check, X, Loader2, Flame } from 'lucide-react'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useFriends, type FriendEntry, type FriendRequestEntry } from '@/hooks/useFriends'
import { useUnreadCounts } from '@/hooks/useChat'
import LoadingScreen from '@/components/ui/LoadingScreen'
import Redirect from '@/components/ui/Redirect'
import RankBadge from '@/components/player-card/RankBadge'
import RankAura from '@/components/ui/RankAura'
import type { Rank } from '@/types'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

const who = (f: { username: string | null; character_name: string }) => f.username || f.character_name

// Deterministic per-wallet color, same idea as groupHue() for group crests — two
// players on the same row are told apart at a glance and a player's color never
// changes without anyone having to pick or store one.
function walletHue(wallet: string): number {
  let h = 0
  for (let i = 0; i < wallet.length; i++) h = (h * 31 + wallet.charCodeAt(i)) >>> 0
  return h % 360
}

function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function FriendAvatar({ wallet, name, size = 40 }: { wallet: string; name: string; size?: number }) {
  const hue = walletHue(wallet)
  return (
    <div
      className="shrink-0 rounded-full flex items-center justify-center font-black"
      style={{
        width: size,
        height: size,
        background: `hsl(${hue} 65% 16%)`,
        boxShadow: `inset 0 0 0 1.5px hsl(${hue} 75% 55% / 0.45)`,
        color: `hsl(${hue} 85% 72%)`,
        fontSize: size * 0.34,
      }}
    >
      {initials(name)}
    </div>
  )
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

type Tab = 'friends' | 'requests'

interface Suggestion {
  wallet_address: string
  username:       string | null
  character_name: string
  rank:           string
}

/** Minimum length before a suggestion lookup fires — one or two characters
 *  would match half the roster and just be noise. */
const MIN_SUGGEST_LEN = 2
const SUGGEST_DEBOUNCE_MS = 300
// Below this, the list fits on screen without scrolling — a search box would
// just be one more thing to look at for nothing it actually filters.
const FILTER_THRESHOLD = 5

/**
 * FRIENDS — opt-in social graph, kept separate from referrals.
 *
 * A referral pays out once for bringing in a new verified player; it has never
 * meant "we're friends", so nothing here is auto-populated from it. Every
 * relationship is a request the other person chooses to accept.
 */
export default function FriendsPage() {
  const { status, address } = useResolvedAuth()
  const router = useRouter()
  const player = usePlayerStore((s) => s.player)
  const playerSynced = usePlayerStore((s) => s.playerSynced)
  const { friends, incoming, outgoing, loading, error, sendRequest, acceptRequest, removeFriend } =
    useFriends(address)
  const { byWallet: unreadByWallet } = useUnreadCounts(address)

  const [tab, setTab] = useState<Tab>('friends')
  // Collapsed by default once a roster exists — the list is the point of the
  // page, not the form. Opens itself the first time there's nothing to show
  // yet, so a brand-new player isn't staring at an empty list with no cue.
  const [addOpen, setAddOpen] = useState(false)
  const autoOpened = useRef(false)
  const [addBy, setAddBy] = useState<'username' | 'character' | 'wallet'>('username')
  const [identifier, setIdentifier] = useState('')
  const [sending, setSending] = useState(false)
  const [busyWallet, setBusyWallet] = useState<string | null>(null)
  // Wallet awaiting an explicit "yes, remove them" — unfriending is a one-way
  // action (they'd have to re-request), so a stray tap on the button that
  // starts it must not be enough to finish it.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formNotice, setFormNotice] = useState<string | null>(null)

  // ── Add-a-friend typeahead ──────────────────────────────────────────────────
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const latestQuery = useRef('')

  // ── Search-within-list ───────────────────────────────────────────────────────
  const [listFilter, setListFilter] = useState('')

  useEffect(() => {
    // Wallet addresses aren't matched by the search endpoint (it's a LIKE
    // over character_name/username), so there's nothing useful to suggest.
    if (!address || addBy === 'wallet') { setSuggestions([]); return }
    const q = identifier.trim()
    latestQuery.current = q
    if (q.length < MIN_SUGGEST_LEN) { setSuggestions([]); return }

    const handle = setTimeout(() => {
      fetch(`${API}/players/search?q=${encodeURIComponent(q)}&exclude=${address}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Suggestion[]) => {
          // A slower earlier request could otherwise land after a faster
          // later one and clobber it with stale results.
          if (latestQuery.current === q) { setSuggestions(rows); setHighlight(-1) }
        })
        .catch(() => {})
    }, SUGGEST_DEBOUNCE_MS)

    return () => clearTimeout(handle)
  }, [identifier, addBy, address])

  useEffect(() => {
    if (loading || autoOpened.current) return
    autoOpened.current = true
    if (friends.length === 0 && incoming.length === 0) setAddOpen(true)
  }, [loading, friends.length, incoming.length])

  if (status === 'loading') return <LoadingScreen />
  if (status === 'unauthenticated' || !address) return <Redirect to="/" />
  if (!player && !playerSynced) return <LoadingScreen />
  if (!player) return <Redirect to="/" />

  const onAdd = async (explicitIdentifier?: string) => {
    const value = (explicitIdentifier ?? identifier).trim()
    if (!value) return
    setSuggestions([])
    setFormError(null)
    setFormNotice(null)
    setSending(true)
    try {
      const result = await sendRequest(value)
      setIdentifier('')
      setFormNotice(result.auto_accepted ? 'You are now friends' : 'Friend request sent')
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not send request')
    } finally {
      setSending(false)
    }
  }

  const withBusy = async (wallet: string, fn: () => Promise<void>) => {
    setBusyWallet(wallet)
    setFormError(null)
    try { await fn() }
    catch (e) { setFormError(e instanceof Error ? e.message : 'Something went wrong') }
    finally { setBusyWallet(null) }
  }

  const filterQ = listFilter.trim().toLowerCase()
  const filteredFriends  = filterQ ? friends.filter((f) => who(f).toLowerCase().includes(filterQ))  : friends
  const filteredIncoming = filterQ ? incoming.filter((f) => who(f).toLowerCase().includes(filterQ)) : incoming
  const filteredOutgoing = filterQ ? outgoing.filter((f) => who(f).toLowerCase().includes(filterQ)) : outgoing

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      style={{
        background: 'radial-gradient(ellipse 640px 280px at 50% -8%, rgba(234,179,8,0.09), transparent), #04030c',
      }}
    >
      {/* Scanlines — the same atmospheric texture every Valor screen carries,
          so a full-screen takeover still reads as part of the game and not a
          plain settings dialog. Fixed so it doesn't scroll with the list. */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none z-0"
        style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.035) 2px, rgba(0,0,0,0.035) 4px)' }}
      />

      <div
        className="relative z-10 max-w-lg mx-auto px-5 flex flex-col gap-6"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1.5rem)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)',
        }}
      >
        <div className="flex items-center justify-center gap-2">
          <img src="/valor-mark.png" alt="" width={16} height={16} className="opacity-80" />
          <span className="font-display font-black tracking-[0.3em] text-[10px] text-amber-400">VALOR</span>
        </div>

        <div className="flex items-center gap-3">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-valor-gold/10 border border-valor-gold/25 flex items-center justify-center">
            <Users className="text-valor-gold" size={19} />
          </div>
          <div className="flex-1">
            <h1 className="font-display font-black text-white text-xl">Friends</h1>
            <p className="text-slate-400 text-xs mt-0.5">
              Add fighters, then challenge them straight to a duel.
            </p>
          </div>
          <button onClick={() => router.push('/profile')} className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:text-white hover:bg-valor-surface-2 transition-colors" aria-label="Close friends">
            <X size={20} />
          </button>
        </div>

        {/* ── Add a friend ─────────────────────────────────────────────────── */}
        {!addOpen ? (
          <button
            onClick={() => setAddOpen(true)}
            className="w-full min-h-12 rounded-xl border border-dashed border-valor-border bg-valor-surface/60 text-slate-300 font-bold text-xs uppercase tracking-wider hover:border-valor-gold/50 hover:text-valor-gold transition-colors flex items-center justify-center gap-2"
          >
            <UserPlus size={15} /> Add a friend
          </button>
        ) : (
        <div className="rounded-xl border border-valor-border bg-valor-surface p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <UserPlus className="text-valor-gold" size={15} />
              <p className="font-display font-black text-white text-sm uppercase tracking-wider">Add a friend</p>
            </div>
            <button
              onClick={() => setAddOpen(false)}
              className="shrink-0 text-slate-500 hover:text-white transition-colors"
              aria-label="Collapse add a friend"
            >
              <X size={16} />
            </button>
          </div>

          {/* The player picks which they're typing — the server tries all three
              regardless (wallet, then username, then character name), so this
              toggle only steers the placeholder/label toward what they chose. */}
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: 'username' as const, label: 'Username' },
              { id: 'character' as const, label: 'Char. name' },
              { id: 'wallet' as const, label: 'Wallet' },
            ]).map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setAddBy(id)}
                aria-pressed={addBy === id}
                className={`min-h-10 rounded-lg border font-bold text-xs uppercase tracking-wider transition-colors ${
                  addBy === id
                    ? 'border-valor-gold bg-valor-gold/15 text-valor-gold'
                    : 'border-valor-border bg-valor-surface-2 text-slate-300 hover:border-valor-gold/50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex gap-2 relative">
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setSuggestOpen(false)}
              onKeyDown={(e) => {
                const showing = suggestOpen && addBy !== 'wallet' && suggestions.length > 0
                if (showing && e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => Math.min(i + 1, suggestions.length - 1)); return }
                if (showing && e.key === 'ArrowUp')   { e.preventDefault(); setHighlight((i) => Math.max(i - 1, 0)); return }
                if (showing && e.key === 'Escape')    { setSuggestions([]); return }
                if (showing && e.key === 'Enter' && highlight >= 0) { e.preventDefault(); void onAdd(suggestions[highlight].wallet_address); return }
                if (e.key === 'Enter') void onAdd()
              }}
              placeholder={addBy === 'username' ? 'Username' : addBy === 'character' ? 'Character name' : '0x…'}
              className="flex-1 min-h-11 rounded-lg border border-valor-border bg-valor-surface-2 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-valor-gold/50"
            />
            <button
              onClick={() => void onAdd()}
              disabled={sending || !identifier.trim()}
              className="shrink-0 min-h-11 px-4 rounded-lg bg-valor-gold text-black font-bold text-xs hover:bg-valor-gold-light transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              {sending ? <Loader2 className="animate-spin" size={14} /> : <UserPlus size={14} />}
              Add
            </button>

            {/* Typeahead — wallet mode has nothing to suggest (the search
                endpoint matches names, not addresses). onMouseDown (not
                onClick) fires before the input's onBlur, so a tap here
                selects instead of just closing the dropdown. */}
            {suggestOpen && addBy !== 'wallet' && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-16 mt-1 rounded-lg border border-valor-border bg-valor-surface-2 shadow-lg overflow-hidden z-10">
                {suggestions.map((s, i) => (
                  <button
                    key={s.wallet_address}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); void onAdd(s.wallet_address) }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                      i === highlight ? 'bg-valor-gold/15' : 'hover:bg-valor-gold/[0.07]'
                    }`}
                  >
                    <RankAura rank={s.rank as Rank} mode="badge"><FriendAvatar wallet={s.wallet_address} name={who(s)} size={26} /></RankAura>
                    <span className="flex-1 min-w-0 text-white font-bold text-sm truncate">{who(s)}</span>
                    <span className="shrink-0"><RankBadge rank={s.rank as Rank} /></span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {formNotice && <p className="text-green-400 text-xs font-medium">{formNotice}</p>}
        </div>
        )}

        <AnimatePresence>
          {(error || formError) && (
            <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              role="alert" className="text-red-400 text-xs font-medium">{formError ?? error}</motion.p>
          )}
        </AnimatePresence>

        {/* ── Tabs ──────────────────────────────────────────────────────────── */}
        {/* Sticky so switching tabs or searching stays in reach once the roster
            scrolls past a screenful — a native app keeps its toolbar in place. */}
        <div className="sticky top-0 z-10 -mx-5 px-5 pt-2 pb-0 bg-[#04030c]/90 backdrop-blur-sm flex flex-col gap-3">
          <div className="flex gap-2 border-b border-valor-border">
            {([
              { id: 'friends' as const, label: 'Friends', count: friends.length },
              { id: 'requests' as const, label: 'Requests', count: incoming.length },
            ]).map((t) => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setListFilter('') }}
                className={`px-3 pb-2.5 text-xs font-black uppercase tracking-wider transition-colors relative flex items-center gap-1.5 ${
                  tab === t.id ? 'text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {t.label}
                <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] transition-colors ${
                  tab === t.id ? 'bg-valor-gold text-black' : 'bg-valor-surface-2 text-slate-500'
                }`}>
                  {t.count}
                </span>
                {tab === t.id && (
                  <span className="absolute bottom-0 inset-x-0 h-0.5 rounded-full bg-valor-gold" />
                )}
              </button>
            ))}
          </div>

          {/* Search-within-list — only worth showing once there's enough to scroll past. */}
          {!loading && ((tab === 'friends' && friends.length > FILTER_THRESHOLD) ||
            (tab === 'requests' && incoming.length + outgoing.length > FILTER_THRESHOLD)) && (
            <div className="pb-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  value={listFilter}
                  onChange={(e) => setListFilter(e.target.value)}
                  placeholder={tab === 'friends' ? 'Search your friends…' : 'Search requests…'}
                  className="w-full min-h-10 rounded-lg border border-valor-border bg-valor-surface-2/50 pl-9 pr-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-valor-gold/50"
                />
              </div>
            </div>
          )}
        </div>

        {loading && <p className="text-slate-500 text-sm">Loading…</p>}

        {/* ── Friends list ──────────────────────────────────────────────────── */}
        {tab === 'friends' && !loading && (
          <div className="flex flex-col gap-2">
            {friends.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <div className="w-12 h-12 rounded-full bg-valor-surface-2 flex items-center justify-center">
                  <Users className="text-slate-600" size={20} />
                </div>
                <p className="text-slate-400 text-sm font-bold">No friends yet</p>
                <p className="text-slate-600 text-xs max-w-[22rem]">Add one above to start challenging them to duels.</p>
              </div>
            )}
            {friends.length > 0 && filteredFriends.length === 0 && (
              <p className="text-slate-500 text-sm">No friends match &ldquo;{listFilter}&rdquo;.</p>
            )}
            {filteredFriends.map((f: FriendEntry) => (
              <div key={f.wallet} className={`rounded-xl border px-4 py-3 flex flex-col gap-2.5 transition-colors ${
                confirmRemove === f.wallet ? 'border-red-500/50 bg-red-500/[0.06]' : 'border-valor-border bg-valor-surface-2/50 hover:border-valor-border/70'
              }`}>
                {confirmRemove === f.wallet ? (
                  <>
                    <div className="flex items-center gap-3 min-w-0">
                      <RankAura rank={f.rank as Rank} mode="badge"><FriendAvatar wallet={f.wallet} name={who(f)} /></RankAura>
                      <div className="min-w-0">
                        <p className="text-white font-bold text-sm">Remove {who(f)}?</p>
                        <p className="text-slate-500 text-[11px] mt-0.5">They&apos;ll need to send a new request to be friends again.</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConfirmRemove(null)}
                        disabled={busyWallet === f.wallet}
                        className="flex-1 min-h-10 rounded-lg border border-valor-border bg-valor-surface-2 text-slate-300 font-bold text-xs hover:text-white transition-colors disabled:opacity-40"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void withBusy(f.wallet, () => removeFriend(f.wallet)).then(() => setConfirmRemove(null))}
                        disabled={busyWallet === f.wallet}
                        className="flex-1 min-h-10 rounded-lg bg-red-500/90 text-white font-bold text-xs hover:bg-red-500 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
                      >
                        {busyWallet === f.wallet ? <Loader2 className="animate-spin" size={13} /> : <UserMinus size={13} />}
                        Remove
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Name + chat on their own line — on a narrow phone, cramming
                        the challenge/remove icons onto this same line left ~80px
                        for the name and rank badge, so names truncated to 2-3
                        letters and the badge rendered half-hidden under the Chat
                        button. Splitting the row gives both lines room to breathe. */}
                    <div className="flex items-center gap-3">
                      <RankAura rank={f.rank as Rank} mode="badge"><FriendAvatar wallet={f.wallet} name={who(f)} /></RankAura>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-bold text-sm truncate">{who(f)}</p>
                        <div className="mt-1 overflow-hidden"><RankBadge rank={f.rank as Rank} /></div>
                      </div>
                      <button
                        onClick={() => router.push(`/friends/chat/${f.wallet}?name=${encodeURIComponent(who(f))}`)}
                        className="relative shrink-0 px-3 min-h-10 rounded-lg bg-valor-gold text-black font-bold text-xs hover:bg-valor-gold-light transition-colors flex items-center gap-1.5"
                      >
                        <MessageCircle size={14} /> Chat
                        {!!unreadByWallet[f.wallet] && (
                          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center">
                            {unreadByWallet[f.wallet]}
                          </span>
                        )}
                      </button>
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      {/* Live Face-Off challenge — FaceOffPage already reads ?challenge/&name
                          to aim a new challenge at one player, it just had no way in. Grouped
                          with the duel challenge since both are "fight this friend" actions. */}
                      <div className="flex items-center rounded-lg border border-valor-border overflow-hidden">
                        <button
                          onClick={() => router.push(`/faceoff?challenge=${f.wallet}&name=${encodeURIComponent(who(f))}`)}
                          className="w-10 h-10 text-orange-300 hover:text-orange-200 hover:bg-orange-500/10 transition-colors flex items-center justify-center"
                          aria-label={`Face-Off ${who(f)}`}
                          title="Challenge to a live Face-Off"
                        >
                          <Flame size={16} />
                        </button>
                        <div className="w-px self-stretch bg-valor-border" />
                        <button
                          onClick={() => router.push(`/duels?challenge=${f.wallet}&name=${encodeURIComponent(who(f))}`)}
                          className="w-10 h-10 text-slate-300 hover:text-white hover:bg-valor-gold/10 transition-colors flex items-center justify-center"
                          aria-label={`Challenge ${who(f)}`}
                          title="Challenge to a Duel"
                        >
                          <Swords size={16} />
                        </button>
                      </div>
                      <button
                        onClick={() => setConfirmRemove(f.wallet)}
                        className="shrink-0 w-10 h-10 rounded-lg border border-valor-border text-slate-400 hover:text-red-300 hover:border-red-500/50 transition-colors flex items-center justify-center"
                        aria-label={`Remove ${who(f)}`}
                        title="Remove friend"
                      >
                        <UserMinus size={16} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Requests ──────────────────────────────────────────────────────── */}
        {tab === 'requests' && !loading && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="font-display font-black text-white text-sm uppercase tracking-wider">Incoming</p>
              {incoming.length === 0 && <p className="text-slate-600 text-sm">No pending requests.</p>}
              {incoming.length > 0 && filteredIncoming.length === 0 && (
                <p className="text-slate-500 text-sm">No matches.</p>
              )}
              {filteredIncoming.map((f: FriendRequestEntry) => (
                <div key={f.wallet} className="rounded-xl border border-valor-border bg-valor-surface-2/50 px-4 py-3 flex items-center gap-3">
                  <RankAura rank={f.rank as Rank} mode="badge"><FriendAvatar wallet={f.wallet} name={who(f)} size={36} /></RankAura>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-bold text-sm truncate">{who(f)}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <RankBadge rank={f.rank as Rank} />
                      <span className="text-slate-600 text-[10px]">{timeAgo(f.created_at)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void withBusy(f.wallet, () => acceptRequest(f.wallet))}
                    disabled={busyWallet === f.wallet}
                    className="shrink-0 w-10 h-10 rounded-lg bg-valor-gold text-black hover:bg-valor-gold-light transition-colors disabled:opacity-40 flex items-center justify-center"
                    aria-label={`Accept ${who(f)}`}
                    title="Accept"
                  >
                    {busyWallet === f.wallet ? <Loader2 className="animate-spin" size={15} /> : <Check size={16} />}
                  </button>
                  <button
                    onClick={() => void withBusy(f.wallet, () => removeFriend(f.wallet))}
                    disabled={busyWallet === f.wallet}
                    className="shrink-0 w-10 h-10 rounded-lg border border-valor-border text-slate-400 hover:text-red-300 hover:border-red-500/50 transition-colors disabled:opacity-40 flex items-center justify-center"
                    aria-label={`Decline ${who(f)}`}
                    title="Decline"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <p className="font-display font-black text-white text-sm uppercase tracking-wider">Sent</p>
              {outgoing.length === 0 && <p className="text-slate-600 text-sm">No outgoing requests.</p>}
              {outgoing.length > 0 && filteredOutgoing.length === 0 && (
                <p className="text-slate-500 text-sm">No matches.</p>
              )}
              {filteredOutgoing.map((f: FriendRequestEntry) => (
                <div key={f.wallet} className="rounded-xl border border-valor-border bg-valor-surface-2/50 px-4 py-3 flex items-center gap-3">
                  <RankAura rank={f.rank as Rank} mode="badge"><FriendAvatar wallet={f.wallet} name={who(f)} size={36} /></RankAura>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-bold text-sm truncate">{who(f)}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <RankBadge rank={f.rank as Rank} />
                      <span className="text-slate-600 text-[10px]">Sent {timeAgo(f.created_at)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void withBusy(f.wallet, () => removeFriend(f.wallet))}
                    disabled={busyWallet === f.wallet}
                    className="shrink-0 px-3 min-h-9 rounded-lg border border-valor-border text-slate-300 font-bold text-xs hover:text-white transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
