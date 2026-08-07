import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconBack } from './icons';

/** Nav bar for pushed sub-pages: a back chevron on the left + centered title. */
export function SubNav({ title, right }: { title: string; right?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="navbar">
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
