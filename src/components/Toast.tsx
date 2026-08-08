/**
 * Global toast — the shared answer to "点了没反应" (real-device bug #3/#8).
 * One line, centered, auto-dismissing; driven entirely by the store so any
 * feature can `showToast('暂未开放')` without owning UI state.
 */
import { useAppStore } from '../store/appStore';
import './toast.css';

export function Toast() {
  const toast = useAppStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      {toast}
    </div>
  );
}
