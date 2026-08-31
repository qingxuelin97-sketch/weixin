/**
 * 素材库（M-C2）。The ONLY on-device way to get real avatars/photos into the
 * app: the APK is CI-built, so the old build-time asset slot is unreachable
 * from a phone. Files land as Blobs in the `media` idb store and register an
 * object URL so `idb:<id>` refs resolve everywhere immediately.
 */
import { useRef, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { showConfirm, showPrompt } from '../../components/dialog';
import { useMedia } from '../../components/useMedia';
import {
  listRegisteredMedia,
  registerMedia,
  registerMediaMeta,
  unregisterMedia,
} from '../../data/media-registry';
import { useAppStore } from '../../store/appStore';
import type { MediaItemVM } from '../../data/types';
import './settings.css';

type Kind = MediaItemVM['kind'];

const KIND_LABEL: Record<Kind, string> = {
  avatar: '头像',
  photo: '照片',
  sticker: '表情',
  generated: '生成图',
};

export function MediaLibraryPage() {
  const [kind, setKind] = useState<Kind>('avatar');
  const [tagsInput, setTagsInput] = useState('');
  const [, bump] = useState(0); // registry is external state; bump to re-render
  const fileRef = useRef<HTMLInputElement>(null);
  const showToast = useAppStore((s) => s.showToast);

  const items = listRegisteredMedia(kind);
  // The grid is the one screen that deliberately shows the WHOLE library, so
  // it is also the one that must prime what it draws — the registry keeps only
  // a bounded number of object URLs live.
  useMedia(items.map((m) => `idb:${m.id}`));
  const parseTags = (s: string) =>
    s
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const tags = kind === 'photo' ? parseTags(tagsInput) : [];
    let done = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const item: MediaItemVM = {
        id: crypto.randomUUID(),
        kind,
        tags,
        mime: f.type,
        blob: f,
        createdAt: Date.now(),
      };
      await repo.putMedia(item);
      registerMedia(item.id, { url: URL.createObjectURL(f), kind, tags });
      done++;
    }
    bump((n) => n + 1);
    showToast(done ? `已导入 ${done} 张` : '没有可导入的图片');
  };

  const remove = async (id: string) => {
    const ok = await showConfirm({
      title: '删除这张素材',
      body: '引用它的头像与历史消息会退回占位图。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await repo.deleteMedia(id);
    unregisterMedia(id);
    bump((n) => n + 1);
  };

  const editTags = async (id: string, current: string[]) => {
    if (kind !== 'photo') return;
    const next = await showPrompt({
      title: '素材标签',
      body: '逗号分隔；留空 = 全员可用',
      initial: current.join(', '),
      allowEmpty: true,
    });
    if (next == null) return;
    const item = await repo.getMediaItem(id);
    if (!item) return;
    const tags = parseTags(next);
    await repo.putMedia({ ...item, tags });
    // Metadata-only update (retagging): must not touch the URL, which may not
    // be materialized right now — passing '' would blank a live image.
    registerMediaMeta(id, { kind, tags });
    bump((n) => n + 1);
  };

  return (
    <>
      <SubNav title="素材库" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="segmented">
            {(['avatar', 'photo', 'sticker', 'generated'] as Kind[]).map((k) => (
              <div
                key={k}
                className={`segmented__item${kind === k ? ' segmented__item--active' : ''}`}
                onClick={() => setKind(k)}
              >
                {`${KIND_LABEL[k]}（${listRegisteredMedia(k).length}）`}
              </div>
            ))}
          </div>
          {kind === 'photo' && (
            <div className="field field--divided">
              <span className="field__label">本次导入的标签（逗号分隔，如：美食, 自拍）</span>
              <input
                className="field__input"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="留空 = 不限人设"
                spellCheck={false}
              />
            </div>
          )}
          <div className="field">
            <span className="field__hint">
              {kind === 'avatar'
                ? '头像库：在人设编辑页/个人资料页里选用。建议方图。'
                : kind === 'photo'
                  ? '照片池：AI 发朋友圈/聊天配图从这里抽取；标签对应人设编辑页的「配图标签」。'
                  : kind === 'sticker'
                    ? '自定义表情（M-I15）：聊天表情面板「我的表情」区从这里读取。你发过的表情，AI 会偷偷收藏并偶尔用回给你。'
                    : 'AI 生成的图片（M-J3）：聊天与朋友圈里生成的配图落在这里，只被生成它的那条消息引用，不进入随机照片池。删除后对应消息退回占位图。'}
            </span>
          </div>
          {kind !== 'generated' && (
            <button className="btn-primary" onClick={() => fileRef.current?.click()}>
              导入图片
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void importFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {items.length > 0 && (
          <div className="settings__group">
            <div className="media-grid">
              {items.map((m) => (
                <div key={m.id} className="media-grid__item">
                  <img
                    className="media-grid__thumb"
                    src={m.url}
                    alt=""
                    onClick={() => void editTags(m.id, m.tags)}
                  />
                  <button
                    className="media-grid__del"
                    aria-label="删除"
                    onClick={() => void remove(m.id)}
                  >
                    ×
                  </button>
                  {kind === 'photo' && m.tags.length > 0 && (
                    <div className="media-grid__tags">{m.tags.join(' ')}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
