'use client'

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { WalletClient } from 'viem'
import { useActiveWalletClient } from '@/hooks/useActiveWalletClient'
import { authedFetch } from '@/lib/playerAuth'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

export interface FriendEntry {
  wallet: string
  username: string | null
  character_name: string
  rank: string
}

export interface FriendRequestEntry extends FriendEntry {
  created_at: string
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error('Request failed')
  return res.json()
}

// Gated player-mutation routes — signed player session required (see
// verify_player_token in apps/api/src/auth.rs).
async function post<T>(path: string, wallet: string, walletClient: WalletClient | undefined, body?: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, wallet, walletClient)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? 'Request failed')
  return json as T
}

async function del(path: string, wallet: string, walletClient: WalletClient | undefined): Promise<void> {
  const res = await authedFetch(path, { method: 'DELETE' }, wallet, walletClient)
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new Error((json as { error?: string }).error ?? 'Request failed')
  }
}

/**
 * Friends — separate from referrals on purpose. A referral pays out once for
 * bringing in a new player; it says nothing about who anyone wants to stay
 * connected to, so nothing here is auto-populated from it.
 */
export function useFriends(walletAddress: string | undefined) {
  const queryClient = useQueryClient()
  const walletClient = useActiveWalletClient()
  const key = walletAddress?.toLowerCase() ?? 'anon'

  const friends = useQuery({
    queryKey: ['friends', key],
    queryFn: () => get<{ friends: FriendEntry[] }>(`/players/${walletAddress}/friends`),
    enabled: !!walletAddress,
    staleTime: 15_000,
    // A request can be accepted on the OTHER player's device while this page is
    // open; without polling the lobby kept offering "Add" to an existing friend.
    // (The chat socket also refreshes this on a notification ping.)
    refetchInterval: 30_000,
  })

  const requests = useQuery({
    queryKey: ['friend-requests', key],
    queryFn: () => get<{ incoming: FriendRequestEntry[]; outgoing: FriendRequestEntry[] }>(
      `/players/${walletAddress}/friends/requests`,
    ),
    enabled: !!walletAddress,
    staleTime: 15_000,
    // Poll gently so an incoming request shows up without a manual refresh.
    refetchInterval: 30_000,
  })

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['friends', key] })
    void queryClient.invalidateQueries({ queryKey: ['friend-requests', key] })
  }, [queryClient, key])

  /** `identifier` is either a wallet address or a username — the caller decides
   *  which by what they typed; the server tells them apart automatically. */
  /** `already: true` = nothing to do: you're already friends ('accepted') or
   *  your request is already pending ('pending'). Not an error — the list was
   *  just out of date, and it's refreshed either way. */
  const sendRequest = useCallback(async (identifier: string): Promise<{ status: string; auto_accepted?: boolean; already?: boolean }> => {
    if (!walletAddress) throw new Error('Not signed in')
    try {
      return await post<{ status: string; auto_accepted?: boolean }>(
        `/players/${walletAddress}/friends/request`,
        walletAddress, walletClient,
        { identifier },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg === 'Already friends') return { status: 'accepted', already: true }
      if (msg === 'Request already sent') return { status: 'pending', already: true }
      throw e
    } finally {
      refresh()
    }
  }, [walletAddress, walletClient, refresh])

  const acceptRequest = useCallback(async (fromWallet: string) => {
    if (!walletAddress) throw new Error('Not signed in')
    await post(`/players/${walletAddress}/friends/${fromWallet}/accept`, walletAddress, walletClient)
    refresh()
  }, [walletAddress, walletClient, refresh])

  /** Declining an incoming request, cancelling an outgoing one, and unfriending
   *  an accepted one are all the same call — see remove_friend on the API. */
  const removeFriend = useCallback(async (otherWallet: string) => {
    if (!walletAddress) throw new Error('Not signed in')
    await del(`/players/${walletAddress}/friends/${otherWallet}`, walletAddress, walletClient)
    refresh()
  }, [walletAddress, walletClient, refresh])

  return {
    friends: friends.data?.friends ?? [],
    incoming: requests.data?.incoming ?? [],
    outgoing: requests.data?.outgoing ?? [],
    loading: friends.isLoading || requests.isLoading,
    error: friends.error instanceof Error ? friends.error.message : null,
    sendRequest, acceptRequest, removeFriend, refresh,
  }
}
