import { Suspense, lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './app/ErrorBoundary';
import { TabScaffold } from './app/TabScaffold';
import { PageStack } from './app/PageStack';
// 有 golden 的页留在主包里：懒页首帧是 Suspense 兜底，基线会拍到空白（守卫在
// route-goldens.test.ts 里，我自己就先把这一页拆错了一次）。
import { NotifyTestPage } from './features/settings/NotifyTestPage';
import { Toast } from './components/Toast';
import { IncomingCall } from './features/call/IncomingCall';
import { MiniCallPill } from './features/call/MiniCallPill';
import { DialogHost } from './components/dialog';
import { useBackButton } from './app/useBackButton';
import { ChatListPage } from './features/chat-list/ChatListPage';
import { ContactsPage } from './features/contacts/ContactsPage';
import { DiscoverPage } from './features/discover/DiscoverPage';
import { MePage } from './features/me/MePage';
import { ProfilePage } from './features/me/ProfilePage';
import { ChatPage } from './features/chat/ChatPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { ApiConfigPage } from './features/settings/ApiConfigPage';
import { AsrConfigPage } from './features/settings/AsrConfigPage';
import { TtsConfigPage } from './features/settings/TtsConfigPage';
import { PersonaEditPage } from './features/settings/PersonaEditPage';
import { RedPacketSendPage } from './features/money/RedPacketSendPage';
import { RedPacketOpenPage } from './features/money/RedPacketOpenPage';
import { RedPacketDetailPage } from './features/money/RedPacketDetailPage';
import { TransferSendPage } from './features/money/TransferSendPage';
import { WalletPage } from './features/money/WalletPage';
import { MomentsPage } from './features/moments/MomentsPage';
import { MomentPublishPage } from './features/moments/MomentPublishPage';
import { MomentAlbumPage } from './features/moments/MomentAlbumPage';
import { BackupPage } from './features/settings/BackupPage';
import { MediaLibraryPage } from './features/settings/MediaLibraryPage';
import { MemoryPage } from './features/settings/MemoryPage';
import { WorldbookPage } from './features/settings/WorldbookPage';
import { StoryPage } from './features/story/StoryPage';
import { ContactProfilePage } from './features/contacts/ContactProfilePage';
import { StatusPage } from './features/contacts/StatusPage';
import { YearReportPage } from './features/me/YearReportPage';
import { FavoritesPage } from './features/favorites/FavoritesPage';
import { NewContactPage } from './features/contacts/NewContactPage';
import { ChatInfoPage } from './features/chat/ChatInfoPage';
import {
  ChatOnlyListPage,
  GroupListPage,
  NewFriendsPage,
  TagListPage,
  TagMembersPage,
} from './features/contacts/ContactListPages';
import { FriendPermPage } from './features/contacts/FriendPermPage';
import { QrCodePage } from './features/me/QrCodePage';
import { StatusSetPage } from './features/me/StatusSetPage';
import { SearchPage } from './features/search/SearchPage';
import { NativePage } from './features/settings/NativePage';
import { UsagePage } from './features/settings/UsagePage';
import { PromptLabPage } from './features/settings/PromptLabPage';
import { BatteryGuidePage } from './features/settings/BatteryGuidePage';
import { useAppStore } from './store/appStore';
import { useSchedulerRuntime } from './app/useSchedulerRuntime';
import { useDeepLinks } from './app/useDeepLinks';
import { MomentDetailPage } from './features/moments/MomentDetailPage';

/**
 * 冷路由懒加载 (M-J7)。
 *
 * J10 把体积棘轮拆成主/懒双账本后，第一件事就看出来了：**主 361KB / 懒 14KB**，
 * 几乎整个 App 都躺在冷启动重量里。这八条路由是最该出去的那批——通话、剧情运行、
 * AI 代写、合并转发查看——没有一条是「打开 App 先看到的东西」，而通话那两页还
 * 顺带把 TTS/ASR/通话会话整条栈拖进了首屏。
 *
 * 只挑 route-ledger 里标了 `exempt`（没有 golden）的页：懒加载会让首帧短暂是
 * Suspense 兜底，而截图基线正是首帧。有 golden 的页留在主包里，不拿基线冒险
 * ——这条判据现在由 route-goldens.test.ts 机器强制，因为我写这一批时就把
 * `/settings/notify-test` 拆错了（它有 golden），是那条守卫当场抓住的。
 */
const lazyPage = <T, K extends keyof T>(load: () => Promise<T>, key: K) =>
  lazy(() => load().then((m) => ({ default: m[key] as ComponentType })));

const MergedViewPage = lazyPage(() => import('./features/chat/MergedViewPage'), 'MergedViewPage');
const ScriptDetailPage = lazyPage(() => import('./features/story/ScriptDetailPage'), 'ScriptDetailPage');
const StoryRunPage = lazyPage(() => import('./features/story/StoryRunPage'), 'StoryRunPage');
const PersonaGeneratePage = lazyPage(() => import('./features/contacts/PersonaGeneratePage'), 'PersonaGeneratePage');
const GroupGeneratePage = lazyPage(() => import('./features/contacts/GroupGeneratePage'), 'GroupGeneratePage');
const EnvDiagPage = lazyPage(() => import('./features/settings/EnvDiagPage'), 'EnvDiagPage');
const GroupCreatePage = lazyPage(() => import('./features/contacts/GroupCreatePage'), 'GroupCreatePage');
const MomentRepostPage = lazyPage(() => import('./features/moments/MomentRepostPage'), 'MomentRepostPage');
const MomentTopicPage = lazyPage(() => import('./features/moments/MomentTopicPage'), 'MomentTopicPage');
const StoragePage = lazyPage(() => import('./features/settings/StoragePage'), 'StoragePage');
const CallPage = lazyPage(() => import('./features/call/CallPage'), 'CallPage');
const GroupCallPage = lazyPage(() => import('./features/call/GroupCallPage'), 'GroupCallPage');

/** Mounts the Android hardware-back handler; needs the router context. */
function BackButtonBridge() {
  useBackButton();
  return null;
}

/**
 * A pushed full-screen page.
 *
 * The transition itself moved to `PageStack` in M-H3: this wrapper used to
 * re-key on `location.key` to replay an ENTRANCE, which is exactly why there
 * was never an exit — the departing page unmounted on the same frame. It is
 * now just the layout box; `PageStack` animates both sides.
 */
function Push({ children }: { children: ReactNode }) {
  // The Suspense boundary sits INSIDE the layout box, so a lazy page's chunk
  // arriving does not remount the box PageStack is animating — the transition
  // plays over an empty page-push and the content lands inside it. `null` as
  // the fallback rather than a spinner: the chunk is same-origin and already
  // in the browser cache after the first visit, so a spinner would mostly be a
  // one-frame flash of loading state on a page that is already there.
  return (
    <div className="page-push">
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}

/**
 * aiwx:// deep links (M-I10): bubble taps, notification taps, the call
 * full-screen intent and the widget all land here. Needs useNavigate, so it
 * must live INSIDE the HashRouter — hence a null component, not a hook in App.
 */
function DeepLinkBridge() {
  useDeepLinks();
  return null;
}

/**
 * Navigation model: the four tabs share a persistent scaffold (nav + tabbar);
 * everything else pushes as a full-screen route (right-in / left-out). HashRouter
 * keeps deep links working under Capacitor's file:// origin and static hosting.
 */
export function App() {
  const hydrated = useAppStore((s) => s.hydrated);
  const hydrateError = useAppStore((s) => s.hydrateError);
  const hydrate = useAppStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Single time-evolution path: drains scheduled_actions once hydrated.
  useSchedulerRuntime(hydrated);

  // Hydrate rejects asynchronously, which no ErrorBoundary can see — without
  // this branch a failed boot is an eternal blank screen (bug M7). After every
  // hook so the hook order never varies (rules-of-hooks).
  if (hydrateError) {
    return (
      <div className="app-shell">
        <div className="error-screen">
          <p className="error-screen__title">启动失败</p>
          <p className="error-screen__msg">{hydrateError}</p>
          <button className="error-screen__btn" onClick={() => void hydrate()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <HashRouter>
      <DeepLinkBridge />
      <div className="app-shell">
        <BackButtonBridge />
        <ErrorBoundary>
          {!hydrated ? (
            <div className="app-loading" />
          ) : (
            <PageStack>
              {(loc) => (
            <Routes location={loc}>
              <Route element={<TabScaffold />}>
                <Route path="/" element={<Navigate to="/chats" replace />} />
                <Route path="/chats" element={<ChatListPage />} />
                <Route path="/contacts" element={<ContactsPage />} />
                <Route path="/discover" element={<DiscoverPage />} />
                <Route path="/me" element={<MePage />} />
              </Route>
              <Route path="/chat/:convId" element={<Push><ChatPage /></Push>} />
              <Route path="/search" element={<Push><SearchPage /></Push>} />
              <Route path="/moments" element={<Push><MomentsPage /></Push>} />
              <Route path="/moments/publish" element={<Push><MomentPublishPage /></Push>} />
              <Route path="/moments/repost/:momentId" element={<Push><MomentRepostPage /></Push>} />
              <Route path="/moments/topic/:tag" element={<Push><MomentTopicPage /></Push>} />
              <Route path="/moments/album/:contactId" element={<Push><MomentAlbumPage /></Push>} />
              <Route path="/profile" element={<Push><ProfilePage /></Push>} />
              <Route path="/settings" element={<Push><SettingsPage /></Push>} />
              <Route path="/settings/api" element={<Push><ApiConfigPage /></Push>} />
              <Route path="/settings/asr" element={<Push><AsrConfigPage /></Push>} />
              <Route path="/settings/tts" element={<Push><TtsConfigPage /></Push>} />
              <Route path="/settings/backup" element={<Push><BackupPage /></Push>} />
              <Route path="/settings/notify-test" element={<Push><NotifyTestPage /></Push>} />
              <Route path="/settings/env" element={<Push><EnvDiagPage /></Push>} />
              <Route path="/settings/usage" element={<Push><UsagePage /></Push>} />
              <Route path="/settings/prompt-lab" element={<Push><PromptLabPage /></Push>} />
              <Route path="/settings/storage" element={<Push><StoragePage /></Push>} />
              <Route path="/settings/media" element={<Push><MediaLibraryPage /></Push>} />
              <Route path="/settings/native" element={<Push><NativePage /></Push>} />
              <Route path="/settings/battery" element={<Push><BatteryGuidePage /></Push>} />
              <Route path="/persona/:contactId" element={<Push><PersonaEditPage /></Push>} />
              <Route path="/memory/:contactId" element={<Push><MemoryPage /></Push>} />
              <Route path="/settings/worldbook" element={<Push><WorldbookPage /></Push>} />
              <Route path="/merged/:convId/:msgId" element={<Push><MergedViewPage /></Push>} />
              <Route path="/story" element={<Push><StoryPage /></Push>} />
              <Route path="/story/script/:scriptId" element={<Push><ScriptDetailPage /></Push>} />
              <Route path="/story/run/:saveId" element={<Push><StoryRunPage /></Push>} />
              <Route path="/contact/:contactId" element={<Push><ContactProfilePage /></Push>} />
              <Route path="/status/:contactId" element={<Push><StatusPage /></Push>} />
              <Route path="/report" element={<Push><YearReportPage /></Push>} />
              <Route path="/favorites" element={<Push><FavoritesPage /></Push>} />
              <Route path="/contact-new" element={<Push><NewContactPage /></Push>} />
              <Route path="/contact-new/ai" element={<Push><PersonaGeneratePage /></Push>} />
              <Route path="/group-new" element={<Push><GroupCreatePage /></Push>} />
              <Route path="/group-new/ai" element={<Push><GroupGeneratePage /></Push>} />
              <Route path="/chat/:convId/info" element={<Push><ChatInfoPage /></Push>} />
              <Route path="/groups" element={<Push><GroupListPage /></Push>} />
              <Route path="/new-friends" element={<Push><NewFriendsPage /></Push>} />
              <Route path="/contacts-chats-only" element={<Push><ChatOnlyListPage /></Push>} />
              <Route path="/contacts-tags" element={<Push><TagListPage /></Push>} />
              <Route path="/contacts-tags/:tag" element={<Push><TagMembersPage /></Push>} />
              <Route path="/contact/:contactId/perm" element={<Push><FriendPermPage /></Push>} />
              <Route path="/qrcode" element={<Push><QrCodePage /></Push>} />
              <Route path="/status-set" element={<Push><StatusSetPage /></Push>} />
              <Route path="/call/:convId" element={<Push><CallPage /></Push>} />
              <Route path="/group-call/:convId" element={<Push><GroupCallPage /></Push>} />
              <Route path="/rp/send/:convId" element={<Push><RedPacketSendPage /></Push>} />
              <Route path="/rp/open/:rpId" element={<Push><RedPacketOpenPage /></Push>} />
              <Route path="/rp/:rpId" element={<Push><RedPacketDetailPage /></Push>} />
              <Route path="/transfer/:convId" element={<Push><TransferSendPage /></Push>} />
              <Route path="/wallet" element={<Push><WalletPage /></Push>} />
              {/* Static /moments/* siblings above rank higher than this param
                  route (React Router segment ranking), so it only catches ids. */}
              <Route path="/moments/:momentId" element={<Push><MomentDetailPage /></Push>} />
              <Route path="*" element={<Navigate to="/chats" replace />} />
            </Routes>
              )}
            </PageStack>
          )}
        </ErrorBoundary>
        <Toast />
        {/* Imperative dialogs (showConfirm/showPrompt/showActionSheet) render
            here, above every feature overlay (M-I0). */}
        <DialogHost />
        {/* Over everything, on any route: a call you have to navigate to is not
            a call. Renders nothing until an agent actually rings (M-H1). */}
        <IncomingCall />
        <MiniCallPill />
      </div>
    </HashRouter>
  );
}
