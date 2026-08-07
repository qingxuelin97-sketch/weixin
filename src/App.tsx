import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './app/ErrorBoundary';
import { TabScaffold } from './app/TabScaffold';
import { ChatListPage } from './features/chat-list/ChatListPage';
import { ContactsPage } from './features/contacts/ContactsPage';
import { DiscoverPage } from './features/discover/DiscoverPage';
import { MePage } from './features/me/MePage';
import { ChatPage } from './features/chat/ChatPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { ApiConfigPage } from './features/settings/ApiConfigPage';
import { PersonaEditPage } from './features/settings/PersonaEditPage';
import { RedPacketSendPage } from './features/money/RedPacketSendPage';
import { RedPacketOpenPage } from './features/money/RedPacketOpenPage';
import { RedPacketDetailPage } from './features/money/RedPacketDetailPage';
import { TransferSendPage } from './features/money/TransferSendPage';
import { WalletPage } from './features/money/WalletPage';
import { useAppStore } from './store/appStore';
import { useSchedulerRuntime } from './app/useSchedulerRuntime';

/**
 * Navigation model: the four tabs share a persistent scaffold (nav + tabbar);
 * everything else pushes as a full-screen route (right-in / left-out). HashRouter
 * keeps deep links working under Capacitor's file:// origin and static hosting.
 */
export function App() {
  const hydrated = useAppStore((s) => s.hydrated);
  const hydrate = useAppStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Single time-evolution path: drains scheduled_actions once hydrated.
  useSchedulerRuntime(hydrated);

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
              <Route path="/chat/:convId" element={<ChatPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/api" element={<ApiConfigPage />} />
              <Route path="/persona/:contactId" element={<PersonaEditPage />} />
              <Route path="/rp/send/:convId" element={<RedPacketSendPage />} />
              <Route path="/rp/open/:rpId" element={<RedPacketOpenPage />} />
              <Route path="/rp/:rpId" element={<RedPacketDetailPage />} />
              <Route path="/transfer/:convId" element={<TransferSendPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="*" element={<Navigate to="/chats" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
      </div>
    </HashRouter>
  );
}
