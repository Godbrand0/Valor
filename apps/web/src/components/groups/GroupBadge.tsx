'use client'

import Link from 'next/link'

/**
 * A player's group, shown next to their name wherever they appear: profile, player
 * card, season board, War Board.
 *
 * Every group gets its own colour, derived from its slug, so two groups on the same
 * board are told apart at a glance and a group's colour is the same on every page
 * without anyone having to pick or store one. The crest carries the group's initials
 * because a long university name gets truncated on a phone and the initials survive.
 *
 * Links to the group page unless `link` is false, which a caller must pass when the
 * badge sits inside another link (a War Board row is one), since a link inside a
 * link is invalid HTML and the inner one never receives the tap.
 */
export function groupHue(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return h % 360
}

export function groupInitials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  // One word: an acronym (LAUTECH, OOU) keeps its first three letters, a plain word
  // (Ballers) its first two, so the crest reads like the name people actually say.
  if (words.length === 1) {
    const w = words[0]
    return (w === w.toUpperCase() ? w.slice(0, 3) : w.slice(0, 2)).toUpperCase()
  }
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase()
}

export function GroupCrest({ slug, name, size = 18 }: { slug: string; name: string; size?: number }) {
  const hue = groupHue(slug)
  const initials = groupInitials(name)
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 20 23" aria-hidden className="shrink-0">
      <path d="M10 1 L19 4.5 V11 C19 16.5 15 20.2 10 22 C5 20.2 1 16.5 1 11 V4.5 Z"
            fill={`hsl(${hue} 70% 14%)`} stroke={`hsl(${hue} 80% 58%)`} strokeWidth="1.4" />
      <text x="10" y="14.2" textAnchor="middle" fontSize={initials.length > 2 ? 6 : 7.5}
            fontWeight="900" fill={`hsl(${hue} 85% 72%)`} fontFamily="system-ui, sans-serif">
        {initials}
      </text>
    </svg>
  )
}

export default function GroupBadge({
  slug,
  name,
  size = 'sm',
  link = true,
}: {
  slug: string
  name: string
  size?: 'xs' | 'sm' | 'md'
  link?: boolean
}) {
  const hue = groupHue(slug)
  const crest = size === 'md' ? 18 : size === 'sm' ? 13 : 11
  const text = size === 'md' ? 'text-[11px]' : size === 'sm' ? 'text-[9px]' : 'text-[8px]'
  const pad = size === 'md' ? 'pl-1.5 pr-2.5 py-1' : 'pl-1 pr-1.5 py-0.5'
  const className = `inline-flex max-w-full items-center gap-1 rounded-md ${pad} align-middle`
  const style = {
    background: `hsl(${hue} 70% 50% / 0.1)`,
    boxShadow: `inset 0 0 0 1px hsl(${hue} 80% 58% / 0.35)`,
  }
  const body = (
    <>
      <GroupCrest slug={slug} name={name} size={crest} />
      <span className={`${text} truncate font-black uppercase tracking-[0.14em]`} style={{ color: `hsl(${hue} 85% 72%)` }}>
        {name}
      </span>
    </>
  )
  if (!link) return <span className={className} style={style} title={name}>{body}</span>
  return (
    <Link href={`/groups/${slug}`} className={`${className} transition-opacity hover:opacity-80`} style={style} title={`${name} group page`}>
      {body}
    </Link>
  )
}
