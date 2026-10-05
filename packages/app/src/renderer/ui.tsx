// Shared chrome components (.claude/skills/takeoff-design/references/components.md).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import type { ErrorInfo } from '@takeoff/contracts';
import { announceDelay } from './logic.ts';

/** Square switch: role="switch", aria-checked, and the state as a word, never colour alone. */
export function Switch(p: { checked: boolean; onChange(v: boolean): void; labelledBy: string; describedBy?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={p.checked}
      aria-labelledby={p.labelledBy}
      aria-describedby={p.describedBy}
      disabled={p.disabled}
      onClick={() => p.onChange(!p.checked)}
    >
      <span className="switch__knob" aria-hidden="true" />
      <span className="switch__word">{p.checked ? 'On' : 'Off'}</span>
    </button>
  );
}

export function ErrorNote({ error }: { error: ErrorInfo | null }) {
  if (!error) return null;
  return (
    <p className="note note--error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      <span>
        <strong>Error:</strong> {error.message}. {error.remedy}
      </span>
    </p>
  );
}

export const Label = ({ children, id, active }: { children: ReactNode; id?: string; active?: boolean }) => (
  <span id={id} className={active ? 'label label--active' : 'label'}>
    {children}
  </span>
);

/** Per-viewer conveniences only (ground, last project, first-run done). Never project state. */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`takeoff.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(`takeoff.${key}`, JSON.stringify(next));
    } catch {
      // storage unavailable: the preference lasts for this session only
    }
  };
  return [v, set];
}

/** A polite live region that speaks at most once per 5 s (PRD 5.6); the latest message wins. */
export function useAnnouncer(): [string, (msg: string) => void] {
  const [said, setSaid] = useState('');
  const last = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const announce = (msg: string) => {
    pending.current = msg;
    if (timer.current) return;
    const flush = () => {
      timer.current = null;
      if (pending.current === null) return;
      setSaid(pending.current);
      pending.current = null;
      last.current = Date.now();
    };
    const wait = announceDelay(last.current, Date.now());
    if (wait === 0) flush();
    else timer.current = setTimeout(flush, wait);
  };
  return [said, announce];
}

export const fmtSeconds = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
