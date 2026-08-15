import { useEffect, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './app/ErrorBoundary';
import { TabScaffold } from './app/TabScaffold';
import { PageStack } from './app/PageStack';
import { Toast } from './components/Toast';
import { IncomingCall } from './features/call/IncomingCall';
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
import { PersonaEditPage } from './features/settings/PersonaEditPage';
import { RedPacketSendPage } from './features/money/RedPacketSendPage';
import { RedPacketOpenPage } from './features/money/RedPacketOpenPage';
import { RedPacketDetailPage } from './features/money/RedPacketDetailPage';
import { TransferSendPage } from './features/money/TransferSendPage';
import { WalletPage } from './features/money/WalletPage';
import { MomentsPage } from './features/moments/MomentsPage';
import { MomentPublishPage } from './features/moments/MomentPublishPage';
import { BackupPage } from './features/settings/BackupPage';
import { NotifyTestPage } from './features/settings/NotifyTestPage';
import { EnvDiagPage } from './features/settings/EnvDiagPage';
import { MediaLibraryPage } from './features/settings/MediaLibraryPage';
import { MemoryPage } from './features/settings/MemoryPage';
import { WorldbookPage } from './features/settings/WorldbookPage';
import { MergedViewPage } from './features/chat/MergedViewPage';
import { StoryPage } from './features/settings/StoryPage';
import { ContactProfilePage } from './features/contacts/ContactProfilePage';
import { StatusPage } from './features/contacts/StatusPage';
import { YearReportPage } from './features/me/YearReportPage';
import { NewContactPage } from './features/contacts/NewContactPage';
import { PersonaGeneratePage } from './features/contacts/PersonaGeneratePage';
import { GroupCreatePage } from './features/contacts/GroupCreatePage';
import { GroupGeneratePage } from './features/contacts/GroupGeneratePage';
import { ChatInfoPage } from './features/chat/ChatInfoPage';
import { GroupListPage, NewFriendsPage, SimpleListPage } from './features/contacts/ContactListPages';
import { CallPage } from './features/call/CallPage';
import { SearchPage } from './features/search/SearchPage';
import { NativePage } from './features/settings/NativePage';
import { BatteryGuidePage } from './features/settings/BatteryGuidePage';
import { useAppStore } from './store/appStore';
import { useSchedulerRuntime } from './app/useSchedulerRuntime';
import { useDeepLinks } from './app/useDeepLinks';

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
  return <div className="page-push">{children}</div>;
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
              <Route path="/profile" element={<Push><ProfilePage /></Push>} />
              <Route path="/settings" element={<Push><SettingsPage /></Push>} />
              <Route path="/settings/api" element={<Push><ApiConfigPage /></Push>} />
              <Route path="/settings/asr" element={<Push><AsrConfigPage /></Push>} />
              <Route path="/settings/backup" element={<Push><BackupPage /></Push>} />
              <Route path="/settings/notify-test" element={<Push><NotifyTestPage /></Push>} />
              <Route path="/settings/env" element={<Push><EnvDiagPage /></Push>} />
              <Route path="/settings/media" element={<Push><MediaLibraryPage /></Push>} />
              <Route path="/settings/native" element={<Push><NativePage /></Push>} />
              <Route path="/settings/battery" element={<Push><BatteryGuidePage /></Push>} />
              <Route path="/persona/:contactId" element={<Push><PersonaEditPage /></Push>} />
              <Route path="/memory/:contactId" element={<Push><MemoryPage /></Push>} />
              <Route path="/settings/worldbook" element={<Push><WorldbookPage /></Push>} />
              <Route path="/merged/:convId/:msgId" element={<Push><MergedViewPage /></Push>} />
              <Route path="/story" element={<Push><StoryPage /></Push>} />
              <Route path="/contact/:contactId" element={<Push><ContactProfilePage /></Push>} />
              <Route path="/status/:contactId" element={<Push><StatusPage /></Push>} />
              <Route path="/report" element={<Push><YearReportPage /></Push>} />
              <Route path="/contact-new" element={<Push><NewContactPage /></Push>} />
              <Route path="/contact-new/ai" element={<Push><PersonaGeneratePage /></Push>} />
              <Route path="/group-new" element={<Push><GroupCreatePage /></Push>} />
              <Route path="/group-new/ai" element={<Push><GroupGeneratePage /></Push>} />
              <Route path="/chat/:convId/info" element={<Push><ChatInfoPage /></Push>} />
              <Route path="/groups" element={<Push><GroupListPage /></Push>} />
              <Route path="/new-friends" element={<Push><NewFriendsPage /></Push>} />
              <Route path="/contacts-chats-only" element={<Push><SimpleListPage kind="chats-only" /></Push>} />
              <Route path="/contacts-tags" element={<Push><SimpleListPage kind="tags" /></Push>} />
              <Route path="/call/:convId" element={<Push><CallPage /></Push>} />
              <Route path="/rp/send/:convId" element={<Push><RedPacketSendPage /></Push>} />
              <Route path="/rp/open/:rpId" element={<Push><RedPacketOpenPage /></Push>} />
              <Route path="/rp/:rpId" element={<Push><RedPacketDetailPage /></Push>} />
              <Route path="/transfer/:convId" element={<Push><TransferSendPage /></Push>} />
              <Route path="/wallet" element={<Push><WalletPage /></Push>} />
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
      </div>
    </HashRouter>
  );
}
