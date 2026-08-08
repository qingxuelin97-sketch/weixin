import { useEffect, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './app/ErrorBoundary';
import { TabScaffold } from './app/TabScaffold';
import { Toast } from './components/Toast';
import { ChatListPage } from './features/chat-list/ChatListPage';
import { ContactsPage } from './features/contacts/ContactsPage';
import { DiscoverPage } from './features/discover/DiscoverPage';
import { MePage } from './features/me/MePage';
import { ProfilePage } from './features/me/ProfilePage';
import { ChatPage } from './features/chat/ChatPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { ApiConfigPage } from './features/settings/ApiConfigPage';
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
import { MediaLibraryPage } from './features/settings/MediaLibraryPage';
import { MemoryPage } from './features/settings/MemoryPage';
import { ContactProfilePage } from './features/contacts/ContactProfilePage';
import { NewContactPage } from './features/contacts/NewContactPage';
import { CallPage } from './features/call/CallPage';
import { SearchPage } from './features/search/SearchPage';
import { useAppStore } from './store/appStore';
import { useSchedulerRuntime } from './app/useSchedulerRuntime';

/**
 * Full-screen pushed pages slide in from the right (finally consuming the
 * `--dur-page` token defined in M1). Keyed by location so every navigation —
 * including chat→chat — replays the entrance. Tabs switch instantly, like WeChat.
 */
function Push({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div className="page-push" key={location.key}>
      {children}
    </div>
  );
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
      <div className="app-shell">
        <ErrorBoundary>
          {!hydrated ? (
            <div className="app-loading" />
          ) : (
            <Routes>
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
              <Route path="/settings/backup" element={<Push><BackupPage /></Push>} />
              <Route path="/settings/notify-test" element={<Push><NotifyTestPage /></Push>} />
              <Route path="/settings/media" element={<Push><MediaLibraryPage /></Push>} />
              <Route path="/persona/:contactId" element={<Push><PersonaEditPage /></Push>} />
              <Route path="/memory/:contactId" element={<Push><MemoryPage /></Push>} />
              <Route path="/contact/:contactId" element={<Push><ContactProfilePage /></Push>} />
              <Route path="/contact-new" element={<Push><NewContactPage /></Push>} />
              <Route path="/call/:convId" element={<Push><CallPage /></Push>} />
              <Route path="/rp/send/:convId" element={<Push><RedPacketSendPage /></Push>} />
              <Route path="/rp/open/:rpId" element={<Push><RedPacketOpenPage /></Push>} />
              <Route path="/rp/:rpId" element={<Push><RedPacketDetailPage /></Push>} />
              <Route path="/transfer/:convId" element={<Push><TransferSendPage /></Push>} />
              <Route path="/wallet" element={<Push><WalletPage /></Push>} />
              <Route path="*" element={<Navigate to="/chats" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
        <Toast />
      </div>
    </HashRouter>
  );
}
