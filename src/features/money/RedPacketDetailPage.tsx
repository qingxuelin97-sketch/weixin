import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { fenToYuan } from '../../lib/money';
import type { RedPacketVM, RpClaimVM } from '../../data/types';
import './money.css';

/** Red packet detail: what I got, and the claim list with the luck crown. */
export function RedPacketDetailPage() {
  const { rpId = '' } = useParams();
  const contactById = useAppStore((s) => s.contactById);
  const [rp, setRp] = useState<RedPacketVM | null>(null);
  const [claims, setClaims] = useState<RpClaimVM[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [found, cs] = await Promise.all([repo.getRedPacket(rpId), repo.getClaims(rpId)]);
      if (!alive) return;
      setRp(found ?? null);
      setClaims(cs);
    };
    void load();
    // Claims keep arriving while AI members grab; poll briefly so the list fills in.
    const t = setInterval(() => void load(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [rpId]);

  const sender = rp ? contactById(rp.senderId) : undefined;
  const mine = claims.find((c) => c.claimerId === 'self');
  const claimedFen = claims.reduce((n, c) => n + c.amountFen, 0);

  return (
    <>
      <SubNav title="红包详情" />
      <div className="page-body rp-detail">
        {rp && (
          <>
            <div className="rp-detail__head">
              <div className="rp-detail__from">
                {rp.senderId === 'self' ? '我' : (sender?.remark ?? sender?.name ?? '')}的红包
              </div>
              <div className="rp-detail__greeting">{rp.greeting}</div>
              {mine && (
                <>
                  <div className="rp-detail__amount">{fenToYuan(mine.amountFen)} 元</div>
                  <div className="rp-detail__stored">已存入零钱</div>
                </>
              )}
            </div>
            <div className="rp-detail__summary">
              已领取 {claims.length}/{rp.count} 个，共 {fenToYuan(claimedFen)}/{fenToYuan(rp.totalFen)} 元
            </div>
            {claims.map((c) => {
              const who = contactById(c.claimerId);
              return (
                <div key={c.id} className="rp-claim">
                  <Avatar
                    color={who?.avatarColor ?? 'var(--color-brand)'}
                    text={who?.avatarText ?? '?'}
                    imageRef={who?.avatarRef}
                    size={40}
                  />
                  <div className="rp-claim__main">
                    <div className="rp-claim__name">
                      {c.claimerId === 'self' ? '我' : (who?.remark ?? who?.name ?? c.claimerId)}
                      {c.isBest && <span className="rp-claim__best">👑 手气最佳</span>}
                    </div>
                    <div className="rp-claim__time">{formatTime(c.claimedAt)}</div>
                  </div>
                  <div className="rp-claim__amount">{fenToYuan(c.amountFen)} 元</div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
