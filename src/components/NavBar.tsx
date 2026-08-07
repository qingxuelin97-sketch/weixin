import type { ReactNode } from 'react';

interface NavBarProps {
  title: string;
  left?: ReactNode;
  right?: ReactNode;
}

/** WeChat nav bar: #EDEDED background, centered 17px medium title, no bottom hairline. */
export function NavBar({ title, left, right }: NavBarProps) {
  return (
    <header className="navbar">
      <div className="navbar__left">{left}</div>
      <div className="navbar__title">{title}</div>
      <div className="navbar__right">{right}</div>
    </header>
  );
}
