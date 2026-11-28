/** Player-tunable sound settings, persisted per device (mirrors engine/input/aimSettings.ts). */

export interface SoundSettings {
  muted: boolean;
}

export const SOUND_DEFAULTS: SoundSettings = { muted: false };

const KEY = 'valor_sound_settings';

/** Clamp a partial/untrusted object into a valid SoundSettings. Exported for tests. */
export function sanitizeSoundSettings(raw: unknown): SoundSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { muted: o.muted === true };
}

export function loadSoundSettings(): SoundSettings {
  if (typeof window === 'undefined') return { ...SOUND_DEFAULTS };
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) return sanitizeSoundSettings(JSON.parse(stored));
  } catch { /* private mode or corrupt JSON: fall through to defaults */ }
  return { ...SOUND_DEFAULTS };
}

export function saveSoundSettings(s: SoundSettings): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
