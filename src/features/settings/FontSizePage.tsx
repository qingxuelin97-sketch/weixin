import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { StepSlider } from '../../components/StepSlider';
import { useAppStore } from '../../store/appStore';
import { FONT_SCALES, STANDARD_INDEX, setFontIndex, useFontIndex } from '../../lib/font-scale';
import '../chat/chat.css';
import './settings.css';

/**
 * 字体大小 (M-K5)：微信 设置 › 通用 › 字体大小 的同款——上面是几条预览气泡，下面一条
 * 八档滑杆（小 A … 标准 … 大 A）。拖到哪一档，整个 App 立刻跟着变：预览气泡用的就是
 * 聊天页同一套气泡样式与 --fs-* token，所以这里看到的就是聊天里会看到的。
 */
export function FontSizePage() {
  const index = useFontIndex();
  const me = useAppStore((s) => s.contactById('self'));
  const bubble = (self: boolean, text: string) => (
    <div className={`msg-row${self ? ' msg-row--self' : ''}`}>
      {!self && (
        <div className="msg-row__avatar">
          <Avatar color="var(--color-brand)" text="微" size={40} />
        </div>
      )}
      <div className="msg-row__col">
        <div className="msg-row__body">
          <div className={`bubble ${self ? 'bubble--self' : 'bubble--other'}`}>{text}</div>
        </div>
      </div>
      {self && (
        <div className="msg-row__avatar">
          <Avatar
            color={me?.avatarColor ?? 'var(--color-brand)'}
            text={me?.avatarText ?? '我'}
            imageRef={me?.avatarRef}
            size={40}
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      <SubNav title="字体大小" />
      <div className="page-body font-size">
        <div className="font-size__preview">
          {bubble(false, '预览字体大小')}
          {bubble(true, '拖动下面的滑块，可设置字体大小')}
          {bubble(false, '设置后，聊天、菜单和朋友圈里的字都会跟着变大或变小。')}
        </div>
      </div>
      <div className="font-size__control">
        <StepSlider
          label="字体大小"
          steps={FONT_SCALES.length}
          value={index}
          onChange={setFontIndex}
          marks={{ [STANDARD_INDEX]: '标准' }}
          left={<span className="font-size__a font-size__a--small">A</span>}
          right={<span className="font-size__a font-size__a--large">A</span>}
        />
      </div>
    </>
  );
}
