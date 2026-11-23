/**
 * Player-tunable aim settings, persisted per device.
 *
 * One multiplier was not enough: a phone player wants a fast camera for turning but a
 * slow one while scoped, and the fire pad (which doubles as an aim pad) wants its own
 * number because the thumb on it is also fighting recoil. These mirror the split that
 * mobile shooters players come from already use (camera / ADS / firing), so the numbers
 * they have muscle memory for map onto something here.
 *
 * Every multiplier is RELATIVE to the tuned defaults in the scene (1 = unchanged), so a
 * player who never opens the panel gets exactly the feel the game shipped with.
 */

export type AimSmoothing = 'responsive' | 'balanced' | 'smooth';

export interface AimSettings {
  /** Camera speed for touch drag and mouse. */
  look: number;
  /** Extra multiplier while aiming down sights, on top of the built-in ADS slowdown. */
  ads: number;
  /** Multiplier for drags that start on the fire pad (touch only). */
  firing: number;
  invertY: boolean;
  /** How much touch drag is eased out. Mouse is always raw. */
  smoothing: AimSmoothing;
}

export const SENS_MIN = 0.1;
export const SENS_MAX = 4;

export const AIM_DEFAULTS: AimSettings = {
  look: 1,
  ads: 1,
  firing: 1,
  invertY: false,
  smoothing: 'balanced',
};

/** Touch-drag drain rate per second for each smoothing level (see LOOK_SMOOTH_RATE). */
export const SMOOTH_RATE: Record<AimSmoothing, number> = {
  responsive: 34,
  balanced: 19,
  smooth: 11,
};

const KEY = 'valor_aim_settings';
/** The single slider this panel replaced. Read once so nobody loses their number. */
const LEGACY_KEY = 'valor_look_sens';

const clampSens = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(SENS_MIN, Math.min(SENS_MAX, n));
};

/** Clamp a partial/untrusted object into a valid AimSettings. Exported for tests. */
export function sanitizeAimSettings(raw: unknown): AimSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const smoothing = o.smoothing === 'responsive' || o.smoothing === 'smooth' ? o.smoothing : 'balanced';
  return {
    look: clampSens(o.look, AIM_DEFAULTS.look),
    ads: clampSens(o.ads, AIM_DEFAULTS.ads),
    firing: clampSens(o.firing, AIM_DEFAULTS.firing),
    invertY: o.invertY === true,
    smoothing,
  };
}

export function loadAimSettings(): AimSettings {
  if (typeof window === 'undefined') return { ...AIM_DEFAULTS };
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) return sanitizeAimSettings(JSON.parse(stored));
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) return sanitizeAimSettings({ look: legacy });
  } catch { /* private mode or corrupt JSON: fall through to defaults */ }
  return { ...AIM_DEFAULTS };
}

export function saveAimSettings(s: AimSettings): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
