'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { useResolvedAuth } from '@/hooks/useResolvedAuth'
import { useActiveWalletClient } from '@/hooks/useActiveWalletClient'
import { formatGDollarNumber } from '@/utils/format'
import { ArrowUpRight, CalendarPlus, ChevronRight, Coins, Megaphone, Undo2 } from 'lucide-react'
import {
  BTN_DANGER, BTN_GHOST, BTN_GOLD, BTN_OK, BTN_WARN, INPUT, LABEL, PANEL, PILL, PILL_ON, SUBPANEL,
  Badge, Drawer, PageBanner, SectionTitle, Stat, compact,
} from '@/components/admin/ui'

const API = process.env.NEXT_PUBLIC_API_URL ?? ''
const SESSION_KEY = 'valor-admin-session'

/**
 * Up to two prize tiers (top N winners at X G$ each, then the next M at Y each —
 * 0 for the second tier's count means a flat top-N payout) collapsed into the
 * {pool, bps} shape a season or referral campaign actually stores: a total G$
 * pool and each rank's cut of it in basis points, rounded, with any rounding
 * drift folded into the last winner so the array always sums to exactly 10000.
 * Shared by the season-creation form and the re-fund/re-split control for an
 * existing season — both are "pick a prize shape" in the same sense.
 */
function tierSplit(tiers: { count: number; each: number }[]) {
  const pool = tiers.reduce((sum, t) => sum + t.count * t.each, 0)
  if (pool <= 0) return { pool: 0, bps: [] as number[] }
  const bps = tiers.flatMap((t) => Array.from({ length: t.count }, () => Math.round((t.each / pool) * 10000)))
  if (bps.length > 0) bps[bps.length - 1] += 10000 - bps.reduce((a, b) => a + b, 0)
  return { pool, bps }
}

interface AdminSession {
  token: string
  wallet: string
  expires_at: number
}

interface Season {
  id: string
  name: string
  starts_at: string
  ends_at: string | null
  prize_pool_g: number
  payout_status: string
}

interface AdminStats {
  season_name: string | null
  starts_at: string
  ends_at: string | null
  new_players: number
  verified_players: number
  played_players: number
  active_players: number
  total_battles: number
  total_g_awarded: number
  total_g_volume: number
  total_g_transferred_out: number
}

/** What POST /admin/grants returns per wallet. */
interface GrantResult {
  wallet_address: string
  status: 'paid' | 'already_paid' | 'not_a_player' | 'invalid_address' | 'failed'
  tx_hash: string | null
  error: string | null
}

interface OnchainRow {
  kind: string
  wallet: string
  detail: string | null
  tx_hash: string
  created_at: string
}

/** What GET /admin/seasons/:id/payout-preview returns — the exact shape of the
 *  transfer the Pay button will make, checked against the pool balance. */
interface PayoutWinner {
  rank: number
  wallet_address: string
  username: string | null
  waves: number
  amount_g: number
  status: string
  tx_hash: string | null
  /** G$ of this prize already delivered on-chain (a partly paid winner). */
  sent_g?: number
}
interface PayoutPreview {
  season: { id: string; name: string; ends_at: string | null; prize_pool_g: number; payout_status: string; closed: boolean }
  winners: PayoutWinner[]
  winner_count: number
  total_g: number
  unpaid_g: number
  tx_count: number
  pool_address: string | null
  pool_balance_g: number | null
  funded: boolean
  relay_celo: number | null
  relay_address?: string | null
  can_pay: boolean
}

// Referral campaigns pay a leaderboard the same way seasons do — a funded pool
// split top-heavy at close — so this whole shape mirrors PayoutWinner/PayoutPreview
// above, just "referral_count" where seasons have "waves" and "campaign" for "season".
interface ReferralCampaign {
  id: string
  name: string
  starts_at: string
  ends_at: string
  prize_pool_g: number
  payout_status: string
}
interface ReferralPayoutWinner {
  rank: number
  wallet_address: string
  username: string | null
  referral_count: number
  amount_g: number
  status: string
  tx_hash: string | null
}
interface ReferralPayoutPreview {
  campaign: { id: string; name: string; ends_at: string | null; prize_pool_g: number; payout_status: string; closed: boolean }
  winners: ReferralPayoutWinner[]
  winner_count: number
  total_g: number
  unpaid_g: number
  tx_count: number
  pool_address: string | null
  pool_balance_g: number | null
  funded: boolean
  relay_celo: number | null
  can_pay: boolean
}

// Every category the API writes needs a label here, or real money shows up in the
// activity feed as a raw category string. The five below were invisible until the
// g_ledger CHECK that rejected them was dropped (fix_ledger_categories.sql).
const KIND_LABEL: Record<string, string> = {
  mission_record:       'Mission cleared',
  marketplace_purchase: 'Purchase',
  battle_reward:        'Reward paid',
  transfer_out:         'Transfer',
  ubi_claim:            'UBI claim',
  season_reward:        'Season prize',
  referral_reward:      'Referral',
  referral_campaign_reward: 'Referral campaign prize',
  survival_rearm:       'Re-arm',
  duel_stake:           'Duel stake',
  duel_payout:          'Duel payout',
  challenge_reward:     'Challenge prize',
}

// ── CSV export ───────────────────────────────────────────────────────────────
type CsvValue = string | number | null | undefined

function csvCell(v: CsvValue): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: CsvValue[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function DownloadButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_GHOST} shrink-0`}
    >
      ⤓ Download CSV
    </button>
  )
}

function loadSession(): AdminSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed: AdminSession = JSON.parse(raw)
    if (parsed.expires_at * 1000 <= Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

export default function AdminPage() {
  const { address } = useResolvedAuth()
  const walletClient = useActiveWalletClient()

  const [session, setSession] = useState<AdminSession | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  const [seasons, setSeasons] = useState<Season[]>([])
  const [selectedSeason, setSelectedSeason] = useState<string | 'all'>('all')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [onchain, setOnchain] = useState<OnchainRow[]>([])
  const [newSeasonName, setNewSeasonName] = useState('Break Out')
  // A season is a SCHEDULED window with a prize split, not just a name. These default
  // to "Break Out": WAT midnight 29 Aug 2026 to WAT 23:59:59 31 Aug 2026, top 5 paid
  // 70,000 G$ each and the next 5 paid 30,000 G$ each. datetime-local has no timezone
  // of its own — it's interpreted in the BROWSER's local time on submit (see
  // handleCreateSeason), so if you're not in WAT (UTC+1) adjust these two fields to
  // the WAT-equivalent moment in your own timezone before scheduling.
  const [seasonStart, setSeasonStart] = useState('2026-08-29T00:00')
  const [seasonEnd, setSeasonEnd] = useState('2026-08-31T23:59')
  const [seasonWinners, setSeasonWinners] = useState(5)
  const [seasonPerWinner, setSeasonPerWinner] = useState(70000)
  // Second tier is optional — 0 winners means "flat payout, no second tier".
  const [seasonWinners2, setSeasonWinners2] = useState(5)
  const [seasonPerWinner2, setSeasonPerWinner2] = useState(30000)
  // Third tier is optional too — 0 winners means no third tier.
  const [seasonWinners3, setSeasonWinners3] = useState(0)
  const [seasonPerWinner3, setSeasonPerWinner3] = useState(0)
  const [busy, setBusy] = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)
  const [preview, setPreview] = useState<PayoutPreview | null>(null)
  const [paying, setPaying] = useState(false)
  // Re-splitting an EXISTING season's prize pool — separate from the tier fields
  // above (those draft a season still being created). Same default shape (top 5
  // at 70,000 G$, next 5 at 30,000 G$) since that's the one Marvy keeps reaching
  // for; tier 2 at 0 winners collapses to a flat top-N payout.
  const [fundTier1Count, setFundTier1Count] = useState(1)
  const [fundTier1Each, setFundTier1Each] = useState(400000)
  const [fundTier2Count, setFundTier2Count] = useState(1)
  const [fundTier2Each, setFundTier2Each] = useState(240000)
  const [fundTier3Count, setFundTier3Count] = useState(1)
  const [fundTier3Each, setFundTier3Each] = useState(190000)
  const [seasonFunding, setSeasonFunding] = useState(false)

  const [referralCampaigns, setReferralCampaigns] = useState<ReferralCampaign[]>([])
  const [selectedReferralCampaign, setSelectedReferralCampaign] = useState<string | null>(null)
  const [referralPreview, setReferralPreview] = useState<ReferralPayoutPreview | null>(null)
  const [referralFundAmount, setReferralFundAmount] = useState(0)
  const [referralFunding, setReferralFunding] = useState(false)
  const [referralPaying, setReferralPaying] = useState(false)
  const [showReferralCampaigns, setShowReferralCampaigns] = useState(false)

  const [showGrants, setShowGrants] = useState(false)
  const [grantWallets, setGrantWallets] = useState('')
  const [grantAmount, setGrantAmount] = useState(10000)
  const [grantReason, setGrantReason] = useState('')
  const [granting, setGranting] = useState(false)
  const [grantResults, setGrantResults] = useState<GrantResult[] | null>(null)

  // Stuck Face-Off duel recovery — see security_faceoff_stuck_duel_incident.
  // Before this, the only way to void a duel was a raw curl with an admin
  // JWT pulled from Railway env vars. This is that same call, from the UI.
  const [showVoidDuel, setShowVoidDuel] = useState(false)
  const [voidDuelId, setVoidDuelId] = useState('')
  const [voiding, setVoiding] = useState(false)
  const [voidResult, setVoidResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => { setSession(loadSession()) }, [])

  async function handleAdminLogin() {
    if (!address || !walletClient?.account) return
    setLoggingIn(true)
    setLoginError(null)
    try {
      const message = `Valor Admin Login\ntimestamp:${Math.floor(Date.now() / 1000)}`
      const signature = await walletClient.signMessage({ account: walletClient.account, message })

      const res = await fetch(`${API}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: address, message, signature }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Login failed' }))
        throw new Error(body.error ?? 'Login failed')
      }
      const data: AdminSession = await res.json()
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(data))
      setSession(data)
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoggingIn(false)
    }
  }

  const authedFetch = useCallback(
    (path: string, init?: RequestInit) => {
      if (!session) return Promise.reject(new Error('Not signed in'))
      return fetch(`${API}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.token}` },
      })
    },
    [session],
  )

  const refreshSeasons = useCallback(async () => {
    const res = await authedFetch('/admin/seasons')
    if (res.ok) setSeasons(await res.json())
  }, [authedFetch])

  const refreshStats = useCallback(async () => {
    const qs = selectedSeason === 'all' ? '' : `?season_id=${selectedSeason}`
    const res = await authedFetch(`/admin/stats${qs}`)
    if (res.ok) setStats(await res.json())
  }, [authedFetch, selectedSeason])

  const refreshOnchain = useCallback(async () => {
    const res = await authedFetch('/admin/onchain')
    if (res.ok) setOnchain(await res.json())
  }, [authedFetch])

  const refreshPreview = useCallback(async () => {
    if (selectedSeason === 'all') { setPreview(null); return }
    const res = await authedFetch(`/admin/seasons/${selectedSeason}/payout-preview`)
    setPreview(res.ok ? await res.json() : null)
  }, [authedFetch, selectedSeason])

  const refreshReferralCampaigns = useCallback(async () => {
    const res = await authedFetch('/admin/campaigns/referrals')
    if (res.ok) {
      const data: ReferralCampaign[] = await res.json()
      setReferralCampaigns(data)
      // Default to whichever campaign is live, so opening the panel already
      // shows the one someone is most likely here to pay out or fund.
      setSelectedReferralCampaign((cur) => cur ?? data[0]?.id ?? null)
    }
  }, [authedFetch])

  const refreshReferralPreview = useCallback(async () => {
    if (!selectedReferralCampaign) { setReferralPreview(null); return }
    const res = await authedFetch(`/admin/campaigns/referrals/${selectedReferralCampaign}/payout-preview`)
    setReferralPreview(res.ok ? await res.json() : null)
  }, [authedFetch, selectedReferralCampaign])

  useEffect(() => {
    if (!session) return
    refreshSeasons()
  }, [session, refreshSeasons])

  useEffect(() => {
    if (!session) return
    refreshPreview()
  }, [session, refreshPreview])

  useEffect(() => {
    if (!session) return
    refreshReferralCampaigns()
  }, [session, refreshReferralCampaigns])

  useEffect(() => {
    if (!session) return
    refreshReferralPreview()
  }, [session, refreshReferralPreview])

  // Keep the fund input in sync with whichever campaign is selected, so switching
  // campaigns shows what that one is ALREADY funded at, not a stale number.
  useEffect(() => {
    const c = referralCampaigns.find((x) => x.id === selectedReferralCampaign)
    if (c) setReferralFundAmount(c.prize_pool_g)
  }, [selectedReferralCampaign, referralCampaigns])


  useEffect(() => {
    if (!session) return
    refreshStats()
    refreshOnchain()
  }, [session, refreshStats, refreshOnchain])

  // Up to two tiers: top `seasonWinners` at `seasonPerWinner` each, then the next
  // `seasonWinners2` at `seasonPerWinner2` each (0 winners2 = no second tier, flat
  // payout). Ties are broken by who reached the wave first, so no two players ever
  // share a place and the table is always unambiguous.
  const seasonTiers = [
    { count: seasonWinners, each: seasonPerWinner },
    ...(seasonWinners2 > 0 && seasonPerWinner2 > 0 ? [{ count: seasonWinners2, each: seasonPerWinner2 }] : []),
    ...(seasonWinners3 > 0 && seasonPerWinner3 > 0 ? [{ count: seasonWinners3, each: seasonPerWinner3 }] : []),
  ]
  const { pool: seasonPool, bps: seasonBps } = tierSplit(seasonTiers)

  // Same shape, for re-funding/re-splitting a season that already exists.
  const fundTiers = [
    { count: fundTier1Count, each: fundTier1Each },
    ...(fundTier2Count > 0 && fundTier2Each > 0 ? [{ count: fundTier2Count, each: fundTier2Each }] : []),
    ...(fundTier3Count > 0 && fundTier3Each > 0 ? [{ count: fundTier3Count, each: fundTier3Each }] : []),
  ]
  const { pool: fundPool, bps: fundBps } = tierSplit(fundTiers)

  async function handleDeleteSeason(sn: Season) {
    if (!window.confirm(`Delete "${sn.name}" permanently?\n\nThis removes the season and any progress in it. A season that has already paid a winner cannot be deleted.`)) return
    setBusy(true)
    try {
      const res = await authedFetch(`/admin/seasons/${sn.id}`, { method: 'DELETE' })
      if (res.ok) await refreshSeasons()
      else window.alert(`Could not delete: ${await res.text()}`)
    } finally {
      setBusy(false)
    }
  }

  // Open a scheduled season EARLY so it can be played through before it goes live,
  // then put its real start time back. Progress made while testing must be wiped
  // afterwards (see handleResetProgress) or the tester starts the season ahead.
  async function handleReschedule(sn: Season, startsAt: string, endsAt?: string) {
    setBusy(true)
    try {
      const res = await authedFetch(`/admin/seasons/${sn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starts_at: startsAt, ends_at: endsAt }),
      })
      if (res.ok) await refreshSeasons()
      else window.alert(`Could not reschedule: ${await res.text()}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleResetProgress(sn: Season) {
    if (!window.confirm(`Wipe ALL player progress in "${sn.name}"?\n\nEveryone goes back to wave 1. Do this after a test run so nobody starts the season with a head start.`)) return
    setBusy(true)
    try {
      const res = await authedFetch(`/admin/seasons/${sn.id}/reset-progress`, { method: 'POST' })
      if (res.ok) {
        const d = await res.json()
        window.alert(`Progress cleared (${d.cleared} player row(s)).`)
        await refreshSeasons()
      } else window.alert(`Could not reset: ${await res.text()}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateSeason() {
    if (!newSeasonName.trim()) return
    // datetime-local is in the BROWSER's timezone, which is the one you're scheduling
    // in; toISOString converts to the UTC the server stores.
    const startsIso = seasonStart ? new Date(seasonStart).toISOString() : undefined
    const endsIso = seasonEnd ? new Date(seasonEnd).toISOString() : undefined
    if (startsIso && endsIso && endsIso <= startsIso) {
      window.alert('The season must end after it starts.')
      return
    }
    const tierSummary = seasonTiers.length > 1
      ? `top ${seasonWinners} take ${seasonPerWinner.toLocaleString()} G$ each` + seasonTiers.slice(1).map((t) => `, next ${t.count} take ${t.each.toLocaleString()} G$ each`).join('')
      : `top ${seasonWinners} take ${seasonPerWinner.toLocaleString()} G$ each`
    const summary =
      `Create "${newSeasonName.trim()}"?\n\n` +
      `Opens:  ${startsIso ?? 'now'}\n` +
      `Closes: ${endsIso ?? 'left open'}\n` +
      `Prize:  ${seasonPool.toLocaleString()} G$ — ${tierSummary}`
    if (!window.confirm(summary)) return

    setBusy(true)
    try {
      const res = await authedFetch('/admin/seasons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newSeasonName.trim(),
          starts_at: startsIso,
          ends_at: endsIso,
          prize_pool_g: seasonPool,
          payout_bps: seasonBps,
        }),
      })
      if (res.ok) {
        await refreshSeasons()
      } else {
        window.alert(`Could not create the season: ${await res.text()}`)
      }
    } finally {
      setBusy(false)
    }
  }

  // Pays the season prizes on-chain. Long-running by nature: each prize is split
  // into 10,000 G$ chunks (the pool's per-transfer cap), so this is dozens of
  // transactions, not one. Safe to re-run — chunks that already landed are
  // skipped without gas, so a timeout here is resumed by pressing the button again.
  async function handlePayout() {
    if (!preview) return
    const { winners, unpaid_g, tx_count, season } = preview
    const lines = winners
      .filter((w) => w.status !== 'paid')
      .map((w) => `  ${w.rank}. ${w.username || w.wallet_address.slice(0, 10)} — ${w.amount_g.toLocaleString()} G$`)
      .join('\n')
    const ok = window.confirm(
      `Pay out "${season.name}"?\n\n${lines}\n\n` +
      `Total: ${unpaid_g.toLocaleString()} G$ across ${tx_count} on-chain transactions.\n\n` +
      `This sends REAL money and cannot be undone. It may take several minutes.`,
    )
    if (!ok) return

    setPaying(true)
    try {
      const res = await authedFetch(`/admin/seasons/${season.id}/payout`, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (res.ok && body) {
        window.alert(
          body.season_paid
            ? `Season paid in full — ${body.paid} of ${body.attempted} winners settled.`
            : `${body.paid} of ${body.attempted} settled, ${body.still_unpaid} still unpaid.\n\n` +
              `Press Pay again to resume: anything already sent is skipped.`,
        )
      } else {
        window.alert(`Payout did not run: ${body?.error ?? await res.text()}`)
      }
      await Promise.all([refreshPreview(), refreshSeasons()])
    } finally {
      setPaying(false)
    }
  }

  // Sets (or raises) a season's recorded prize pool. This is the DB number the
  // payout splits percentages of — it does NOT move any G$ by itself. The actual
  // money has to already be sitting in the on-chain ValorRewardPool; this just
  // tells the season how much of that pool it's allowed to pay out.
  async function handleFundSeason() {
    if (!selectedSeason || selectedSeason === 'all' || fundPool < 0) return
    setSeasonFunding(true)
    try {
      const res = await authedFetch(`/admin/seasons/${selectedSeason}/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prize_pool_g: fundPool, payout_bps: fundBps }),
      })
      if (res.ok) {
        await Promise.all([refreshSeasons(), refreshPreview()])
      } else {
        window.alert(`Could not fund the season: ${await res.text()}`)
      }
    } finally {
      setSeasonFunding(false)
    }
  }

  async function handleFundReferralCampaign() {
    if (!selectedReferralCampaign || referralFundAmount < 0) return
    setReferralFunding(true)
    try {
      const res = await authedFetch(`/admin/campaigns/referrals/${selectedReferralCampaign}/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prize_pool_g: referralFundAmount }),
      })
      if (res.ok) {
        await Promise.all([refreshReferralCampaigns(), refreshReferralPreview()])
      } else {
        window.alert(`Could not fund the campaign: ${await res.text()}`)
      }
    } finally {
      setReferralFunding(false)
    }
  }

  // Pays a campaign's referral leaderboard on-chain. Same shape as handlePayout:
  // chunked into 10,000 G$ transfers, safe to re-run, and locked until the
  // campaign has actually closed (winners freeze on the first run).
  async function handleReferralPayout() {
    if (!referralPreview) return
    const { winners, unpaid_g, tx_count, campaign } = referralPreview
    const lines = winners
      .filter((w) => w.status !== 'paid')
      .map((w) => `  ${w.rank}. ${w.username || w.wallet_address.slice(0, 10)} — ${w.amount_g.toLocaleString()} G$`)
      .join('\n')
    const ok = window.confirm(
      `Pay out "${campaign.name}"?\n\n${lines}\n\n` +
      `Total: ${unpaid_g.toLocaleString()} G$ across ${tx_count} on-chain transactions.\n\n` +
      `This sends REAL money and cannot be undone. It may take several minutes.`,
    )
    if (!ok) return

    setReferralPaying(true)
    try {
      const res = await authedFetch(`/admin/campaigns/referrals/${campaign.id}/payout`, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (res.ok && body) {
        window.alert(
          body.campaign_paid
            ? `Campaign paid in full — ${body.paid} of ${body.attempted} winners settled.`
            : `${body.paid} of ${body.attempted} settled, ${body.still_unpaid} still unpaid.\n\n` +
              `Press Pay again to resume: anything already sent is skipped.`,
        )
      } else {
        window.alert(`Payout did not run: ${body?.error ?? await res.text()}`)
      }
      await Promise.all([refreshReferralPreview(), refreshReferralCampaigns()])
    } finally {
      setReferralPaying(false)
    }
  }

  async function handleEndSeason(id: string) {
    setBusy(true)
    try {
      const res = await authedFetch(`/admin/seasons/${id}/end`, { method: 'POST' })
      if (res.ok) await refreshSeasons()
    } finally {
      setBusy(false)
    }
  }

  async function handleGrantRewards() {
    const wallets = grantWallets.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean)
    if (wallets.length === 0 || grantAmount <= 0 || !grantReason.trim()) return
    const summary =
      `Pay ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} ${grantAmount.toLocaleString()} G$ each ` +
      `(${(wallets.length * grantAmount).toLocaleString()} G$ total)?\n\nReason: ${grantReason.trim()}\n\n` +
      `Only wallets already registered as Valor players will be paid — others are skipped and reported.`
    if (!window.confirm(summary)) return

    setGranting(true)
    setGrantResults(null)
    try {
      const res = await authedFetch('/admin/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallets, amount_g: grantAmount, reason: grantReason.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        setGrantResults(data.results as GrantResult[])
      } else {
        window.alert(`Could not run the grant: ${await res.text()}`)
      }
    } finally {
      setGranting(false)
    }
  }

  async function handleVoidDuel() {
    const id = voidDuelId.trim()
    if (!id) return
    if (!window.confirm(
      `Void duel ${id}?\n\nThis only works on a duel stuck at "accepted" with no resolved match — ` +
      `it refunds BOTH stakes in full (no house cut) and marks it resolved. Cannot be undone.`,
    )) return

    setVoiding(true)
    setVoidResult(null)
    try {
      const res = await authedFetch(`/admin/duels/${id}/void`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        const txs = Array.isArray(body.refund_txs) ? body.refund_txs.filter(Boolean) : []
        setVoidResult({ ok: true, message: `Voided — both stakes refunded${txs.length ? ` (${txs.length} tx)` : ''}.` })
        setVoidDuelId('')
      } else {
        setVoidResult({ ok: false, message: body.error ?? `Failed (${res.status})` })
      }
    } catch (err) {
      setVoidResult({ ok: false, message: err instanceof Error ? err.message : 'Request failed' })
    } finally {
      setVoiding(false)
    }
  }

  function handleDownloadStats() {
    if (!stats) return
    const label = stats.season_name ?? 'all-time'
    const rows: CsvValue[][] = [
      ['metric', 'value'],
      ['season', label],
      ['window_start', stats.starts_at],
      ['window_end', stats.ends_at ?? 'now'],
      ['new_players', stats.new_players],
      ['verified_players', stats.verified_players],
      ['played_players', stats.played_players],
      ['active_players', stats.active_players],
      ['total_battles', stats.total_battles],
      ['g_awarded', stats.total_g_awarded],
      ['g_volume_moved', stats.total_g_volume],
      ['g_transferred_out', stats.total_g_transferred_out],
    ]
    downloadCsv(`valor-summary-${label.replace(/\s+/g, '-').toLowerCase()}-${todayStamp()}.csv`, toCsv(rows))
  }

  async function handleDownloadActivity() {
    setBusy(true)
    try {
      // Pull the FULL history for the export, not just the 100 shown in the list.
      const res = await authedFetch('/admin/onchain?limit=10000')
      if (!res.ok) return
      const all: OnchainRow[] = await res.json()
      const header: CsvValue[] = ['date', 'type', 'wallet', 'detail', 'tx_hash', 'celoscan_url']
      const body: CsvValue[][] = all.map((r) => [
        r.created_at,
        KIND_LABEL[r.kind] ?? r.kind,
        r.wallet,
        r.detail ?? '',
        r.tx_hash,
        `https://celoscan.io/tx/${r.tx_hash}`,
      ])
      downloadCsv(`valor-onchain-activity-${todayStamp()}.csv`, toCsv([header, ...body]))
    } finally {
      setBusy(false)
    }
  }

  const openSeason = seasons.find((s) => !s.ends_at)

  if (!session) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center px-6 text-center overflow-hidden" style={{ background: '#04030c' }}>
        <div aria-hidden className="absolute inset-0 opacity-35" style={{ background: 'url(/art/hero.webp) 70% 20% / cover' }} />
        <div aria-hidden className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, rgba(4,3,12,0.5), #04030c 78%)' }} />
        <div className="relative flex flex-col items-center gap-4 max-w-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/valor-mark.png" alt="" className="w-20 drop-shadow-[0_0_24px_rgba(234,179,8,0.5)]" />
          <p className="text-[10px] uppercase tracking-[0.34em] font-bold text-amber-500">Admin console</p>
          <h1 className="font-[family-name:var(--font-family-display)] font-black text-white text-3xl tracking-wide -mt-2">Valor Admin</h1>
          <p className="text-slate-400 text-sm">Sign a message with your admin wallet to view season and G$ volume stats.</p>
          {loginError && <p className="text-red-400 text-xs">{loginError}</p>}
          <motion.button
            onClick={handleAdminLogin}
            disabled={loggingIn || !address}
            whileTap={{ scale: 0.97 }}
            className={`${BTN_GOLD} px-7 py-3 text-sm uppercase tracking-widest mt-1`}
          >
            {loggingIn ? 'Signing…' : 'Sign in as Admin'}
          </motion.button>
        </div>
      </div>
    )
  }

  // Presentation helpers for the season rail and banner (no state, no requests).
  const seasonStatus = (sn: Season) => {
    const now = Date.now()
    const opens = new Date(sn.starts_at).getTime()
    const closes = sn.ends_at ? new Date(sn.ends_at).getTime() : null
    if (opens > now) return { label: 'Upcoming', tone: 'gold' as const }
    if (closes === null) return { label: 'Open', tone: 'green' as const }
    if (closes >= now) return { label: 'Live', tone: 'green' as const }
    return { label: 'Closed', tone: 'slate' as const }
  }
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const daysFromNow = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5)
  const ago = (iso: string) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
    return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
  }
  const liveSeason = seasons.find((sn) => ['Live', 'Open'].includes(seasonStatus(sn).label))
  const nextSeason = seasons
    .filter((sn) => new Date(sn.starts_at).getTime() > Date.now())
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0]

  return (
    <div className="flex flex-col gap-8 w-full">
      <PageBanner
        kicker="Operations"
        title="Season ops"
        sub="Schedule seasons, set prize pools and run payouts. These controls move real G$, so every payout shows its exact transfer before you confirm."
        actions={<button onClick={() => setShowScheduler(true)} className={`${BTN_GOLD} px-4 py-2.5 text-sm`}><CalendarPlus size={15} /> Schedule a season</button>}
        aside={<>
          <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
            <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Live now</p>
            {liveSeason ? (
              <>
                <p className="font-[family-name:var(--font-family-display)] font-black text-white text-lg leading-tight mt-1 truncate">{liveSeason.name}</p>
                <p className="text-[11px] text-emerald-400 mt-0.5">{liveSeason.ends_at ? `closes in ${Math.max(0, daysFromNow(liveSeason.ends_at))}d` : 'open-ended'}</p>
              </>
            ) : <p className="text-sm text-slate-500 mt-1.5">No season is running</p>}
          </div>
          <div className="rounded-xl border border-valor-border/80 bg-black/45 backdrop-blur px-4 py-3">
            <p className="text-[9px] uppercase tracking-[0.22em] font-bold text-slate-500">Up next</p>
            {nextSeason ? (
              <>
                <p className="font-[family-name:var(--font-family-display)] font-black text-white text-lg leading-tight mt-1 truncate">{nextSeason.name}</p>
                <p className="text-[11px] text-amber-400 mt-0.5">opens in {Math.max(0, daysFromNow(nextSeason.starts_at))}d</p>
              </>
            ) : <p className="text-sm text-slate-500 mt-1.5">Nothing scheduled</p>}
          </div>
        </>}
      />

      {/* Overview: the numbers first, for the selected season or all time */}
      <section className="flex flex-col gap-3">
        <SectionTitle right={stats ? <DownloadButton onClick={handleDownloadStats} /> : undefined}>
          {stats ? `${stats.season_name ?? 'All-time'} overview` : 'Overview'}
        </SectionTitle>
        {stats ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="New players" count={stats.new_players} />
            <Stat label="Verified players" count={stats.verified_players} />
            <Stat label="Played players" count={stats.played_players} />
            <Stat label="Active players" count={stats.active_players} />
            <Stat label="Total battles" count={stats.total_battles} />
            <Stat label="G$ awarded" count={stats.total_g_awarded} format={(v) => compact(v)} unit="G$" />
            <Stat label="G$ volume moved" count={stats.total_g_volume} format={(v) => compact(v)} unit="G$" />
            <Stat label="G$ transferred out" count={stats.total_g_transferred_out} format={(v) => compact(v)} unit="G$" />
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="h-[88px] rounded-xl border border-valor-border bg-white/[0.03] animate-pulse" />)}
          </div>
        )}
      </section>

      <div className="grid lg:grid-cols-12 gap-6 items-start">
        {/* ── Seasons ── */}
        <div className="lg:col-span-8 flex flex-col gap-6 min-w-0">
          <section className="flex flex-col gap-3">
            <SectionTitle>Seasons</SectionTitle>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x [mask-image:linear-gradient(to_right,#000_93%,transparent)]">
              <button
                onClick={() => setSelectedSeason('all')}
                aria-pressed={selectedSeason === 'all'}
                className={`snap-start shrink-0 w-48 text-left rounded-xl border p-3.5 transition ${selectedSeason === 'all' ? 'border-amber-500/60 bg-amber-500/[0.07] shadow-[0_10px_30px_-14px_rgba(234,179,8,0.55)]' : 'border-valor-border bg-black/25 hover:border-slate-500'}`}
              >
                <Badge tone="slate">All seasons</Badge>
                <p className="mt-2.5 font-[family-name:var(--font-family-display)] font-black text-white text-base leading-tight">All time</p>
                <p className="text-[11px] text-slate-500 mt-0.5">Every season combined</p>
              </button>
              {seasons.map((sn) => {
                const st = seasonStatus(sn)
                const sel = selectedSeason === sn.id
                return (
                  <button
                    key={sn.id}
                    onClick={() => setSelectedSeason(sn.id)}
                    aria-pressed={sel}
                    className={`snap-start shrink-0 w-56 text-left rounded-xl border p-3.5 transition ${sel ? 'border-amber-500/60 bg-amber-500/[0.07] shadow-[0_10px_30px_-14px_rgba(234,179,8,0.55)]' : 'border-valor-border bg-black/25 hover:border-slate-500'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {sn.payout_status === 'paid' && <span className="text-[10px] font-bold text-emerald-400 tracking-wider">PAID</span>}
                    </div>
                    <p className="mt-2.5 font-[family-name:var(--font-family-display)] font-black text-white text-base leading-tight truncate">{sn.name}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">{fmtDay(sn.starts_at)} → {sn.ends_at ? fmtDay(sn.ends_at) : 'open-ended'}</p>
                    <p className="mt-2.5 text-sm font-bold tabular-nums text-amber-300">{sn.prize_pool_g.toLocaleString()} <span className="text-[10px] text-slate-500 font-semibold">G$ pool</span></p>
                  </button>
                )
              })}
            </div>
          </section>

          {selectedSeason === 'all' ? (
            <div className={`${PANEL} text-center py-14 flex flex-col items-center gap-3`}>
              <span className="grid place-items-center w-12 h-12 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300"><CalendarPlus size={22} /></span>
              <p className="font-[family-name:var(--font-family-display)] font-black text-white text-xl">Pick a season to manage it</p>
              <p className="text-sm text-slate-500 max-w-sm">Choose one above to open its timeline, set the prize pool and split, check the payout and control when it runs. The overview above switches with it.</p>
            </div>
          ) : (() => {
            const sn = seasons.find((x) => x.id === selectedSeason)
            if (!sn) return null
            const now = Date.now()
            const opensAt = new Date(sn.starts_at).getTime()
            const closesAt = sn.ends_at ? new Date(sn.ends_at).getTime() : null
            const live = opensAt <= now && (closesAt === null || closesAt >= now)
            const upcoming = opensAt > now

            if (!sn) return null
            const span = closesAt ? closesAt - opensAt : 0
            const pct = closesAt && span > 0 ? Math.max(0, Math.min(100, ((now - opensAt) / span) * 100)) : live ? 100 : 0
            const st = seasonStatus(sn)
            return (
              <div className={`${PANEL} flex flex-col gap-6`}>
                <div className="flex items-start justify-between gap-5 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap"><Badge tone={st.tone}>{st.label}</Badge>{sn.payout_status === 'paid' && <Badge tone="green">Paid out</Badge>}</div>
                    <h2 className="font-[family-name:var(--font-family-display)] font-black text-white text-3xl leading-tight mt-2">{sn.name}</h2>
                    <p className="text-xs text-slate-400">
                                    {live ? <span className="text-emerald-400">LIVE now</span>
                      : upcoming ? <span className="text-amber-400">opens {new Date(sn.starts_at).toLocaleString()}</span>
                      : <span className="text-slate-500">closed</span>}
                    {closesAt && <> · closes {new Date(sn.ends_at as string).toLocaleString()}</>}
              </p>
                  </div>
                  <div className="sm:text-right">
                    <p className={LABEL}>Prize pool</p>
                    <p className="font-[family-name:var(--font-family-display)] font-black text-4xl leading-none mt-1.5 tabular-nums bg-linear-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent">
                      {sn.prize_pool_g.toLocaleString()}<span className="ml-1.5 font-sans text-sm font-semibold text-slate-500">G$</span>
                    </p>
                  </div>
                </div>

                <div>
                  <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full rounded-full bg-linear-to-r from-amber-700 via-amber-400 to-amber-200 transition-[width] duration-700" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-500 mt-1.5">
                    <span>Opens {new Date(sn.starts_at).toLocaleString()}</span>
                    <span>{closesAt ? `Closes ${new Date(closesAt).toLocaleString()}` : 'Open-ended'}</span>
                  </div>
                </div>

                <div className="grid xl:grid-cols-[1.2fr_1fr] gap-5 items-stretch">
                  <div className="flex flex-col gap-2.5">
                    {preview && preview.winner_count > 0 && (
                      <div className="p-3.5 rounded-xl border border-amber-500/35 bg-amber-500/[0.04] h-full">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-amber-400">Prize payout</p>
                          {preview.season.payout_status === 'paid' && (
                            <Badge tone="green">Paid</Badge>
                          )}
                        </div>

                        <div className="max-h-56 overflow-y-auto rounded-lg mb-2" style={{ background: 'rgba(0,0,0,0.3)' }}>
                          {preview.winners.map((w) => (
                            <div key={w.wallet_address} className="flex items-center gap-2 px-2.5 py-1.5 text-xs border-b last:border-0" style={{ borderColor: 'rgba(42,42,58,0.5)' }}>
                              <span className="w-5 text-slate-500 font-bold tabular-nums">{w.rank}</span>
                              <span className="flex-1 truncate text-slate-200">
                                {w.username || `${w.wallet_address.slice(0, 6)}…${w.wallet_address.slice(-4)}`}
                              </span>
                              <span className="text-slate-500 tabular-nums">{w.waves}w</span>
                              <span className="text-amber-300 font-bold tabular-nums">{w.amount_g.toLocaleString()} G$</span>
                              {!!w.sent_g && w.status !== 'paid' && (
                                <span className="text-emerald-400/80 text-[10px] tabular-nums">{w.sent_g.toLocaleString()} sent</span>
                              )}
                              {w.status === 'paid'
                                ? <span className="text-emerald-400 text-[10px] font-bold w-12 text-right">PAID</span>
                                : w.status === 'failed'
                                ? <span className="text-red-400 text-[10px] font-bold w-12 text-right">FAILED</span>
                                : <span className="text-slate-600 text-[10px] w-12 text-right">—</span>}
                            </div>
                          ))}
                        </div>

                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400 mb-2">
                          <span>{preview.winner_count} winners</span>
                          <span className="text-slate-200 font-bold">{preview.unpaid_g.toLocaleString()} G$ left to send</span>
                          <span>{preview.tx_count} transactions</span>
                          {preview.pool_balance_g !== null && (
                            <span className={preview.funded ? 'text-emerald-400' : 'text-red-400'}>
                              pool {preview.pool_balance_g.toLocaleString()} G$
                            </span>
                          )}
                          {preview.relay_celo !== null && (
                            <span className={preview.relay_celo > 0.1 ? '' : 'text-red-400'}>
                              gas {preview.relay_celo.toFixed(2)} CELO
                            </span>
                          )}
                        </div>

                        {!preview.season.closed && (
                          <p className="text-[11px] text-amber-300/90 mb-2">
                            Season is still running. Payout unlocks when it closes
                            {preview.season.ends_at && ` — ${new Date(preview.season.ends_at).toLocaleString()}`}.
                          </p>
                        )}
                        {preview.season.closed && !preview.funded && preview.unpaid_g > 0 && (
                          <p className="text-[11px] text-red-400 mb-2">
                            Reward pool holds {preview.pool_balance_g?.toLocaleString() ?? '?'} G$ but {preview.unpaid_g.toLocaleString()} G$ is still left to send. Top it up before paying, or the run stops part-way.
                          </p>
                        )}
                        {(preview.pool_address || preview.relay_address) && (
                          <div className="text-[10px] text-slate-500 mb-2 break-all space-y-0.5">
                            {preview.pool_address && <p>Reward pool: <span className="text-slate-300 select-all">{preview.pool_address}</span></p>}
                            {preview.relay_address && <p>Relay (pays gas): <span className="text-slate-300 select-all">{preview.relay_address}</span></p>}
                          </div>
                        )}

                        <button
                          onClick={handlePayout}
                          disabled={paying || busy || !preview.can_pay}
                          className={`${BTN_GOLD} w-full py-2.5`}
                        >
                          {paying ? 'Paying… this takes a few minutes'
                            : preview.unpaid_g === 0 ? 'All winners paid'
                            : !preview.season.closed ? 'Locked until the season closes'
                            : `Pay ${preview.winners.filter((w) => w.status !== 'paid').length} winners · ${preview.unpaid_g.toLocaleString()} G$`}
                        </button>
                      </div>
                    )}
                    {!(preview && preview.winner_count > 0) && (
                      <div className="rounded-xl border border-dashed border-valor-border p-5 text-sm text-slate-500 h-full grid place-items-center text-center">
                        <span><span className="block text-[10px] uppercase tracking-[0.3em] font-bold text-slate-400 mb-1.5">Prize payout</span>Winners and the exact transfer appear here once this season has scores.</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2.5">
                    <div className={`${SUBPANEL} flex flex-col gap-3 h-full p-3.5`}>
                      <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-slate-400">Pool &amp; split</p>
                      <div className="flex flex-col gap-2">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1">
                          <span className={LABEL}>Winners paid (tier 1)</span>
                          <input type="number" min={1} max={20} value={fundTier1Count}
                            onChange={(e) => setFundTier1Count(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                            className={INPUT} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={LABEL}>G$ each</span>
                          <input type="number" min={0} step={1000} value={fundTier1Each}
                            onChange={(e) => setFundTier1Each(Math.max(0, Number(e.target.value) || 0))}
                            className={INPUT} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={LABEL}>Next winners (tier 2, optional)</span>
                          <input type="number" min={0} max={20} value={fundTier2Count}
                            onChange={(e) => setFundTier2Count(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                            className={INPUT} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={LABEL}>G$ each</span>
                          <input type="number" min={0} step={1000} value={fundTier2Each}
                            onChange={(e) => setFundTier2Each(Math.max(0, Number(e.target.value) || 0))}
                            className={INPUT} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={LABEL}>Next winners (tier 3, optional)</span>
                          <input type="number" min={0} max={20} value={fundTier3Count}
                            onChange={(e) => setFundTier3Count(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                            className={INPUT} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={LABEL}>G$ each</span>
                          <input type="number" min={0} step={500} value={fundTier3Each}
                            onChange={(e) => setFundTier3Each(Math.max(0, Number(e.target.value) || 0))}
                            className={INPUT} />
                        </label>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] text-slate-400">
                          Pool <span className="text-amber-400 font-bold">{fundPool.toLocaleString()} G$</span>
                          {sn.prize_pool_g > 0 && sn.prize_pool_g !== fundPool && (
                            <span className="text-slate-600"> (currently {sn.prize_pool_g.toLocaleString()} G$)</span>
                          )}
                        </p>
                        <button
                          onClick={handleFundSeason}
                          disabled={seasonFunding || fundPool <= 0}
                          className={BTN_GOLD}
                        >
                          {seasonFunding ? 'Setting…' : 'Set pool & split'}
                        </button>
                      </div>
              </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-red-500/15 bg-red-500/[0.025] p-4 flex flex-col gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.22em] font-bold text-slate-400">Season controls</p>
                    <p className="text-[11px] text-slate-600 mt-0.5">Open-early and wipe are for testing a season before it goes live, because progress persists.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {upcoming && (
                      <button
                        onClick={() => handleReschedule(sn, new Date(Date.now() - 60_000).toISOString())}
                        disabled={busy}
                        className={BTN_OK}
                      >
                        Open now (for testing)
                      </button>
                    )}
                    {live && (
                      <button
                        onClick={() => {
                          const back = window.prompt('Set the real opening time (your local time, e.g. 2026-07-27T00:00)', '2026-07-27T00:00')
                          if (back) handleReschedule(sn, new Date(back).toISOString())
                        }}
                        disabled={busy}
                        className={BTN_GHOST}
                      >
                        Close back to scheduled start
                      </button>
                    )}
                    {closesAt && closesAt > now && (
                      <button
                        onClick={() => {
                          const to = window.prompt('Set the new closing time (your local time, e.g. 2026-11-14T16:00)', '2026-11-14T16:00')
                          if (!to) return
                          const t = new Date(to)
                          if (Number.isNaN(t.getTime())) { window.alert('That is not a valid date and time.'); return }
                          if (window.confirm(`Close "${sn.name}" at ${t.toLocaleString()}?`)) void handleReschedule(sn, sn.starts_at, t.toISOString())
                        }}
                        disabled={busy}
                        className={BTN_GHOST}
                      >
                        Change closing time
                      </button>
                    )}
                    <button
                      onClick={() => handleResetProgress(sn)}
                      disabled={busy}
                      className={BTN_WARN}
                    >
                      Wipe test progress
                    </button>
                    <button
                      onClick={() => handleDeleteSeason(sn)}
                      disabled={busy}
                      className={BTN_DANGER}
                    >
                      Delete season
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
        </div>

        {/* ── Right rail ── */}
        <aside className="lg:col-span-4 flex flex-col gap-6 min-w-0 lg:sticky lg:top-24">
          <section className={`${PANEL} flex flex-col gap-3`}>
            <p className="text-[11px] uppercase tracking-[0.22em] font-bold text-slate-400">Tools</p>
            <button onClick={() => setShowScheduler(true)} className="group flex items-center gap-3 w-full text-left rounded-xl border border-valor-border/80 bg-black/25 px-3.5 py-3 transition hover:border-amber-500/45 hover:bg-amber-500/[0.04]">
              <span className="grid place-items-center w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0"><CalendarPlus size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-white">Schedule a season</span>
                <span className="block text-[11px] text-slate-500">Window, prize pool and split</span>
              </span>
              <ChevronRight size={16} className="text-slate-600 group-hover:text-amber-400 transition-colors shrink-0" />
            </button>
            <button onClick={() => setShowReferralCampaigns(true)} className="group flex items-center gap-3 w-full text-left rounded-xl border border-valor-border/80 bg-black/25 px-3.5 py-3 transition hover:border-amber-500/45 hover:bg-amber-500/[0.04]">
              <span className="grid place-items-center w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0"><Megaphone size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-white">Referral campaigns</span>
                <span className="block text-[11px] text-slate-500">Fund and pay the referral race</span>
              </span>
              <ChevronRight size={16} className="text-slate-600 group-hover:text-amber-400 transition-colors shrink-0" />
            </button>
            <button onClick={() => setShowGrants(true)} className="group flex items-center gap-3 w-full text-left rounded-xl border border-valor-border/80 bg-black/25 px-3.5 py-3 transition hover:border-amber-500/45 hover:bg-amber-500/[0.04]">
              <span className="grid place-items-center w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0"><Coins size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-white">One-off grants</span>
                <span className="block text-[11px] text-slate-500">Pay wallets once, never twice</span>
              </span>
              <ChevronRight size={16} className="text-slate-600 group-hover:text-amber-400 transition-colors shrink-0" />
            </button>
            <button onClick={() => setShowVoidDuel(true)} className="group flex items-center gap-3 w-full text-left rounded-xl border border-valor-border/80 bg-black/25 px-3.5 py-3 transition hover:border-amber-500/45 hover:bg-amber-500/[0.04]">
              <span className="grid place-items-center w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0"><Undo2 size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-white">Void a stuck duel</span>
                <span className="block text-[11px] text-slate-500">Refund both stakes</span>
              </span>
              <ChevronRight size={16} className="text-slate-600 group-hover:text-amber-400 transition-colors shrink-0" />
            </button>
          </section>

          <section className={`${PANEL} flex flex-col gap-3`}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] uppercase tracking-[0.22em] font-bold text-slate-400">On-chain activity</p>
              <DownloadButton onClick={handleDownloadActivity} disabled={busy} />
            </div>
            {onchain.length === 0 ? (
              <p className="text-slate-600 text-xs">No on-chain activity yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-[30rem] overflow-y-auto -mr-1 pr-1">
                {onchain.map((r) => (
                  <a
                    key={r.tx_hash}
                    href={`https://celoscan.io/tx/${r.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-valor-border/70 bg-black/20 hover:border-amber-500/40 hover:bg-white/[0.03] transition-colors"
                  >
                    <span className="grid place-items-center w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-300 shrink-0"><ArrowUpRight size={14} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-bold text-slate-200 truncate">{KIND_LABEL[r.kind] ?? r.kind}</span>
                      <span className="block text-[11px] text-slate-500 font-mono truncate">{r.wallet.slice(0, 8)}…{r.wallet.slice(-4)}</span>
                    </span>
                    <span className="text-right shrink-0">
                      {r.detail && <span className="block text-xs font-bold text-amber-300 tabular-nums">{r.kind === 'mission_record' ? `OP ${r.detail}` : `${formatGDollarNumber(Number(r.detail))} G$`}</span>}
                      <span className="block text-[10px] text-slate-600">{ago(r.created_at)}</span>
                    </span>
                  </a>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* ── Tool drawers: same forms and handlers as before, in slide-over panels ── */}
      <Drawer open={showScheduler} onClose={() => setShowScheduler(false)} kicker="Season ops" title="Schedule a season" sub="Create a scheduled window and prize split.">
          <input
            type="text"
            value={newSeasonName}
            onChange={(e) => setNewSeasonName(e.target.value)}
            placeholder="Season name"
            className={INPUT}
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Opens (your local time)</span>
              <input type="datetime-local" value={seasonStart} onChange={(e) => setSeasonStart(e.target.value)}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Closes</span>
              <input type="datetime-local" value={seasonEnd} onChange={(e) => setSeasonEnd(e.target.value)}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Winners paid (tier 1)</span>
              <input type="number" min={1} max={20} value={seasonWinners}
                onChange={(e) => setSeasonWinners(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>G$ each</span>
              <input type="number" min={0} step={1000} value={seasonPerWinner}
                onChange={(e) => setSeasonPerWinner(Math.max(0, Number(e.target.value) || 0))}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Next winners paid (tier 2, optional)</span>
              <input type="number" min={0} max={20} value={seasonWinners2}
                onChange={(e) => setSeasonWinners2(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>G$ each</span>
              <input type="number" min={0} step={1000} value={seasonPerWinner2}
                onChange={(e) => setSeasonPerWinner2(Math.max(0, Number(e.target.value) || 0))}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Next winners paid (tier 3, optional)</span>
              <input type="number" min={0} max={20} value={seasonWinners3}
                onChange={(e) => setSeasonWinners3(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>G$ each</span>
              <input type="number" min={0} step={1000} value={seasonPerWinner3}
                onChange={(e) => setSeasonPerWinner3(Math.max(0, Number(e.target.value) || 0))}
                className={INPUT} />
            </label>
          </div>
          <p className="text-xs text-slate-500">
            Prize pool <span className="text-amber-400 font-bold">{seasonPool.toLocaleString()} G$</span>
            {' · '}top {seasonWinners} take {seasonPerWinner.toLocaleString()} G$ each
            {seasonTiers.slice(1).map((t, i) => <span key={i}>{', next '}{t.count}{' take '}{t.each.toLocaleString()}{' G$ each'}</span>)}
            {Math.max(...seasonTiers.map((t) => t.each)) > 10000 && (
              <span className="text-slate-600"> · winner prizes over 10,000 G$ are paid in multiple transactions (10,000 G$ on-chain cap per transfer)</span>
            )}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleCreateSeason}
              disabled={busy || !newSeasonName.trim()}
              className={BTN_GOLD}
            >
              Schedule season
            </button>
            {openSeason && (
              <button
                onClick={() => handleEndSeason(openSeason.id)}
                disabled={busy}
                className={BTN_GHOST}
              >
                End &quot;{openSeason.name}&quot;
              </button>
            )}
          </div>

      </Drawer>

      {/* Referral campaigns: fund a prize pool, pay it out to the referral
          leaderboard once closed. Referrals stopped minting G$ on signup
          (2026-08-25); this is now the only way a referral ever pays. */}
      <Drawer open={showReferralCampaigns} onClose={() => setShowReferralCampaigns(false)} kicker="Season ops" title="Referral campaigns" sub="Fund a prize pool and pay the referral leaderboard.">
          {referralCampaigns.length === 0 ? (
            <p className="text-slate-600 text-xs">No referral campaigns yet.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {referralCampaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedReferralCampaign(c.id)}
                  className={selectedReferralCampaign === c.id ? PILL_ON : PILL}
                >
                  {c.name}{c.payout_status === 'paid' ? ' · paid' : ''}
                </button>
              ))}
            </div>
          )}

          {selectedReferralCampaign && (() => {
            const c = referralCampaigns.find((x) => x.id === selectedReferralCampaign)
            if (!c) return null
            const now = Date.now()
            const closesAt = new Date(c.ends_at).getTime()
            const live = new Date(c.starts_at).getTime() <= now && closesAt >= now
            return (
              <div className={`${SUBPANEL} flex flex-col gap-2`}>
                <p className="text-xs text-slate-400">
                  <span className="text-white font-bold">{c.name}</span>
                  {' · '}
                  {live ? <span className="text-emerald-400">LIVE now</span> : <span className="text-slate-500">closed</span>}
                  {' · closes '}{new Date(c.ends_at).toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <label className="flex flex-col gap-1 flex-1">
                    <span className={LABEL}>Prize pool (G$)</span>
                    <input type="number" min={0} step={1000} value={referralFundAmount}
                      onChange={(e) => setReferralFundAmount(Math.max(0, Number(e.target.value) || 0))}
                      className={INPUT} />
                  </label>
                  <button
                    onClick={handleFundReferralCampaign}
                    disabled={referralFunding || referralFundAmount === c.prize_pool_g}
                    className={`${BTN_GOLD} self-end`}
                  >
                    {referralFunding ? 'Setting…' : 'Set pool'}
                  </button>
                </div>
              </div>
            )
          })()}

          {/* Same confirm-before-you-pay shape as the season payout: exact winners,
              exact amounts, and whether the pool + gas can actually cover it. */}
          {referralPreview && referralPreview.winner_count > 0 && (
            <div className="p-3.5 rounded-xl border border-amber-500/35 bg-amber-500/[0.04]">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-amber-400">Campaign payout</p>
                {referralPreview.campaign.payout_status === 'paid' && (
                  <Badge tone="green">Paid</Badge>
                )}
              </div>

              <div className="max-h-56 overflow-y-auto rounded-lg mb-2" style={{ background: 'rgba(0,0,0,0.3)' }}>
                {referralPreview.winners.map((w) => (
                  <div key={w.wallet_address} className="flex items-center gap-2 px-2.5 py-1.5 text-xs border-b last:border-0" style={{ borderColor: 'rgba(42,42,58,0.5)' }}>
                    <span className="w-5 text-slate-500 font-bold tabular-nums">{w.rank}</span>
                    <span className="flex-1 truncate text-slate-200">
                      {w.username || `${w.wallet_address.slice(0, 6)}…${w.wallet_address.slice(-4)}`}
                    </span>
                    <span className="text-slate-500 tabular-nums">{w.referral_count} referred</span>
                    <span className="text-amber-300 font-bold tabular-nums">{w.amount_g.toLocaleString()} G$</span>
                    {w.status === 'paid'
                      ? <span className="text-emerald-400 text-[10px] font-bold w-12 text-right">PAID</span>
                      : w.status === 'failed'
                      ? <span className="text-red-400 text-[10px] font-bold w-12 text-right">FAILED</span>
                      : <span className="text-slate-600 text-[10px] w-12 text-right">—</span>}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400 mb-2">
                <span>{referralPreview.winner_count} winners</span>
                <span className="text-slate-200 font-bold">{referralPreview.unpaid_g.toLocaleString()} G$ to send</span>
                <span>{referralPreview.tx_count} transactions</span>
                {referralPreview.pool_balance_g !== null && (
                  <span className={referralPreview.funded ? 'text-emerald-400' : 'text-red-400'}>
                    pool {referralPreview.pool_balance_g.toLocaleString()} G$
                  </span>
                )}
                {referralPreview.relay_celo !== null && (
                  <span className={referralPreview.relay_celo > 0.1 ? '' : 'text-red-400'}>
                    gas {referralPreview.relay_celo.toFixed(2)} CELO
                  </span>
                )}
              </div>

              {!referralPreview.campaign.closed && (
                <p className="text-[11px] text-amber-300/90 mb-2">
                  Campaign is still running. Payout unlocks when it closes
                  {referralPreview.campaign.ends_at && ` — ${new Date(referralPreview.campaign.ends_at).toLocaleString()}`}.
                </p>
              )}
              {referralPreview.campaign.closed && !referralPreview.funded && referralPreview.unpaid_g > 0 && (
                <p className="text-[11px] text-red-400 mb-2">
                  Reward pool holds less than the prizes. Top it up before paying, or the run stops part-way.
                </p>
              )}

              <button
                onClick={handleReferralPayout}
                disabled={referralPaying || !referralPreview.can_pay}
                className={`${BTN_GOLD} w-full py-2.5`}
              >
                {referralPaying ? 'Paying… this takes a few minutes'
                  : referralPreview.unpaid_g === 0 ? 'All winners paid'
                  : !referralPreview.campaign.closed ? 'Locked until the campaign closes'
                  : `Pay ${referralPreview.winners.filter((w) => w.status !== 'paid').length} winners · ${referralPreview.unpaid_g.toLocaleString()} G$`}
              </button>
            </div>
          )}
          {referralPreview && referralPreview.winner_count === 0 && (
            <p className="text-slate-600 text-xs">No referrals recorded in this campaign&apos;s window yet.</p>
          )}

      </Drawer>

      {/* One-off grants: bounties, external challenge prizes */}
      <Drawer open={showGrants} onClose={() => setShowGrants(false)} kicker="Season ops" title="One-off grants" sub="Bounties and challenge prizes. Paid once per wallet and reason.">
          <textarea
            value={grantWallets}
            onChange={(e) => setGrantWallets(e.target.value)}
            placeholder="Wallet addresses — one per line, or comma/space separated"
            rows={4}
            className={`${INPUT} font-mono`}
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>G$ each</span>
              <input type="number" min={1} step={100} value={grantAmount}
                onChange={(e) => setGrantAmount(Math.max(0, Number(e.target.value) || 0))}
                className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Reason</span>
              <input type="text" value={grantReason} onChange={(e) => setGrantReason(e.target.value)}
                placeholder="e.g. valor-challenge-aug-2026"
                className={INPUT} />
            </label>
          </div>
          <p className="text-xs text-slate-500">
            Only wallets already registered as Valor players get paid. Re-running the same wallet + reason
            never pays twice. Each pair is capped at 10,000 G$ per call (on-chain limit).
          </p>
          <button
            onClick={handleGrantRewards}
            disabled={granting || !grantWallets.trim() || !grantReason.trim() || grantAmount <= 0}
            className={`${BTN_GOLD} self-start`}
          >
            {granting ? 'Paying…' : 'Pay wallets'}
          </button>
          {grantResults && (
            <div className="flex flex-col gap-1 pt-3 border-t border-valor-border/70 text-xs">
              {grantResults.map((r) => (
                <div key={r.wallet_address} className="flex items-center justify-between gap-2 font-mono">
                  <span className="text-slate-400 truncate">{r.wallet_address}</span>
                  <span className={
                    r.status === 'paid' || r.status === 'already_paid' ? 'text-emerald-400'
                    : r.status === 'not_a_player' || r.status === 'invalid_address' ? 'text-amber-400'
                    : 'text-red-400'
                  }>
                    {r.status === 'paid' ? 'paid' : r.status === 'already_paid' ? 'already paid'
                      : r.status === 'not_a_player' ? 'not a player — skipped'
                      : r.status === 'invalid_address' ? 'bad address — skipped'
                      : `failed${r.error ? `: ${r.error}` : ''}`}
                  </span>
                </div>
              ))}
            </div>
          )}

      </Drawer>

      {/* Stuck Face-Off duel recovery */}
      <Drawer open={showVoidDuel} onClose={() => setShowVoidDuel(false)} kicker="Recovery" title="Void a stuck duel" sub="Refund both stakes of a Face-Off duel stuck at accepted.">
          <p className="text-xs text-slate-500">
            For a Face-Off duel stuck at &quot;accepted&quot; with no live match and no resolution — e.g. a
            player who disconnected and never reconnected before this existed, or the arena crashed mid-match.
            Refunds both stakes in full and marks the duel resolved. Only works on an accepted, unresolved duel.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={voidDuelId}
              onChange={(e) => setVoidDuelId(e.target.value)}
              placeholder="Duel ID (UUID)"
              className={`${INPUT} flex-1 font-mono`}
            />
            <button
              onClick={handleVoidDuel}
              disabled={voiding || !voidDuelId.trim()}
              className={`${BTN_GOLD} shrink-0`}
            >
              {voiding ? 'Voiding…' : 'Void & refund'}
            </button>
          </div>
          {voidResult && (
            <p className={`text-xs font-medium ${voidResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {voidResult.message}
            </p>
          )}

      </Drawer>
    </div>
  )
}
