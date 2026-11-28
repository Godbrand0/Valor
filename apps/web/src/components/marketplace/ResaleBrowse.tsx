'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Tag } from 'lucide-react'
import { formatUnits } from 'viem'
import { useResale, type ResaleListing } from '@/hooks/useResale'
import { ITEM_RARITY_COLORS } from '@/lib/constants'
import { formatGDollarNumber, formatAddress } from '@/utils/format'
import { edition } from '@/editions'
import { WeaponCrate, crateLabel } from './WeaponCrate'
import type { Item } from '@/types'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

function ListingCard({
  listing, item, mine, busy, onBuy, onCancel,
}: {
  listing: ResaleListing
  item: Item | undefined
  mine: boolean
  busy: boolean
  onBuy: () => void
  onCancel: () => void
}) {
  const rarityColor = item ? ITEM_RARITY_COLORS[item.rarity] : '#94a3b8'
  const priceG = Number(formatUnits(listing.price, 18))
  const symbol = edition().currency.symbol

  return (
    <motion.div
      className="flex flex-col gap-3 p-4 bg-valor-surface rounded-xl border"
      style={{ borderColor: `${rarityColor}33` }}
      whileHover={!busy ? { scale: 1.02, y: -2 } : {}}
      layout
    >
      <div className="flex items-center justify-between">
        <span
          className="text-xs font-bold px-2 py-0.5 rounded-full"
          style={{ color: rarityColor, background: `${rarityColor}22` }}
        >
          {item?.rarity.toUpperCase() ?? 'ITEM'}
        </span>
        <span className="text-[10px] font-bold text-slate-500">
          {mine ? 'Your listing' : formatAddress(listing.seller)}
        </span>
      </div>

      {item && <WeaponCrate item={item} rarityColor={rarityColor} label={crateLabel(item)} />}

      <p className="font-bold text-white text-sm leading-tight truncate">
        {item?.name ?? `Item #${listing.itemId}`}
      </p>

      <div className="flex items-center justify-between mt-auto pt-2" style={{ borderTop: '1px solid rgba(42,42,58,0.4)' }}>
        <span className="font-bold" style={{ color: '#eab308' }}>
          {formatGDollarNumber(priceG)} {symbol}
        </span>
        <Tag size={13} className="text-slate-600" />
      </div>

      {mine ? (
        <button
          onClick={onCancel}
          disabled={busy}
          className="py-2.5 text-sm font-bold rounded-lg border text-slate-300 hover:text-white hover:border-slate-500 transition-colors disabled:opacity-40"
          style={{ borderColor: '#2a2a3a' }}
        >
          {busy ? 'Cancelling…' : 'Cancel listing'}
        </button>
      ) : (
        <motion.button
          onClick={onBuy}
          disabled={busy}
          whileTap={!busy ? { scale: 0.97 } : {}}
          className="py-2.5 text-sm font-bold rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: rarityColor, color: '#000' }}
        >
          {busy ? 'Buying…' : `Buy with ${symbol}`}
        </motion.button>
      )}
    </motion.div>
  )
}

/** Player-to-player resale listings — buy another player's gun, or cancel your own. */
export default function ResaleBrowse({ walletAddress }: { walletAddress?: string }) {
  const { fetchListings, buyResale, cancelResale, pending } = useResale(walletAddress)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr]   = useState<string | null>(null)

  const { data: listings = [], isLoading, refetch } = useQuery({
    queryKey: ['resale-listings'],
    queryFn: fetchListings,
    staleTime: 20_000,
  })

  const { data: items = [] } = useQuery({
    queryKey: ['items-all'],
    queryFn: async (): Promise<Item[]> => {
      const res = await fetch(`${API}/items`)
      return res.ok ? await res.json() : []
    },
    staleTime: 60_000,
  })
  const byChainId = new Map(
    items.filter((i) => i.on_chain_id != null).map((i) => [i.on_chain_id as number, i]),
  )

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setErr(null)
    try { await fn(); refetch() }
    catch (e) { setErr((e as Error).message.slice(0, 70)) }
    finally { setBusy(null) }
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-64 bg-valor-surface rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  if (listings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Tag size={26} className="text-slate-700" strokeWidth={1.8} />
        <p className="text-slate-400 text-sm font-bold">Nothing listed for sale right now</p>
        <p className="text-slate-600 text-xs max-w-xs">
          List an on-chain weapon from your Profile inventory — tap &ldquo;Sell&rdquo; on anything you own.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <p className="text-red-400 text-xs">{err}</p>}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {listings.map((l) => {
          const item = byChainId.get(Number(l.itemId))
          const mine = !!walletAddress && l.seller.toLowerCase() === walletAddress.toLowerCase()
          const id = l.resaleId.toString()
          return (
            <ListingCard
              key={id}
              listing={l}
              item={item}
              mine={mine}
              busy={busy === id || pending}
              onBuy={() => run(id, () => buyResale(l.resaleId, l.price))}
              onCancel={() => run(id, () => cancelResale(l.resaleId))}
            />
          )
        })}
      </div>
    </div>
  )
}
