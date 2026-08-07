/**
 * Hand-drawn WeChat-style icons as inline SVG (no PNG, no icon font — per the
 * design constitution). currentColor drives fill/stroke so tokens theme them.
 * These are calibrated approximations; refine against real-device screenshots.
 */
interface IconProps {
  size?: number;
  active?: boolean;
}

/** Tab 1: 微信 — two overlapping round speech bubbles (device style). */
export function IconChats({ size = 27, active }: IconProps) {
  if (active) {
    return (
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
        {/* big bubble */}
        <path d="M11.5 4C6.3 4 2.5 7.4 2.5 11.6c0 2.3 1.2 4.3 3.2 5.7l-.8 2.9 3.3-1.6c1 .3 2.1.4 3.3.4 5.2 0 9-3.4 9-7.4S16.7 4 11.5 4z" fill="currentColor" />
        {/* small bubble, knocked out */}
        <path
          d="M19.6 11.2c3.4.5 5.9 2.8 5.9 5.6 0 1.7-1 3.3-2.4 4.3l.6 2.3-2.6-1.3c-.8.2-1.6.3-2.5.3-3.9 0-7-2.5-7-5.7 0-.5.1-1 .2-1.4"
          fill="currentColor"
          stroke="var(--color-tabbar-bg)"
          strokeWidth="1.4"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <path
        d="M11.5 4.6c-4.8 0-8.4 3.1-8.4 6.9 0 2.1 1.1 4 3 5.3l-.7 2.5 2.9-1.4c1 .3 2 .4 3.2.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M18.7 11.7c3.5 0 6.3 2.3 6.3 5.2 0 1.6-.9 3-2.2 4l.6 2.1-2.4-1.2c-.7.2-1.5.3-2.3.3-3.5 0-6.3-2.3-6.3-5.2s2.8-5.2 6.3-5.2z"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
    </svg>
  );
}

/** Tab 2: 通讯录 — person with contact-list lines to the right (device style). */
export function IconContacts({ size = 27, active }: IconProps) {
  const s = active ? 'currentColor' : 'none';
  const st = active ? 'none' : 'currentColor';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="11" cy="9.5" r="4.2" fill={s} stroke={st} strokeWidth="1.6" />
      <path
        d="M3.5 22.5c0-4.2 3.3-7 7.5-7s7.5 2.8 7.5 7"
        fill={s}
        stroke={st}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M20.5 8h4M21.5 12.5h3M22.5 17h2"
        stroke="currentColor"
        strokeWidth="1.7"
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

/**
 * Voice toggle in the input bar — current WeChat style: a circle containing
 * sound-wave arcs (not a microphone). Calibrated against device screenshot.
 */
export function IconVoiceCircle({ size = 30 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M13.5 12.5a5 5 0 0 1 0 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M17.5 10.5a8 8 0 0 1 0 11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="11" cy="16" r="1.2" fill="currentColor" />
    </svg>
  );
}

/** Small microphone inside the input pill (voice-to-text entry). */
export function IconMicSmall({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 12a6 6 0 0 0 12 0M12 18v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Legacy alias kept for any remaining call sites. */
export function IconVoice({ size = 26 }: IconProps) {
  return <IconVoiceCircle size={size} />;
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
