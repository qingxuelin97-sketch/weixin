/**
 * WeChat-style dialogs, callable from anywhere (M-I0).
 *
 * The five `window.prompt` call sites this replaces are all IMPERATIVE — code
 * mid-flow that needs an answer before it continues (`const name = prompt(…)`).
 * A conventional `<Modal open={…}>` would force every one of those flows to be
 * rewritten around component state, which is exactly how a migration stalls
 * halfway. So the API here keeps the imperative shape:
 *
 *   const name = await showPrompt({ title: '群聊名称', initial: conv.title });
 *   const ok   = await showConfirm({ title: '删除该聊天', body: '…' });
 *   const i    = await showActionSheet({ actions: ['置顶', '删除'] });
 *
 * `<DialogHost/>` is mounted once in the app shell (like Toast) and renders
 * whatever is currently asked. Module-level state, not context, because the
 * scheduler and other non-React code must be able to ask too.
 *
 * Every open dialog registers with the dismiss stack, so the hardware back
 * button cancels it — resolving `false`/`null`, never leaving a promise
 * hanging (a hung promise here is a frozen flow the user cannot see).
 */
import { useEffect, useRef, useState } from 'react';
import { pushDismiss } from '../app/dismiss-stack';
import { useSheetDrag } from './useSheetDrag';
import './overlay.css';

interface ConfirmOpts {
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

interface PromptOpts {
  title: string;
  body?: string;
  initial?: string;
  placeholder?: string;
  maxLength?: number;
  confirmText?: string;
  /** Allow confirming an empty string (e.g. clearing an announcement). */
  allowEmpty?: boolean;
}

interface SheetAction {
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

interface ActionSheetOpts {
  title?: string;
  actions: Array<string | SheetAction>;
  cancelText?: string;
}

type Active =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (text: string | null) => void }
  | { kind: 'sheet'; opts: ActionSheetOpts; resolve: (index: number | null) => void };

/* Module-level single slot + queue: dialogs are modal by definition, so a
   second ask while one is open WAITS rather than stacking two scrims. */
let active: Active | null = null;
const queue: Active[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function enqueue(entry: Active): void {
  if (active) {
    queue.push(entry);
  } else {
    active = entry;
    notify();
  }
}

function settle<T>(entry: Active, value: T): void {
  if (active !== entry) return;
  (entry.resolve as (v: T) => void)(value);
  active = queue.shift() ?? null;
  notify();
}

export function showConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: 'confirm', opts, resolve }));
}

export function showPrompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'prompt', opts, resolve }));
}

export function showActionSheet(opts: ActionSheetOpts): Promise<number | null> {
  return new Promise((resolve) => enqueue({ kind: 'sheet', opts, resolve }));
}

/** Test seam: drop everything, resolving cancels. */
export function dismissAllDialogs(): void {
  const all = active ? [active, ...queue] : [...queue];
  queue.length = 0;
  active = null;
  for (const e of all) {
    if (e.kind === 'confirm') e.resolve(false);
    else e.resolve(null);
  }
  notify();
}

/** Mounted once in the app shell, beside Toast. */
export function DialogHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);

  if (!active) return null;
  const entry = active;
  return entry.kind === 'sheet' ? (
    <SheetView key={idOf(entry)} entry={entry} />
  ) : (
    <ModalView key={idOf(entry)} entry={entry} />
  );
}

/* A stable identity per ask so React remounts (and re-focuses) per dialog. */
const ids = new WeakMap<Active, number>();
let idSeq = 1;
function idOf(entry: Active): number {
  let id = ids.get(entry);
  if (!id) {
    id = idSeq++;
    ids.set(entry, id);
  }
  return id;
}

function ModalView({ entry }: { entry: Active }) {
  const isPrompt = entry.kind === 'prompt';
  const opts = entry.opts as ConfirmOpts & PromptOpts;
  const [text, setText] = useState(isPrompt ? (opts.initial ?? '') : '');
  const inputRef = useRef<HTMLInputElement>(null);

  const cancel = () => {
    if (entry.kind === 'confirm') settle(entry, false);
    else if (entry.kind === 'prompt') settle(entry, null);
  };
  const confirm = () => {
    if (entry.kind === 'confirm') settle(entry, true);
    else if (entry.kind === 'prompt') settle(entry, text);
  };

  // Back button cancels; unregister when this dialog leaves.
  useEffect(() => pushDismiss(cancel), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Focus after mount so the keyboard rises with the dialog, like WeChat.
    inputRef.current?.focus();
  }, []);

  const confirmDisabled = isPrompt && !opts.allowEmpty && !text.trim();

  return (
    <div className="ovl ovl--center" onClick={cancel}>
      <div className="dlg" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <div className="dlg__title">{opts.title}</div>
        {opts.body && <div className="dlg__body">{opts.body}</div>}
        {isPrompt && (
          <input
            ref={inputRef}
            className="dlg__input"
            value={text}
            placeholder={opts.placeholder}
            maxLength={opts.maxLength}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !confirmDisabled) confirm();
            }}
          />
        )}
        <div className="dlg__buttons">
          <button className="dlg__btn" onClick={cancel}>
            {opts.cancelText ?? '取消'}
          </button>
          <button
            className={`dlg__btn dlg__btn--primary${(entry.opts as ConfirmOpts).danger ? ' dlg__btn--danger' : ''}`}
            disabled={confirmDisabled}
            onClick={confirm}
          >
            {opts.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetView({ entry }: { entry: Active & { kind: 'sheet' } }) {
  const { opts } = entry;
  const cancel = () => settle(entry, null);
  useEffect(() => pushDismiss(cancel), []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Drag-to-close (M-I8), on the SAME gesture as `<Sheet/>`.
   *
   * This is the app's most-used bottom surface — every 更多 menu, every
   * 长按 action list — so giving the controlled sheet a thumb-friendly
   * dismissal and leaving this one tap-only would have been the worse of the
   * two possible inconsistencies. There is no scrollRef: an action sheet is a
   * short list that never scrolls, so the drag arms anywhere on it.
   */
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag({ ref: panelRef, onClose: cancel });

  return (
    <div
      className="ovl ovl--bottom"
      onClick={() => {
        // A drag that ended over the scrim is not a scrim tap: the release
        // already decided, and firing cancel here would close a sheet the user
        // just chose to keep.
        if (drag.dragging()) return;
        cancel();
      }}
    >
      <div
        ref={panelRef}
        className="asheet"
        role="menu"
        onClick={(e) => e.stopPropagation()}
        {...drag.handlers}
      >
        {opts.title && <div className="asheet__title">{opts.title}</div>}
        {opts.actions.map((a, i) => {
          const action: SheetAction = typeof a === 'string' ? { label: a } : a;
          return (
            <button
              key={`${i}-${action.label}`}
              role="menuitem"
              className={`asheet__item${action.danger ? ' asheet__item--danger' : ''}`}
              disabled={action.disabled}
              onClick={() => settle(entry, i)}
            >
              {action.label}
            </button>
          );
        })}
        <div className="asheet__gap" />
        <button className="asheet__item asheet__cancel" onClick={cancel}>
          {opts.cancelText ?? '取消'}
        </button>
      </div>
    </div>
  );
}
