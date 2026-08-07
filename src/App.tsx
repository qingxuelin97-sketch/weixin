import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './app/ErrorBoundary';
import { TabScaffold } from './app/TabScaffold';
import { ChatListPage } from './features/chat-list/ChatListPage';
import { ContactsPage } from './features/contacts/ContactsPage';
import { DiscoverPage } from './features/discover/DiscoverPage';
import { MePage } from './features/me/MePage';
import { ChatPage } from './features/chat/ChatPage';

/**
 * Navigation model: the four tabs share a persistent scaffold (nav + tabbar);
 * everything else pushes as a full-screen route (right-in / left-out). HashRouter
 * keeps deep links working under Capacitor's file:// origin and static hosting.
 */
export function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <ErrorBoundary>
        <Routes>
          <Route element={<TabScaffold />}>
            <Route path="/" element={<Navigate to="/chats" replace />} />
            <Route path="/chats" element={<ChatListPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/me" element={<MePage />} />
          </Route>
          <Route path="/chat/:convId" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </HashRouter>
  );
}
