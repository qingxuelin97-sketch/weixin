import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { claimRedPacket } from '../../ai/money-service';
import { fenToYuan } from '../../lib/money';
import { logError } from '../../lib/errlog';
import type { RedPacketVM } from '../../data/types';
import './money.css';

/**
 * The full-screen open-the-packet moment.
 *
 * V1 had the first beat only: a gold 開 coin that spun and then cut to the
 * detail page. Everything that makes opening a packet feel like *receiving
 * money* happened off-screen — you tapped, something spun, and you were
 * somewhere else reading a number.
 *
 * M-I8 plays the whole sequence, in the order WeChat does it:
 *
 *   1. THE COIN FLIPS. Already there; retimed so it is the opening beat rather
 *      than the entire event.
 *   2. THE ENVELOPE LIFTS. Sender and greeting travel up and fade — the top of
 *      the packet coming away. This is the beat V1 was missing entirely, and
 *      it is what turns "a spinner" into "a thing being opened".
 *   3. THE AMOUNT ROLLS UP. Digits rise into place one after another, from
 *      underneath, then 已存入零钱 fades in below.
 *
 * All CSS (transform/opacity, collapsed under prefers-reduced-motion). The
 * stage machine below only decides WHEN each beat starts; it never drives a
 * frame, so the golden gate can still freeze the whole page (specs/motion.md).
 */

/** Coin spin. Matches `rp-coin-flip` in money.css — the CSS owns the curve. */
const FLIP_MS = 700;
/**
 * How long the revealed amount is held before the detail page takes over.
 *
 * Long enough to READ it: the last glyph starts at 6×55ms and runs 420ms, so
 * the number is only fully landed at ~700ms. A shorter hold shows a number
 * still assembling itself and then cuts away — worse than no animation.
 */
const REVEAL_HOLD_MS = 1300;

type Stage = 'idle' | 'opening' | 'revealed';

export function RedPacketOpenPage() {
  const { rpId = '' } = useParams();
  const navigate = useNavigate();
  const contactById = useAppStore((s) => s.contactById);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const [rp, setRp] = useState<RedPacketVM | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [wonFen, setWonFen] = useState<number | null>(null);
  const [emptied, setEmptied] = useState(false);
  const [error, setError] = useState('');
  /**
   * Every pending hand-off, so unmounting mid-sequence cannot navigate.
   * The old version left a bare setTimeout running: back out during the spin
   * and the timer still fired, yanking you to a detail page you had left.
   */
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const found = await repo.getRedPacket(rpId);
        if (!alive) return;
        setRp(found ?? null);
        if (found) {
          const claims = await repo.getClaims(rpId);
          if (!alive) return;
          const mine = claims.some((c) => c.claimerId === 'self');
          if (mine) navigate(`/rp/${rpId}`, { replace: true });
          else if (claims.length >= found.count) setEmptied(true);
        }
      } catch (e) {
        logError('rp.open.load', e);
        if (alive) setError('红包信息读取失败');
      }
    })();
    return () => {
      alive = false;
    };
  }, [rpId, navigate]);

  // 专属红包 (M-J8): not yours → you can look, not touch. Enforced again by
  // the pure claim rule (claimShare) so this gate is presentation, not the
  // security boundary — a forged URL still cannot take the share.
  const notMine = rp?.mode === 'exclusive' && rp.exclusiveId !== 'self';
  const expired = rp?.status === 'expired';

  const open = async () => {
    if (!rp || stage !== 'idle' || emptied || notMine || expired) return;
    setStage('opening');
    setError('');
    try {
      const claim = await claimRedPacket(rp.id, 'self', contactById('self')?.name ?? '我', {
        appendMessage,
        updateMessage,
        now: () => Date.now(),
      });
      if (!claim) {
        // Someone else took the last share while the coin was spinning. Let the
        // spin finish before saying so — cutting it mid-flight looks like a bug.
        later(() => {
          setStage('idle');
          setEmptied(true);
        }, FLIP_MS);
        return;
      }
      setWonFen(claim.amountFen);
      // The amount cannot appear before the coin has gone; the flip owns the
      // screen until then.
      later(() => setStage('revealed'), FLIP_MS);
      later(() => navigate(`/rp/${rp.id}`, { replace: true }), FLIP_MS + REVEAL_HOLD_MS);
    } catch (e) {
      // The coin was left spinning on a throw, with the packet unopenable for
      // the rest of the session. `claimRedPacket` is idempotent per claimer, so
      // clearing the stage and letting them tap again is safe.
      logError('rp.claim', e);
      setStage('idle');
      setError(e instanceof Error ? e.message : '开红包失败，请重试');
    }
  };

  const sender = rp ? contactById(rp.senderId) : undefined;

  return (
    <div className={`rp-open${stage === 'idle' ? '' : ' rp-open--opening'}`}>
      <button className="rp-open__close" onClick={() => navigate(-1)} aria-label="关闭">
        ×
      </button>
      {rp && (
        <>
          <div className="rp-open__sender">
            <Avatar
              color={sender?.avatarColor ?? 'var(--color-brand)'}
              text={sender?.avatarText ?? '?'}
              imageRef={sender?.avatarRef}
              size={56}
            />
            <div className="rp-open__name">
              {rp.senderId === 'self' ? '我' : (sender?.remark ?? sender?.name ?? '')}的红包
            </div>
          </div>
          <div className="rp-open__greeting">{rp.greeting}</div>
          {notMine ? (
            <div className="rp-open__expired">
              这是{(() => {
                const who = rp.exclusiveId ? contactById(rp.exclusiveId) : undefined;
                return who ? ` ${who.remark ?? who.name} ` : '别人';
              })()}的专属红包
            </div>
          ) : expired ? (
            <div className="rp-open__expired">红包已过期</div>
          ) : emptied ? (
            <div className="rp-open__expired">手慢了，红包派完了</div>
          ) : stage === 'revealed' && wonFen != null ? (
            <RevealedAmount fen={wonFen} />
          ) : (
            <button
              className={`rp-open__coin${stage === 'opening' ? ' rp-open__coin--flip' : ''}`}
              onClick={() => void open()}
              aria-label="开红包"
            >
              開
            </button>
          )}
          {error && <div className="rp-open__expired">{error}</div>}
        </>
      )}
    </div>
  );
}

/**
 * The amount, rolling up a character at a time.
 *
 * Per-character delays rather than one block animation: a single element that
 * slides up is a label arriving, while digits that arrive in sequence read as a
 * counter landing — which is the thing that makes the number feel *counted*.
 * Capped by the string's own length (money is at most a handful of glyphs), so
 * there is no runaway stagger to bound.
 */
function RevealedAmount({ fen }: { fen: number }) {
  const text = fenToYuan(fen);
  return (
    <div className="rp-open__reveal" role="status">
      <div className="rp-open__amount">
        {[...text].map((ch, idx) => (
          <span
            key={`${idx}-${ch}`}
            className="rp-open__digit"
            style={{ '--roll-delay': `${idx * 55}ms` } as React.CSSProperties}
          >
            {ch}
          </span>
        ))}
        <span
          className="rp-open__unit"
          style={{ '--roll-delay': `${text.length * 55}ms` } as React.CSSProperties}
        >
          元
        </span>
      </div>
      <div className="rp-open__stored">已存入零钱</div>
    </div>
  );
}
