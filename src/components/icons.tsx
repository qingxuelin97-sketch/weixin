/**
 * Hand-drawn WeChat-style icons as inline SVG (no PNG, no icon font — per the
 * design constitution). currentColor drives fill/stroke so tokens theme them.
 * These are calibrated approximations; refine against real-device screenshots.
 */
interface IconProps {
  size?: number;
  active?: boolean;
}

/** Tab 1: 微信 — speech bubble (WeChat's is a filled rounded bubble with a tail dot). */
export function IconChats({ size = 27, active }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      {active ? (
        <path
          d="M14 4.5c-6 0-10.5 4-10.5 9 0 2.7 1.6 5.1 4.1 6.7L6.8 23l3.6-1.7c1.1.3 2.3.5 3.6.5 6 0 10.5-4 10.5-9s-4.5-9.3-10.5-9.3z"
          fill="currentColor"
        />
      ) : (
        <path
          d="M14 5.2c-5.6 0-10 3.8-10 8.3 0 2.6 1.5 4.9 3.9 6.4l-.9 2.6 3.2-1.6c1.2.4 2.5.6 3.8.6 5.6 0 10-3.8 10-8.4S19.6 5.2 14 5.2z"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
        />
      )}
    </svg>
  );
}

/** Tab 2: 通讯录 — two-person contacts glyph. */
export function IconContacts({ size = 27, active }: IconProps) {
  const s = active ? 'currentColor' : 'none';
  const st = active ? 'none' : 'currentColor';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="11" cy="10" r="4" fill={s} stroke={st} strokeWidth="1.6" />
      <path
        d="M4 22c0-4 3.1-6.5 7-6.5s7 2.5 7 6.5"
        fill={s}
        stroke={st}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M18 8.5c2.4.2 4 2 4 4.2 0 1.5-.8 2.8-2 3.5 2.6.7 4 2.9 4 5.8"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Tab 3: 发现 — compass / discover. */
export function IconDiscover({ size = 27, active }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="14" r="10" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path
        d="M18.5 9.5 12.8 12l-3.3 6.5 5.7-2.5 3.3-6.5z"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="14" r="1.4" fill={active ? 'var(--color-tabbar-bg)' : 'currentColor'} />
    </svg>
  );
}

/** Tab 4: 我 — single person in a rounded frame. */
export function IconMe({ size = 27, active }: IconProps) {
  const s = active ? 'currentColor' : 'none';
  const st = active ? 'none' : 'currentColor';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="10.5" r="4.2" fill={s} stroke={st} strokeWidth="1.6" />
      <path
        d="M5.5 23c0-4.5 3.8-7.5 8.5-7.5s8.5 3 8.5 7.5"
        fill={s}
        stroke={st}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Nav "+" menu icon (add / more). Outline plus-in-rounded-square. */
export function IconPlus({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Nav search icon. */
export function IconSearch({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Back chevron. */
export function IconBack({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Chat header "…" more. */
export function IconMore({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Voice/keyboard toggle in the input bar. */
export function IconVoice({ size = 26 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <rect x="10.5" y="5" width="7" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 13a7 7 0 0 0 14 0M14 20v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Emoji face toggle. */
export function IconEmoji({ size = 26 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="14" r="9.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="17.5" cy="12" r="1.2" fill="currentColor" />
      <path d="M10 16.5c1 1.3 2.4 2 4 2s3-.7 4-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
