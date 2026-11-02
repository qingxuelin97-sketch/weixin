/**
 * 原生状态栏与主题同步 (M-K0)。
 *
 * lib/theme.ts 只管 DOM（依赖方向：lib 不许 import native），这里订阅它的
 * 「生效主题变了」事件，把图标深浅与底色送到原生层。Web 上 setSystemBars 是
 * no-op，浏览器那一侧由 theme.ts 自己改 <meta name="theme-color">。
 */
import { subscribeTheme, navBarColor } from '../lib/theme';
import { setSystemBars } from './bridge';

export function installSystemBarsSync(): () => void {
  return subscribeTheme((theme) => {
    void setSystemBars(theme === 'dark', navBarColor());
  });
}
