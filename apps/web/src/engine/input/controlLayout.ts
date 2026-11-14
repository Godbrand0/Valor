import type { CSSProperties } from 'react';

/**
 * Customisable mobile HUD layout.
 *
 * Players coming from other mobile shooters arrive with their thumbs already trained
 * on a layout of their own, so every combat button can be moved, resized and faded.
 *
 * A moved button is stored as its CENTRE as a fraction of the viewport, not as pixels
 * from an edge: the same phone reports slightly different viewports with and without
 * the browser chrome, and a fraction keeps the button where the thumb expects it
 * across both. Buttons the player never touched keep their edge-anchored defaults, so
 * the stock layout renders exactly as it did before this existed.
 */

export type ControlId = 'move' | 'fire' | 'target' | 'ads' | 'crouch' | 'reload' | 'swap' | 'fireMode';

export interface ControlPlacement {
  /** Centre X as a fraction of viewport width (0..1). */
  x: number;
  /** Centre Y as a fraction of viewport height (0..1). */
  y: number;
  /** Size multiplier over the default diameter. */
  scale: number;
}

export interface ControlLayout {
  /** Opacity of every combat button (0.25..1). */
  opacity: number;
  placements: Partial<Record<ControlId, ControlPlacement>>;
}

interface ControlDef {
  label: string;
  size: number;
  side: 'left' | 'right';
  /** px from the anchored side edge to the button's near edge */
  edge: number;
  /** px from the bottom edge */
  bottom: number;
}

/** The stock layout. Matches the hard-coded positions the HUD shipped with. */
export const CONTROL_DEFS: Record<ControlId, ControlDef> = {
  move: { label: 'MOVE', size: 116, side: 'left', edge: 24, bottom: 24 },
  fire: { label: 'FIRE', size: 78, side: 'right', edge: 20, bottom: 24 },
  target: { label: 'TARGET', size: 60, side: 'right', edge: 108, bottom: 92 },
  ads: { label: 'ADS', size: 52, side: 'right', edge: 108, bottom: 30 },
  crouch: { label: 'CROUCH', size: 52, side: 'right', edge: 170, bottom: 30 },
  reload: { label: 'RELOAD', size: 44, side: 'right', edge: 22, bottom: 116 },
  swap: { label: 'SWAP', size: 44, side: 'right', edge: 22, bottom: 170 },
  fireMode: { label: 'MODE', size: 42, side: 'right', edge: 24, bottom: 222 },
};

export const CONTROL_IDS = Object.keys(CONTROL_DEFS) as ControlId[];

export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.6;
export const OPACITY_MIN = 0.25;

export const DEFAULT_LAYOUT: ControlLayout = { opacity: 1, placements: {} };

const KEY = 'valor_control_layout';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Clamp untrusted stored data into a valid layout. Exported for tests. */
export function sanitizeLayout(raw: unknown): ControlLayout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const opacity = num(o.opacity);
  const placements: ControlLayout['placements'] = {};
  const rawP = (o.placements && typeof o.placements === 'object' ? o.placements : {}) as Record<string, unknown>;
  for (const id of CONTROL_IDS) {
    const p = rawP[id] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') continue;
    const x = num(p.x), y = num(p.y), scale = num(p.scale);
    if (x === null || y === null) continue;
    placements[id] = { x: clamp(x, 0, 1), y: clamp(y, 0, 1), scale: clamp(scale ?? 1, SCALE_MIN, SCALE_MAX) };
  }
  return { opacity: opacity === null ? 1 : clamp(opacity, OPACITY_MIN, 1), placements };
}

export function loadControlLayout(): ControlLayout {
  if (typeof window === 'undefined') return { ...DEFAULT_LAYOUT, placements: {} };
  try {
    const s = window.localStorage.getItem(KEY);
    if (s) return sanitizeLayout(JSON.parse(s));
  } catch { /* private mode or corrupt JSON */ }
  return { ...DEFAULT_LAYOUT, placements: {} };
}

export function saveControlLayout(layout: ControlLayout): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* private mode */ }
}

/** Rendered diameter of a control in px. */
export function controlSize(id: ControlId, layout: ControlLayout): number {
  return Math.round(CONTROL_DEFS[id].size * (layout.placements[id]?.scale ?? 1));
}

/** Where a control's centre sits by default, as viewport fractions. */
export function defaultPlacement(id: ControlId, vw: number, vh: number): ControlPlacement {
  const d = CONTROL_DEFS[id];
  const cx = d.side === 'left' ? d.edge + d.size / 2 : vw - d.edge - d.size / 2;
  const cy = vh - d.bottom - d.size / 2;
  return { x: cx / vw, y: cy / vh, scale: 1 };
}

/** Position + size + opacity for one control, ready to spread into its style. */
export function controlStyle(id: ControlId, layout: ControlLayout): CSSProperties {
  const d = CONTROL_DEFS[id];
  const p = layout.placements[id];
  const size = controlSize(id, layout);
  const pos: CSSProperties = p
    ? { left: `calc(${(p.x * 100).toFixed(3)}% - ${size / 2}px)`, top: `calc(${(p.y * 100).toFixed(3)}% - ${size / 2}px)` }
    : d.side === 'left' ? { left: d.edge, bottom: d.bottom } : { right: d.edge, bottom: d.bottom };
  return { ...pos, width: size, height: size, opacity: layout.opacity };
}
