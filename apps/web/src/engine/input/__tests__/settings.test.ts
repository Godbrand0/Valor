import { describe, it, expect, beforeEach } from 'vitest';
import { AIM_DEFAULTS, SENS_MAX, SENS_MIN, loadAimSettings, sanitizeAimSettings, saveAimSettings } from '../aimSettings';
import {
  CONTROL_DEFS, SCALE_MAX, SCALE_MIN, OPACITY_MIN, controlStyle, defaultPlacement, loadControlLayout,
  sanitizeLayout, saveControlLayout,
} from '../controlLayout';

// The jsdom build this suite runs under does not always expose window.localStorage
// (newer Node ships its own, which shadows it), so give each test a clean in-memory one.
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    },
  });
});

describe('aim settings', () => {
  it('defaults leave the shipped feel unchanged', () => {
    expect(loadAimSettings()).toEqual(AIM_DEFAULTS);
    expect(AIM_DEFAULTS).toMatchObject({ look: 1, ads: 1, firing: 1, invertY: false, smoothing: 'balanced' });
  });

  it('carries over the old single sensitivity slider', () => {
    window.localStorage.setItem('valor_look_sens', '1.7');
    expect(loadAimSettings().look).toBe(1.7);
  });

  it('round-trips through storage', () => {
    const s = { look: 2, ads: 0.6, firing: 0.8, invertY: true, smoothing: 'responsive' as const };
    saveAimSettings(s);
    expect(loadAimSettings()).toEqual(s);
  });

  it('clamps hand-edited or corrupt values into a playable range', () => {
    expect(sanitizeAimSettings({ look: 99, ads: -3, firing: 'x', smoothing: 'warp' })).toEqual({
      look: SENS_MAX, ads: AIM_DEFAULTS.ads, firing: AIM_DEFAULTS.firing, invertY: false, smoothing: 'balanced',
    });
    expect(sanitizeAimSettings({ look: 0.001 }).look).toBe(SENS_MIN);
    window.localStorage.setItem('valor_aim_settings', '{not json');
    expect(loadAimSettings()).toEqual(AIM_DEFAULTS);
  });
});

describe('control layout', () => {
  it('an untouched layout renders the stock edge-anchored positions', () => {
    const l = loadControlLayout();
    expect(l.placements).toEqual({});
    expect(controlStyle('fire', l)).toMatchObject({ right: 20, bottom: 24, width: 78, height: 78, opacity: 1 });
    expect(controlStyle('move', l)).toMatchObject({ left: 24, bottom: 24, width: 116 });
  });

  it('a moved control is centred on its stored fraction at its scaled size', () => {
    const l = sanitizeLayout({ opacity: 0.6, placements: { fire: { x: 0.5, y: 0.25, scale: 1.5 } } });
    const st = controlStyle('fire', l);
    expect(st.width).toBe(117);
    expect(st.left).toBe('calc(50.000% - 58.5px)');
    expect(st.top).toBe('calc(25.000% - 58.5px)');
    expect(st.opacity).toBe(0.6);
  });

  it('default placement maps back to the same centre as the anchored style', () => {
    const p = defaultPlacement('fire', 800, 400);
    const d = CONTROL_DEFS.fire;
    expect(p.x * 800).toBeCloseTo(800 - d.edge - d.size / 2);
    expect(p.y * 400).toBeCloseTo(400 - d.bottom - d.size / 2);
  });

  it('clamps and drops bad stored data', () => {
    const l = sanitizeLayout({ opacity: 0, placements: { fire: { x: 3, y: -1, scale: 9 }, ads: { x: 'a' }, bogus: { x: 0.5, y: 0.5 } } });
    expect(l.opacity).toBe(OPACITY_MIN);
    expect(l.placements.fire).toEqual({ x: 1, y: 0, scale: SCALE_MAX });
    expect(l.placements.ads).toBeUndefined();
    expect(Object.keys(l.placements)).toEqual(['fire']);
    expect(sanitizeLayout({ placements: { swap: { x: 0.5, y: 0.5, scale: 0.1 } } }).placements.swap?.scale).toBe(SCALE_MIN);
  });

  it('round-trips through storage', () => {
    const l = { opacity: 0.8, placements: { reload: { x: 0.9, y: 0.4, scale: 1.2 } } };
    saveControlLayout(l);
    expect(loadControlLayout()).toEqual(l);
  });
});
