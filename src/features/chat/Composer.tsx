/**
 * 聊天页的组合器 (M-K11，从 ChatPage 抽出)：输入条 + 表情/「＋」面板 + 三个隐藏的
 * 系统选择器（相册 / 拍摄 / 文件）。
 *
 * 只管「怎么输入」，不管「输入之后发生什么」：发送、面板格子的动作、斗图、发图……
 * 全部经回调交回页面（页面再交给懒加载的发送管线）。键盘⇄面板的三态状态机仍是
 * `useComposerPanel`（宪法第 3 条：已定型，勿重写）——实例由页面持有，因为面板高度
 * 同时决定线程区的底部留白。
 *
 * DOM 与拆分前逐节点一致：`.composer` 外壳、引用条、输入条、面板、三个 input。
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { IconVoiceCircle, IconEmoji, IconPlus } from '../../components/icons';
import { VoiceInputButton } from './VoiceInput';
import { ComposerPanels, type CustomStickerVM } from './ComposerPanels';
import { enterToSend } from '../../lib/chat-prefs';
import type { ComposerState } from './useComposerPanel';
import type { GameKind } from '../../lib/game';

export interface ComposerProps {
  composer: ComposerState;
  /** 多选模式下整条组合器让位给底部操作条。 */
  hidden: boolean;
  isGroup: boolean;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  quote: { msgId: number; text: string } | null;
  onClearQuote: () => void;
  /** 语音模式 (M-J7)：左侧圆圈把整条输入区换成「按住 说话」。 */
  voiceMode: boolean;
  setVoiceMode: Dispatch<SetStateAction<boolean>>;
  /** 本会话的档位，转写守铁律 6（M-I18）。 */
  micTier: 'off' | 'ambiguous' | 'full';
  /** 群里打出「@」→ 页面弹成员选择器 (M-I6)。 */
  onAtTrigger: () => void;
  onSend: () => void;
  /** 松开即发的语音剪辑 (M-J7a)。 */
  onClip: (blob: Blob, durationMs: number) => void;
  /** 「＋」面板的一格——分支在页面（导航、开面板、拉起选择器）。 */
  onAction: (key: string) => void;
  onGame: (kind: GameKind) => void;
  stickers: CustomStickerVM[];
  onSticker: (ref: string) => void;
  onManageStickers: () => void;
  onImages: (files: FileList | null) => void;
  onFile: (file: File | undefined) => void;
  albumInputRef: RefObject<HTMLInputElement>;
  cameraInputRef: RefObject<HTMLInputElement>;
  fileInputRef: RefObject<HTMLInputElement>;
}

export function Composer({
  composer,
  hidden,
  isGroup,
  draft,
  setDraft,
  quote,
  onClearQuote,
  voiceMode,
  setVoiceMode,
  micTier,
  onAtTrigger,
  onSend,
  onClip,
  onAction,
  onGame,
  stickers,
  onSticker,
  onManageStickers,
  onImages,
  onFile,
  albumInputRef,
  cameraInputRef,
  fileInputRef,
}: ComposerProps) {
  return (
    <div
      className="composer"
      style={{
        paddingBottom: composer.mode === 'none' ? 'var(--safe-bottom)' : 0,
        ...(hidden ? { display: 'none' } : {}),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {quote && (
        <div className="composer__quote">
          <span className="composer__quote-text">{quote.text}</span>
          <button className="composer__quote-x" aria-label="取消引用" onClick={onClearQuote}>
            ×
          </button>
        </div>
      )}
      <div className="composer__bar">
        <button
          className="composer__icon"
          aria-label={voiceMode ? '切回键盘' : '切到语音'}
          onClick={() => {
            composer.closeAll();
            setVoiceMode((v) => !v);
          }}
        >
          <IconVoiceCircle />
        </button>
        {voiceMode ? (
          // 语音模式：整条输入区换成「按住 说话」。同一个 VoiceInputButton、
          // 同一套三区手势、同一个录音器——只是命中区变成一整条。
          <VoiceInputButton
            variant="bar"
            tier={micTier}
            onText={(t) => {
              // 从 文 区回来的文字：退出语音模式，让人能改完再发。
              setVoiceMode(false);
              setDraft((d) => (d ? d + t : t));
            }}
            onClip={onClip}
          />
        ) : (
          <div className="composer__pill">
            <textarea
              ref={composer.inputRef}
              className="composer__input"
              rows={1}
              value={draft}
              onChange={(e) => {
                const next = e.target.value;
                // 群 @ 选择器 (M-I6): typing '@' in a group summons the member
                // picker. Inserted as `@名字 ` — exactly what the director's
                // findMentions matches, so a mention is a REAL summons.
                if (isGroup && next.length > draft.length && next.endsWith('@')) {
                  onAtTrigger();
                }
                setDraft(next);
              }}
              onFocus={composer.openKeyboard}
              onKeyDown={(e) => {
                // 回车键发送消息 (M-K4 设置 › 聊天)：关掉时回车只是换行。
                if (e.key === 'Enter' && !e.shiftKey && enterToSend()) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder=""
            />
            <VoiceInputButton tier={micTier} onText={(t) => setDraft((d) => (d ? d + t : t))} onClip={onClip} />
          </div>
        )}
        <button className="composer__icon" aria-label="表情" onClick={composer.toggleEmoji}>
          <IconEmoji />
        </button>
        {draft.trim() ? (
          <button className="composer__send btn-morph-in" onClick={onSend}>
            发送
          </button>
        ) : (
          <button className="composer__icon" aria-label="更多" onClick={composer.togglePlus}>
            <IconPlus />
          </button>
        )}
      </div>
      <ComposerPanels
        mode={composer.mode}
        height={composer.panelHeight}
        // 单聊/群聊各一套面板 (M-K1)：钱那一格按场景换（转账 ⇄ 群收款），
        // 不再把对方场景用不了的格子灰着摆在那儿。
        isGroup={isGroup}
        onAction={onAction}
        onEmoji={(e) => setDraft((d) => d + e)}
        onEmojiDelete={() => setDraft((d) => Array.from(d).slice(0, -1).join(''))}
        // 表情面板右下角的「发送」(M-K2)：选完表情直接发，不必先把键盘叫回来。
        onSend={onSend}
        canSend={Boolean(draft.trim())}
        onGame={onGame}
        stickers={stickers}
        onSticker={onSticker}
        onManageStickers={onManageStickers}
      />
      <input
        ref={albumInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onImages(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          onImages(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
