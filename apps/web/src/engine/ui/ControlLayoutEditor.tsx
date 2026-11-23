'use client';

import { useRef, useState } from 'react';
import {
  CONTROL_DEFS, CONTROL_IDS, DEFAULT_LAYOUT, OPACITY_MIN, SCALE_MAX, SCALE_MIN,
  controlSize, controlStyle, defaultPlacement,
  type ControlId, type ControlLayout,
} from '../input/controlLayout';

const ACCENT = '#37d0e0';

/**
 * Full-screen editor for the mobile HUD: drag a button to move it, pick it to resize
 * it, and fade the whole set. Works on a DRAFT, so CANCEL really does throw the
 * changes away, and nothing is persisted until SAVE.
 */
export function ControlLayoutEditor({ initial, onSave, onCancel, fontFamily }: {
  initial: ControlLayout;
  onSave: (layout: ControlLayout) => void;
  onCancel: () => void;
  fontFamily?: string;
}) {
  const [draft, setDraft] = useState<ControlLayout>(() => ({ opacity: initial.opacity, placements: { ...initial.placements } }));
  const [selected, setSelected] = useState<ControlId>('fire');
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: ControlId; pointer: number; dx: number; dy: number } | null>(null);

  const viewport = () => {
    const r = rootRef.current?.getBoundingClientRect();
    return { left: r?.left ?? 0, top: r?.top ?? 0, w: r?.width || window.innerWidth, h: r?.height || window.innerHeight };
  };

  /** The control's current placement, materialising the default the first time it's edited. */
  const placementOf = (layout: ControlLayout, id: ControlId) => {
    const { w, h } = viewport();
    return layout.placements[id] ?? defaultPlacement(id, w, h);
  };

  const setPlacement = (id: ControlId, patch: Partial<{ x: number; y: number; scale: number }>) => {
    setDraft((d) => {
      const cur = placementOf(d, id);
      const next = { ...cur, ...patch };
      // Keep the whole button on screen, at whatever size it now is.
      const { w, h } = viewport();
      const half = (CONTROL_DEFS[id].size * next.scale) / 2;
      next.x = Math.max(half / w, Math.min(1 - half / w, next.x));
      next.y = Math.max(half / h, Math.min(1 - half / h, next.y));
      return { ...d, placements: { ...d.placements, [id]: next } };
    });
  };

  const onDown = (id: ControlId) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    const { left, top, w, h } = viewport();
    const p = placementOf(draft, id);
    drag.current = { id, pointer: e.pointerId, dx: e.clientX - left - p.x * w, dy: e.clientY - top - p.y * h };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.pointer !== e.pointerId) return;
    const { left, top, w, h } = viewport();
    setPlacement(g.id, { x: (e.clientX - left - g.dx) / w, y: (e.clientY - top - g.dy) / h });
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };

  const selScale = draft.placements[selected]?.scale ?? 1;

  const chip: React.CSSProperties = {
    pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit',
    fontSize: 11, letterSpacing: 1.5, padding: '6px 12px', borderRadius: 6, whiteSpace: 'nowrap',
  };

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: 80, background: 'rgba(3,6,10,.72)', fontFamily, color: '#e9edf2', touchAction: 'none', userSelect: 'none', pointerEvents: 'auto', cursor: 'auto' }}>
      {/* Faint centre-line guides help line buttons up by eye. */}
      <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,.06)' }} />
      <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,.06)' }} />

      {/* Toolbar, top-centre: the area every default layout leaves empty. */}
      <div style={{ position: 'absolute', left: '50%', top: 8, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10, background: 'rgba(6,10,16,.92)', border: '1px solid rgba(255,255,255,.12)', width: 'min(94vw, 520px)', zIndex: 2 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: ACCENT }}>CUSTOMIZE BUTTONS · drag to move</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ fontSize: 10, letterSpacing: 1.5, color: '#9fb4c8', width: 92, whiteSpace: 'nowrap' }}>{CONTROL_DEFS[selected].label} SIZE</span>
          <input type="range" min={SCALE_MIN} max={SCALE_MAX} step={0.05} value={selScale}
            onChange={(e) => setPlacement(selected, { scale: Number(e.currentTarget.value) })}
            aria-label={`${CONTROL_DEFS[selected].label} size`}
            style={{ flex: 1, accentColor: ACCENT, height: 22 }} />
          <span style={{ fontSize: 11, color: ACCENT, width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(selScale * 100)}%</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ fontSize: 10, letterSpacing: 1.5, color: '#9fb4c8', width: 92 }}>OPACITY</span>
          <input type="range" min={OPACITY_MIN} max={1} step={0.05} value={draft.opacity}
            onChange={(e) => { const v = Number(e.currentTarget.value); setDraft((d) => ({ ...d, opacity: v })); }}
            aria-label="Button opacity"
            style={{ flex: 1, accentColor: ACCENT, height: 22 }} />
          <span style={{ fontSize: 11, color: ACCENT, width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(draft.opacity * 100)}%</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setDraft({ opacity: DEFAULT_LAYOUT.opacity, placements: {} })} style={{ ...chip, border: '1px solid #6f7d8c', color: '#9fb4c8' }}>RESET</button>
          <button onClick={onCancel} style={{ ...chip, border: '1px solid #e0796f', color: '#e6a29b' }}>CANCEL</button>
          <button onClick={() => onSave(draft)} style={{ ...chip, border: `1px solid ${ACCENT}`, color: ACCENT, background: 'rgba(55,208,224,.14)', fontWeight: 700 }}>SAVE</button>
        </div>
      </div>

      {CONTROL_IDS.map((id) => {
        const size = controlSize(id, draft);
        const on = id === selected;
        // Preview at the chosen opacity, but never so faint it can't be grabbed.
        const style = controlStyle(id, draft);
        return (
          <div key={id}
            onPointerDown={onDown(id)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            style={{
              ...style,
              position: 'absolute', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: Math.max(0.55, draft.opacity),
              border: `2px ${on ? 'solid' : 'dashed'} ${on ? ACCENT : 'rgba(207,224,234,.6)'}`,
              background: on ? 'rgba(55,208,224,.22)' : 'rgba(207,224,234,.10)',
              boxShadow: on ? `0 0 0 4px rgba(55,208,224,.18)` : 'none',
              color: on ? '#e9fbff' : '#cfe0ea', fontSize: size < 50 ? 8 : 10, fontWeight: 700, letterSpacing: 0.5,
              touchAction: 'none', cursor: 'grab',
            }}>
            {CONTROL_DEFS[id].label}
          </div>
        );
      })}
    </div>
  );
}
