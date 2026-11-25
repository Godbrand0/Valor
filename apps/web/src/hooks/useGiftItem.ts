'use client'

import { useState } from 'react'
import { useConfig } from 'wagmi'
import { readContract } from '@wagmi/core'
import { parseUnits, parseSignature } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import type { Item } from '@/types'
import { useActiveWalletClient } from '@/hooks/useActiveWalletClient'
import { chainSpendConfig } from '@/editions/chain'
import { edition } from '@/editions'
import { authedFetch } from '@/lib/playerAuth'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

const NONCES_ABI = [
  { name: 'nonces', type: 'function', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const
const BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const
const GIFT_NONCES_ABI = [
  { name: 'giftNonces', type: 'function', inputs: [{ name: 'payer', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const

export interface GiftRecipient { wallet: string; name: string }

/**
 * Buy a Market item for another player (apps/api/src/handlers/gifts.rs).
 *
 * On-chain items take TWO signatures, neither costing gas:
 *   1. the same G$ permit as a purchase — who pays, and how much;
 *   2. an EIP-712 `Gift` naming the recipient, item, nonce and deadline — the
 *      marketplace checks it, so the relay that submits the gift can't send it
 *      to anyone else.
 * Off-chain items move no G$ (as when buying one): the player's session vouches.
 */
export function useGiftItem(walletAddress: string | undefined) {
  const config = useConfig()
  const walletClient = useActiveWalletClient()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)

  const gift = async (item: Item, to: GiftRecipient, message: string): Promise<void> => {
    if (!walletAddress) throw new Error('Not signed in')
    if (to.wallet.toLowerCase() === walletAddress.toLowerCase()) throw new Error("You can't gift an item to yourself")
    setPending(true)
    try {
      const base = { wallet_address: walletAddress, recipient: to.wallet, message }
      let res: Response

      if (item.on_chain_id === null) {
        res = await authedFetch(`/items/${item.id}/gift`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base),
        }, walletAddress, walletClient)
      } else {
        if (!walletClient?.account) throw new Error('Wallet not connected')
        const chainId = edition().chain.id
        const spend = chainSpendConfig(chainId)
        if (!spend) throw new Error('That currency is not available right now')
        const owner = walletAddress as `0x${string}`
        const amount = parseUnits(item.price_g.toString(), spend.decimals)
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30)

        const balance = await readContract(config, { address: spend.currency, abi: BALANCE_ABI, functionName: 'balanceOf', args: [owner] })
        if (balance < amount) throw new Error(`Insufficient ${spend.symbol} balance`)

        // Only exists once the marketplace has the gifting upgrade.
        let giftNonce: bigint
        try {
          giftNonce = await readContract(config, { address: spend.marketplace, abi: GIFT_NONCES_ABI, functionName: 'giftNonces', args: [owner] })
        } catch {
          throw new Error("Gifting this item isn't live yet — nothing was charged.")
        }
        const permitNonce = await readContract(config, { address: spend.currency, abi: NONCES_ABI, functionName: 'nonces', args: [owner] })

        const permitSig = await walletClient.signTypedData({
          account: walletClient.account,
          domain: spend.permit,
          types: {
            Permit: [
              { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
              { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
            ],
          },
          primaryType: 'Permit',
          message: { owner, spender: spend.marketplace, value: amount, nonce: permitNonce, deadline },
        })
        const giftSig = await walletClient.signTypedData({
          account: walletClient.account,
          domain: { name: 'ValorMarketplace', version: '1', chainId, verifyingContract: spend.marketplace },
          types: {
            Gift: [
              { name: 'payer', type: 'address' }, { name: 'recipient', type: 'address' },
              { name: 'itemId', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
            ],
          },
          primaryType: 'Gift',
          message: { payer: owner, recipient: to.wallet as `0x${string}`, itemId: BigInt(item.on_chain_id), nonce: giftNonce, deadline },
        })
        const { v, r, s } = parseSignature(permitSig)
        res = await fetch(`${API}/items/${item.id}/gift`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...base, deadline: Number(deadline), v: Number(v), r, s, gift_sig: giftSig }),
        })
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'The gift could not be sent')
      }
      queryClient.invalidateQueries({ queryKey: ['marketplace-items'] })
    } finally {
      setPending(false)
    }
  }

  return { gift, pending }
}
