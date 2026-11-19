'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// One nav for every admin screen, so moving between season ops, analytics and groups
// no longer means hunting for a button on the previous page. Deliberately NOT sticky:
// the site navbar above it changes height (PWA safe-area padding) and is absent when
// signed out, so a fixed sticky offset would sit on top of the page content.
const TABS = [
  { href: '/admin', label: 'Season ops', match: (p: string) => p === '/admin' },
  { href: '/admin/analytics', label: 'Analytics', match: (p: string) => p.startsWith('/admin/analytics') },
  { href: '/admin/groups', label: 'Groups', match: (p: string) => p.startsWith('/admin/groups') },
  { href: '/admin/ambassadors', label: 'Ambassadors', match: (p: string) => p.startsWith('/admin/ambassadors') },
]

export default function AdminNav() {
  const path = usePathname() ?? ''
  return (
    <div className="mb-6 border-b border-valor-border/70">
      <div className="flex items-center gap-3 h-12">
        <span className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-500/40 bg-amber-500/10">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(234,179,8,0.9)]" />
          <span className="text-[9px] font-black tracking-[0.3em] text-amber-300">ADMIN</span>
        </span>

        <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Admin sections">
          {TABS.map((t) => {
            const on = t.match(path)
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={on ? 'page' : undefined}
                className={`relative px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
                  on ? 'text-amber-300 bg-amber-500/10' : 'text-slate-400 hover:text-white hover:bg-white/4'
                }`}
              >
                {t.label}
                {on && <span className="absolute left-3 right-3 -bottom-[7px] h-0.5 rounded-full bg-linear-to-r from-transparent via-amber-400 to-transparent" />}
              </Link>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
