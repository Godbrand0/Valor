// The public analytics dashboard, served from Valor's own domain.
//
// The dashboard is built and refreshed hourly in the Analytics repo
// (github.com/MarvyNwaokobia/Analytics, folder docs/) and published to GitHub
// Pages, but several Nigerian networks block GitHub Pages outright, so it only
// opened behind a VPN. GitHub's raw file host is not blocked, and playvalor.app
// is reachable wherever the game is, so this route fetches the same files from
// raw and serves them here. Nothing is copied into this repo: a refresh in the
// Analytics repo shows up here within the cache window below.

const SOURCE = 'https://raw.githubusercontent.com/MarvyNwaokobia/Analytics/main/docs/'
const BASE = '/stats/'
const CACHE_SECONDS = 300

// Always run on request. Left to Next's defaults, this handler was turned into a
// static page whose fetch cache never refreshed: it kept serving the 23 Nov 10:10
// feed long after the hourly refresh had published newer ones. Freshness is now
// owned by one layer only, the CDN, through the Cache-Control header below.
export const dynamic = 'force-dynamic'

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
}

// Only files the dashboard actually loads. Anything else in the repo stays private
// to it, and no path can climb out of docs/.
const ALLOWED = /^(index\.html|valor\.json|assets\/[a-zA-Z0-9._-]+\.(png|webp|jpg|svg))$/

export async function GET(_req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await ctx.params
  const file = path.length ? path.join('/') : 'index.html'
  if (!ALLOWED.test(file)) return new Response('Not found', { status: 404 })

  const upstream = await fetch(SOURCE + file, { cache: 'no-store' })
  if (!upstream.ok) return new Response('Dashboard unavailable', { status: 502 })

  const ext = file.split('.').pop() ?? ''
  const headers = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 6}`,
  }

  if (ext !== 'html') return new Response(upstream.body, { headers })

  // The page loads its feed and images by relative path, which would resolve to the
  // site root here (/stats has no trailing slash). Point them at this route instead.
  // A <base> tag would also do it, but it breaks the page's in-page #section links.
  const html = (await upstream.text())
    .replaceAll("fetch('valor.json", `fetch('${BASE}valor.json`)
    .replaceAll('"assets/', `"${BASE}assets/`)
    .replaceAll('url(assets/', `url(${BASE}assets/`)
  return new Response(html, { headers })
}
