'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Gift, Search, Loader2, Check } from 'lucide-react'
import type { Item } from '@/types'
import { useFriends } from '@/hooks/useFriends'
import { useGiftItem, type GiftRecipient } from '@/hooks/useGiftItem'
import { formatGDollarNumber } from '@/utils/format'
import { edition } from '@/editions'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const MAX_NOTE = 140

interface PlayerHit { wallet_address: string; character_name: string; username: string | null }

function rejected(err: unknown): boolean {
  const m = err instanceof Error ? err.message.toLowerCase() : ''
  return m.includes('user rejected') || m.includes('user denied') || m.includes('rejected the request')
}

/** Buy `item` for another player: pick them (friends first, or search by
 *  username), add a note, confirm, sign. Delivery is instant. */
export default function GiftModal({ item, walletAddress, onClose }: {
  item: Item
  walletAddress: string
  onClose: () => void
}) {
  const { friends } = useFriends(walletAddress)
  const { gift, pending } = useGiftItem(walletAddress)
  const symbol = edition().currency.symbol

  const [to, setTo] = useState<GiftRecipient | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PlayerHit[]>([])
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const friendList = (friends ?? []).slice(0, 8)

  async function search() {
    const q = query.trim()
    setError(null); setHits([])
    if (!q) return
    setSearching(true)
    try {
      // A full wallet address: look that player up directly (name search
      // doesn't match addresses). Gifts only go to existing Valor players.
      if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
        if (q.toLowerCase() === walletAddress.toLowerCase()) { setError("That's your own wallet — you can't gift yourself."); return }
        const res = await fetch(`${API}/players/${q.toLowerCase()}`)
        if (!res.ok) { setError('No Valor player at that address.'); return }
        const p = await res.json() as PlayerHit
        setTo({ wallet: p.wallet_address, name: p.username || p.character_name })
        return
      }
      const res = await fetch(`${API}/players/search?q=${encodeURIComponent(q)}&exclude=${walletAddress}`)
      const results = res.ok ? await res.json() as PlayerHit[] : []
      if (!results.length) setError(`No player named "${q}" found.`)
      setHits(results)
    } finally { setSearching(false) }
  }

  async function send() {
    if (!to) return
    setError(null)
    try {
      await gift(item, to, note)
      setSent(true)
    } catch (err) {
      if (!rejected(err)) setError(err instanceof Error ? err.message : 'The gift could not be sent')
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={(e) => { if (e.target === e.currentTarget && !pending) onClose() }}
    >
      <motion.div
        role="dialog" aria-label={`Gift ${item.name}`}
        className="w-full max-w-md bg-valor-surface border border-valor-border rounded-2xl p-5 flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
        initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
      >
        <div className="flex items-center gap-2">
          <Gift size={18} className="text-pink-400" />
          <p className="flex-1 font-display font-black text-white text-sm uppercase tracking-wider">Gift {item.name}</p>
          <button onClick={onClose} disabled={pending} aria-label="Close" className="text-slate-500 hover:text-white"><X size={18} /></button>
        </div>

        {sent ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="w-12 h-12 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center"><Check size={22} /></span>
            <p className="text-white font-bold">Sent to {to?.name}!</p>
            <p className="text-slate-400 text-xs">It&apos;s in their inventory now, and they&apos;ve been notified.</p>
            <button onClick={onClose} className="mt-1 px-5 py-2 rounded-lg bg-valor-gold text-black font-bold text-sm">Done</button>
          </div>
        ) : (
          <>
            {/* Who */}
            <section className="flex flex-col gap-2">
              <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">To</p>
              {to ? (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-valor-surface-2">
                  <p className="flex-1 text-white font-bold text-sm truncate">{to.name}</p>
                  <button onClick={() => setTo(null)} className="text-xs text-slate-400 hover:text-white">Change</button>
                </div>
              ) : (
                <>
                  {friendList.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {friendList.map((f) => (
                        <button key={f.wallet} onClick={() => setTo({ wallet: f.wallet, name: f.username || f.character_name })}
                          className="px-3 py-1.5 rounded-full border border-valor-border text-slate-200 text-xs font-bold hover:border-pink-400/60">
                          {f.username || f.character_name}
                        </button>
                      ))}
                    </div>
                  )}
                  <form onSubmit={(e) => { e.preventDefault(); void search() }} className="flex gap-2">
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Or search a username or 0x address"
                      aria-label="Search for a player"
                      className="flex-1 min-w-0 min-h-10 px-3 rounded-lg bg-valor-surface-2 border border-valor-border text-white text-sm outline-none focus:border-pink-400/60" />
                    <button type="submit" disabled={searching || !query.trim()} aria-label="Search"
                      className="min-h-10 px-3 rounded-lg bg-valor-surface-2 border border-valor-border text-slate-200 disabled:opacity-40">
                      {searching ? <Loader2 className="animate-spin" size={15} /> : <Search size={15} />}
                    </button>
                  </form>
                  {hits.map((h) => (
                    <button key={h.wallet_address} onClick={() => { setTo({ wallet: h.wallet_address, name: h.username || h.character_name }); setHits([]) }}
                      className="text-left px-3 py-2 rounded-lg bg-valor-surface-2 hover:bg-white/5 text-white text-sm font-bold">
                      {h.username || h.character_name}
                    </button>
                  ))}
                </>
              )}
            </section>

            {/* Note */}
            <section className="flex flex-col gap-1.5">
              <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Note (optional)</p>
              <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE))} rows={2}
                placeholder="Good luck out there"
                className="px-3 py-2 rounded-lg bg-valor-surface-2 border border-valor-border text-white text-sm outline-none focus:border-pink-400/60 resize-none" />
              <p className="text-[10px] text-slate-500 text-right">{note.length}/{MAX_NOTE}</p>
            </section>

            <div className="rounded-lg bg-valor-surface-2 border border-valor-border px-3 py-2 flex items-center justify-between text-sm">
              <span className="text-slate-400">You pay</span>
              <span className="text-white font-black">{formatGDollarNumber(item.price_g)} {symbol}</span>
            </div>
            {item.on_chain_id !== null && (
              <p className="text-slate-500 text-xs -mt-2">Your wallet asks for two signatures: the payment, and approval of who receives it. No gas.</p>
            )}

            {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}

            <button onClick={() => void send()} disabled={!to || pending}
              className="w-full min-h-12 rounded-xl bg-pink-500 text-white font-black text-sm uppercase tracking-wider disabled:opacity-40 flex items-center justify-center gap-2">
              {pending ? <><Loader2 className="animate-spin" size={16} /> Sending…</> : <><Gift size={16} /> {to ? `Send to ${to.name}` : 'Pick who to send it to'}</>}
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}
