import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { claimRedPacket } from '../../ai/money-service';
import type { RedPacketVM } from '../../data/types';
import './money.css';

/**
 * The full-screen open-the-packet moment: sender, greeting, and a gold 開 coin
 * that spins away into the detail page. If the packet is already gone, we skip
 * straight to the detail view rather than teasing a coin that can't be opened.
 */
export function RedPacketOpenPage() {
  const { rpId = '' } = useParams();
  const navigate = useNavigate();
  const contactById = useAppStore((s) => s.contactById);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const [rp, setRp] = useState<RedPacketVM | null>(null);
  const [flipping, setFlipping] = useState(false);
  const [emptied, setEmptied] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
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
    })();
    return () => {
      alive = false;
    };
  }, [rpId, navigate]);

  const open = async () => {
    if (!rp || flipping || emptied) return;
    setFlipping(true);
    const claim = await claimRedPacket(rp.id, 'self', '我', {
      appendMessage,
      updateMessage,
      now: () => Date.now(),
    });
    // Let the coin finish its spin before the detail page takes over.
    setTimeout(() => {
      if (claim) navigate(`/rp/${rp.id}`, { replace: true });
      else setEmptied(true);
    }, 850);
  };

  const sender = rp ? contactById(rp.senderId) : undefined;

  return (
    <div className="rp-open">
      <button className="rp-open__close" onClick={() => navigate(-1)} aria-label="关闭">
        ×
      </button>
      {rp && (
        <>
          <div className="rp-open__sender">
            <Avatar
              color={sender?.avatarColor ?? 'var(--color-brand)'}
              text={sender?.avatarText ?? '?'}
              size={56}
            />
            <div className="rp-open__name">
              {rp.senderId === 'self' ? '我' : (sender?.remark ?? sender?.name ?? '')}的红包
            </div>
          </div>
          <div className="rp-open__greeting">{rp.greeting}</div>
          {emptied ? (
            <div className="rp-open__expired">手慢了，红包派完了</div>
          ) : (
            <button
              className={`rp-open__coin${flipping ? ' rp-open__coin--flip' : ''}`}
              onClick={open}
              aria-label="开红包"
            >
              開
            </button>
          )}
        </>
      )}
    </div>
  );
}
