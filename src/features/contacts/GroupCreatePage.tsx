/**
 * 发起群聊（M-D3）：pick ≥2 AI friends → a real group conversation is born and
 * the director machinery takes over from the first message.
 *
 * `?preset=id,id,id` (M-I3) opens this screen with those friends already ticked
 * — the landing point of an AI's 拉群提议 card. The proposal ends here on
 * purpose: an agent may suggest a room, only the user may create one, and this
 * screen is where that consent is given (backing out gives none).
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { presetMemberIds, SUGGEST_GROUP_PARAM } from '../../ai/agent-invite';
import { buildGroup, presetState } from '../../ai/group-build';
import '../settings/settings.css';
import { logError } from '../../lib/errlog';
import './contacts.css';

export function GroupCreatePage() {
  const navigate = useNavigate();
  const contacts = useAppStore((s) => s.contacts);
  const addConversation = useAppStore((s) => s.addConversation);
  const putPersona = useAppStore((s) => s.putPersona);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const showToast = useAppStore((s) => s.showToast);
  const [params] = useSearchParams();
  const ais = contacts.filter((c) => c.type === 'ai');
  // Lazy initial state: the preset is a starting point the user can edit, not a
  // binding — re-deriving it on every render would fight their unticking.
  const [picked, setPicked] = useState<Set<string>>(
    () =>
      new Set(
        presetMemberIds(params.get(SUGGEST_GROUP_PARAM), (id) =>
          contacts.some((c) => c.id === id && c.type === 'ai'),
        ),
      ),
  );

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    const memberIds = [...picked];
    if (memberIds.length < 2) {
      showToast('至少选择 2 位好友');
      return;
    }
    const members = memberIds.map((id) => contacts.find((c) => c.id === id)!);
    const title = members.map((m) => m.remark ?? m.name).join('、').slice(0, 16);
    const now = Date.now();
    // THE build path (M-I3): this screen used to assemble a conversation row by
    // hand, so "创建一个群" had two implementations that drifted apart. It now
    // runs `buildGroup` over a state where every member is already `made` —
    // zero generation, zero calls, and one place where a room is born.
    const state = presetState(
      members.map((m) => ({ contactId: m.id, name: m.remark ?? m.name })),
      title,
      now,
    );
    try {
      const out = await buildGroup(state, {
        // Unreachable: every member is pre-`made`. Returning null keeps a ledger
        // bug from turning into a surprise persona-generation bill.
        generateCard: async () => null,
        // These people already know each other for real — a fabricated backlog
        // would put words in their mouths they never said.
        generateHistory: async () => [],
        putContact: async () => {},
        putPersona,
        getPersona: personaFor,
        // The chat list's group avatar grid and 你创建了群聊 preview are this
        // screen's own chrome; the build owns identity, the caller owns looks.
        addConversation: async (c) =>
          addConversation({
            ...c,
            avatarColor: members[0].avatarColor,
            avatarText: members[0].avatarText,
            memberAvatars: members.map((m) => ({ color: m.avatarColor, text: m.avatarText })),
            lastMsgPreview: '你创建了群聊',
          }),
        appendMessage,
        // Nothing was paid for, so there is nothing to resume — parking a
        // build-state row here would only leave litter behind.
        saveState: async () => {},
        now: () => now,
      });
      navigate(`/chat/${out.convId}`, { replace: true });
    } catch (e) {
      // Navigating on a failed write dropped the user into a chat backed by no
      // conversation row — an empty screen with no way to tell what went wrong.
      logError('group.create', e);
      showToast('创建群聊失败，请重试');
    }
  };

  return (
    <>
      <SubNav title="发起群聊" />
      <div className="page-body settings">
        {params.get(SUGGEST_GROUP_PARAM) && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                这是好友提议的名单，已经替你勾好了——可以改，也可以直接返回不建。
              </span>
            </div>
          </div>
        )}

        {/* Building a group by hand means already owning the people in it
            (M-H2). One sentence writes the whole room instead. */}
        <div className="settings__group">
          <div
            className="settings__row"
            role="button"
            onClick={() => navigate('/group-new/ai', { replace: true })}
          >
            <span className="settings__label">让 AI 帮我建一个群</span>
            <span className="settings__value">连人带关系一起生成</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          {ais.map((c) => (
            <div
              key={c.id}
              className="settings__row settings__row--divided"
              onClick={() => toggle(c.id)}
            >
              <span className={`group-pick${picked.has(c.id) ? ' group-pick--on' : ''}`}>
                {picked.has(c.id) ? '✓' : ''}
              </span>
              <Avatar color={c.avatarColor} text={c.avatarText} imageRef={c.avatarRef} size={40} />
              <span className="settings__label" style={{ marginLeft: 10 }}>
                {c.remark ?? c.name}
              </span>
            </div>
          ))}
        </div>
        <button className="btn-primary" onClick={() => void create()} disabled={picked.size < 2}>
          完成（已选 {picked.size} 人）
        </button>
      </div>
    </>
  );
}
