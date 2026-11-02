import { useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { Switch } from '../../components/Switch';
import { IconCheck } from '../../components/icons';
import { currentTheme, getThemePref, setThemePref, type ThemePref } from '../../lib/theme';
import './settings.css';

/**
 * 深色模式 (M-K0) —— 微信 设置 › 通用 › 深色模式 的同款结构：
 * 一个「跟随系统」开关；关掉之后才出现「普通模式 / 深色模式」两行单选。
 *
 * 立即生效、不设「完成」按钮：切换是全局 token 级的，没有半途状态需要提交。
 */
export function DarkModePage() {
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const follow = pref === 'system';

  const pick = (p: ThemePref) => {
    setPref(p);
    setThemePref(p);
  };

  // 关掉「跟随系统」时停在用户此刻正看着的那一种——否则一关开关画面就跳，
  // 像是关了个和主题无关的东西。
  const toggleFollow = () => pick(follow ? currentTheme() : 'system');

  return (
    <>
      <SubNav title="深色模式" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__row" onClick={toggleFollow}>
            <span className="settings__label">跟随系统</span>
            <Switch on={follow} onChange={toggleFollow} />
          </div>
        </div>
        <p className="settings__hint">开启后，将跟随系统打开或关闭深色模式</p>
        {!follow && (
          <>
            <div className="settings__group-title">手动选择</div>
            <div className="settings__group">
              <div
                className="settings__row settings__row--divided"
                role="radio"
                aria-checked={pref === 'light'}
                onClick={() => pick('light')}
              >
                <span className="settings__label">普通模式</span>
                {pref === 'light' && (
                  <span className="settings__check">
                    <IconCheck />
                  </span>
                )}
              </div>
              <div
                className="settings__row"
                role="radio"
                aria-checked={pref === 'dark'}
                onClick={() => pick('dark')}
              >
                <span className="settings__label">深色模式</span>
                {pref === 'dark' && (
                  <span className="settings__check">
                    <IconCheck />
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
