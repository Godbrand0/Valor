'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Navigate away as a render result: `if (!player) return <Redirect to="/" />`.
 *
 * Pages used to call `router.replace()` straight from their render body. That is a
 * state update on the router (`LinkComponent`) during another component's render,
 * which React flags ("Cannot update a component while rendering a different
 * component") and can double-fire under Strict Mode. Doing it in an effect runs it
 * once, after commit.
 */
export default function Redirect({ to }: { to: string }) {
  const router = useRouter()
  useEffect(() => { router.replace(to) }, [router, to])
  return null
}
