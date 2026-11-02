import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconBack } from './icons';

/**
 * Nav bar for pushed sub-pages: a back chevron on the left + centered title.
 *
 * `tone="rp"` (M-K3)：红包详情页的红色导航——与下面那道红色弧形头连成一片，
 * 返回键是淡金色（微信同款）。
 */
export function SubNav({
  title,
  right,
  tone,
}: {
  title: string;
  right?: ReactNode;
  tone?: 'rp';
}) {
  const navigate = useNavigate();
  return (
    <header className={`navbar${tone === 'rp' ? ' navbar--rp' : ''}`}>
      <div className="navbar__left">
        <button className="navbar__btn" aria-label="返回" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
      </div>
      <div className="navbar__title">{title}</div>
      <div className="navbar__right">{right}</div>
    </header>
  );
}
