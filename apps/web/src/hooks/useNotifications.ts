'use client'

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getPlayerSession, signInPlayer } from '@/lib/playerAuth'
import { useActiveWalletClient } from '@/hooks/useActiveWalletClient'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

export type NotificationKind =
  | 'message' | 'friend' | 'duel' | 'money' | 'transaction' | 'claim' | 'campaign' | 'drop' | string

export interface NotificationItem {
  id: string
  kind: NotificationKind
  title: string
  body: string
  url: string | null
  created_at: string
  unread: boolean
}

interface Feed { items: NotificationItem[]; unread: number }

export const notificationsKey = (wallet: string | undefined) => ['notifications', wallet?.toLowerCase() ?? 'anon']

/** The player's session token, if they already have one — never signs in. A
 *  bell that polls must not pop a wallet signature prompt on its own; it waits
 *  until the player signs in through something they chose to do. */
function sessionToken(wallet: string): string | null {
  const s = getPlayerSession()
  return s && s.wallet === wallet.toLowerCase() ? s.token : null
}

/**
 * The notification bell's feed (apps/api/src/handlers/notifications.rs).
 * Polled every 30s as a fallback; the chat socket invalidates it the moment a
 * notification or message arrives for an online player (see useChatSocket).
 */
export function useNotifications(wallet: string | undefined) {
  const queryClient = useQueryClient()
  const walletClient = useActiveWalletClient()
  const key = notificationsKey(wallet)

  const feed = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Feed> => {
      const token = wallet ? sessionToken(wallet) : null
      if (!wallet || !token) return { items: [], unread: 0 }
      const res = await fetch(`${API}/players/${wallet}/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not load notifications')
      return res.json()
    },
    enabled: !!wallet,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  /** Opening the bell reads everything: clear the badge at once, then tell the server. */
  const markSeen = useCallback(async () => {
    if (!wallet) return
    const token = sessionToken(wallet)
    if (!token) return
    queryClient.setQueryData<Feed>(key, (old) => old && ({
      unread: 0, items: old.items.map((i) => ({ ...i, unread: false })),
    }))
    await fetch(`${API}/players/${wallet}/notifications/seen`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, queryClient])

  /** Only from a tap on "Sign in" in the panel — the one place the bell may ask for a signature. */
  const signIn = useCallback(async () => {
    if (!wallet) return
    // A real tap — sign straight from it (a wallet in another app needs that).
    await signInPlayer(wallet, walletClient).catch(() => null)
    void queryClient.invalidateQueries({ queryKey: key })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, walletClient, queryClient])

  return {
    signIn,
    items: feed.data?.items ?? [],
    unread: feed.data?.unread ?? 0,
    loading: feed.isLoading,
    error: feed.isError,
    signedIn: !!(wallet && sessionToken(wallet)),
    markSeen,
  }
}
