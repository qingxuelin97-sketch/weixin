import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { IconCheck } from '../../components/icons';
import { useMedia } from '../../components/useMedia';
import { repo } from '../../db/repo';
import { registerMedia } from '../../data/media-registry';
import { useAppStore } from '../../store/appStore';
import {
  CHAT_BG_PRESETS,
  PRESET_LABEL,
  chatBgStyle,
  parseChatBg,
  type ChatBg,
} from '../../lib/chat-bg';
import { logError } from '../../lib/errlog';
import { LinkRow } from './rows';
import './settings.css';

/**
 * 聊天背景 (M-K5)：两个入口共用这一页——
 *   - `/settings/chat-bg`        设置 › 聊天 › 聊天背景（全局默认，`chatBgDefault`）
 *   - `/chat/:convId/bg`         聊天信息 › 设置当前聊天背景（`chatBg:<convId>`，压过全局）
 * 预置是渐变 / 纹理（零 PNG），「从相册选择」走素材库（与发图同一条导入管线，跟着备份走）。
 */
export function ChatBgPage() {
  const { convId } = useParams();
  const showToast = useAppStore((s) => s.showToast);
  const [current, setCurrent] = useState<ChatBg | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useMedia(current?.kind === 'image' ? [current.ref] : []);

  useEffect(() => {
    let alive = true;
    const read = convId ? repo.getSetting(`chatBg:${convId}`) : repo.getSetting('chatBgDefault');
    void read.then((v) => {
      if (!alive) return;
      setCurrent(parseChatBg(v));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [convId]);

  const save = async (bg: ChatBg | undefined) => {
    setCurrent(bg);
    try {
      // 「跟随全局」写 null 而不是删行：Repo 接口不为这一处长出删除方法
      // （宪法 §3：换驱动只实现接口），parseChatBg 把 null 读成「没设过」。
      if (convId) await repo.putSetting(`chatBg:${convId}`, bg ?? null);
      else await repo.putSetting('chatBgDefault', bg ?? null);
      showToast('已设置');
    } catch (e) {
      logError('chatbg.save', e);
      showToast('设置失败');
    }
  };

  const importPhoto = async (f: File | undefined) => {
    if (!f || !f.type.startsWith('image/')) return;
    const item = {
      id: crypto.randomUUID(),
      kind: 'photo' as const,
      tags: ['聊天背景'],
      mime: f.type,
      blob: f as Blob,
      createdAt: Date.now(),
    };
    await repo.putMedia(item);
    registerMedia(item.id, { url: URL.createObjectURL(f), kind: 'photo', tags: item.tags });
    await save({ kind: 'image', ref: `idb:${item.id}` });
  };

  const isOn = (bg: ChatBg) =>
    current != null &&
    current.kind === bg.kind &&
    (bg.kind !== 'preset' || (current.kind === 'preset' && current.id === bg.id));

  const tiles: Array<{ key: string; label: string; bg: ChatBg }> = [
    { key: 'none', label: '无', bg: { kind: 'none' } },
    ...CHAT_BG_PRESETS.map((id) => ({ key: id, label: PRESET_LABEL[id], bg: { kind: 'preset', id } as ChatBg })),
  ];

  return (
    <>
      <SubNav title={convId ? '设置当前聊天背景' : '聊天背景'} />
      <div className="page-body settings">
        <div className="settings__group-title">选择背景图</div>
        <div className="chatbg-grid">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              className="chatbg-grid__tile"
              aria-pressed={loaded && isOn(t.bg)}
              onClick={() => void save(t.bg)}
            >
              <span className="chatbg-grid__swatch" style={chatBgStyle(t.bg)} />
              <span className="chatbg-grid__label">{t.label}</span>
              {loaded && isOn(t.bg) && (
                <span className="chatbg-grid__check">
                  <IconCheck size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="settings__group">
          <LinkRow
            label="从相册选择"
            value={current?.kind === 'image' ? '已使用相册图片' : ''}
            onClick={() => fileRef.current?.click()}
            last={!convId}
          />
          {convId && (
            <LinkRow label="跟随全局聊天背景" value={current ? '' : '当前'} onClick={() => void save(undefined)} last />
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void importPhoto(e.target.files?.[0]).catch((err) => logError('chatbg.import', err));
            e.target.value = '';
          }}
        />
      </div>
    </>
  );
}
