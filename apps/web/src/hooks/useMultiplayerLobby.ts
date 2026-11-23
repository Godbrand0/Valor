'use client'

import { useQuery } from '@tanstack/react-query'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

export interface LobbyPerson {
  wallet: string
  username: string | null
  name: string
  class: string | null
  rank: string | null
}

export type LobbyStatus = 'online' | 'in_match' | 'in_party_lobby' | 'in_party_run'

export interface LobbyPlayer extends LobbyPerson {
  status: LobbyStatus
  /** Set while `status === 'in_match'` — the Face-Off to spectate. */
  duel_id?: string
  /** Only ever set for a PUBLIC party; private parties never expose a code. */
  party_code?: string | null
  party_joinable?: boolean
}

export interface LobbyMatch {
  duel_id: string
  elapsed_secs: number
  paused: boolean
  players: LobbyPerson[]
}

export interface LobbyParty {
  code: string
  host: LobbyPerson
  members: LobbyPerson[]
  started: boolean
  size: number
  max_size: number
  joinable: boolean
}

export interface LobbySnapshot {
  online_count: number
  players: LobbyPlayer[]
  matches: LobbyMatch[]
  parties: LobbyParty[]
}

/** Shown name for a person: username first, then character name. */
export function lobbyName(p: Pick<LobbyPerson, 'username' | 'name'>): string {
  return p.username || p.name || 'Operator'
}

/** Where a lobby JOIN click goes: straight into that party. */
export function partyJoinHref(code: string): string {
  return `/endless/coop?code=${encodeURIComponent(code)}&join=1`
}

/** Where a WATCH click goes: the existing public spectate view. */
export function watchHref(duelId: string): string {
  return `/faceoff/watch/${duelId}`
}

/**
 * Live multiplayer snapshot — who's online, live Face-Offs, open co-op parties
 * (see apps/api/src/handlers/multiplayer.rs). Public, no auth. Polls while the
 * page is open; react-query pauses it in a background tab.
 */
export function useMultiplayerLobby(enabled = true) {
  const q = useQuery({
    queryKey: ['multiplayer-live'],
    queryFn: async (): Promise<LobbySnapshot> => {
      const res = await fetch(`${API}/multiplayer/live`)
      if (!res.ok) throw new Error(res.status === 404 ? 'unavailable' : 'Could not load the lobby')
      return res.json()
    },
    enabled,
    refetchInterval: 8_000,
    staleTime: 4_000,
    retry: 1,
  })
  return {
    data: q.data,
    loading: q.isLoading,
    // A 404 means this API build predates the lobby endpoint (e.g. the web app
    // deployed ahead of the API) — the page shows a friendly "coming soon".
    unavailable: q.error instanceof Error && q.error.message === 'unavailable',
    error: q.error instanceof Error && q.error.message !== 'unavailable' ? q.error.message : null,
    refetch: q.refetch,
  }
}
