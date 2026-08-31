/**
 * 选角 (M-I7): stage + explicit 角色→persona casting before a run starts.
 *
 * This sheet replaces two silent decisions the old start button made:
 *
 *  1. **The stage.** It always played in `stages[0]` — whichever eligible
 *     group happened to sort first. The user picks the group now.
 *  2. **The cast.** It bound `cast[i]` to `memberIds[i]` by ARRAY POSITION —
 *     a bug in feature's clothing: any roster reorder recast the play,
 *     handing the detective's secret to whoever was first in the array. The
 *     binding is now an explicit, confirmed map (`story-runs.ts` owns the
 *     rules; shuffling the member array is a red test).
 *
 * Secrets are shown only as "藏着秘密" — the person casting the play is also
 * its audience, and printing the secret here spoils the mystery they are
 * about to watch.
 */
import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import type { ConversationVM } from '../../data/types';
import type { Script } from '../../ai/story-script';
import {
  assignRole,
  suggestBindings,
  validateBindings,
} from '../../ai/story-runs';
import './story.css';

export interface CastingSheetProps {
  script: Script | null;
  open: boolean;
  onClose: () => void;
  /** Called with the confirmed stage + explicit binding. */
  onStart: (convId: string, bindings: Record<string, string>) => void;
  busy?: boolean;
}

/**
 * Where a story can play, never a hidden row (AI↔AI DMs are single-typed and
 * MUST stay filtered here — the save row this sheet creates is the only way a
 * convId enters story mode):
 *  - a group with ≥2 persona-backed members (the V3 stage), or
 *  - (V4) a single chat whose peer has a persona — the peer is the only AI
 *    actor, and the USER takes the remaining role themselves.
 */
export function eligibleStages(
  conversations: ConversationVM[],
  personaFor: (id: string) => unknown,
): ConversationVM[] {
  return conversations.filter((c) => {
    if (c.isHidden) return false;
    if (c.type === 'group') return (c.memberIds ?? []).filter(personaFor).length >= 2;
    if (c.type === 'single') return c.peerId != null && Boolean(personaFor(c.peerId));
    return false;
  });
}

/**
 * The actor pool of a stage. In a single chat it is the peer PLUS the user —
 * 'self' is a castable actor there (V4): a 双人本 in a single chat means one
 * role is played live by the person holding the phone. Groups stay AI-only;
 * the user in a group is the audience, which is the V3 contract.
 */
export function actorPoolOf(
  stage: ConversationVM | null,
  personaFor: (id: string) => unknown,
): string[] {
  if (!stage) return [];
  if (stage.type === 'single') return stage.peerId ? [stage.peerId, 'self'] : [];
  return (stage.memberIds ?? []).filter((id) => Boolean(personaFor(id)));
}

export function CastingSheet({ script, open, onClose, onStart, busy }: CastingSheetProps) {
  const conversations = useAppStore((s) => s.conversations);
  const personaFor = useAppStore((s) => s.personaFor);
  const contactById = useAppStore((s) => s.contactById);

  const stages = useMemo(
    () => eligibleStages(conversations, personaFor),
    [conversations, personaFor],
  );

  const [stageId, setStageId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Record<string, string>>({});

  const stage = stages.find((s) => s.id === stageId) ?? null;
  const members = useMemo(() => actorPoolOf(stage, personaFor), [stage, personaFor]);

  // Re-suggest whenever the sheet opens or the stage changes. The suggestion
  // is order-independent (sorted by contact id) so it never depends on how the
  // roster array happens to be stored.
  useEffect(() => {
    if (!open || !script) return;
    const first = stageId && stages.some((s) => s.id === stageId) ? stageId : stages[0]?.id ?? null;
    if (first !== stageId) setStageId(first);
    const pool = actorPoolOf(stages.find((s) => s.id === first) ?? null, personaFor);
    setBindings(suggestBindings(script, pool));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, script, stageId, conversations]);

  if (!script) return null;

  const issues = stage ? validateBindings(script, bindings, members) : [];
  const ready = stage != null && issues.length === 0 && !busy;

  const nameOf = (id: string) => {
    if (id === 'self') return '我自己';
    const c = contactById(id);
    return c?.remark ?? c?.name ?? id;
  };

  return (
    <Sheet open={open} onClose={onClose} title={`开演《${script.title}》`} maxHeight="75vh">
      <div className="casting">
        <div>
          <div className="casting__section-title">
            舞台（{stages.length === 0 ? '还没有可用的群或单聊' : '在哪里演'}）
          </div>
          <div className="casting__stage">
            {stages.map((s) => (
              <button
                key={s.id}
                className={`casting__stage-item${s.id === stageId ? ' casting__stage-item--active' : ''}`}
                onClick={() => setStageId(s.id)}
              >
                {s.title}（
                {s.type === 'single'
                  ? '单聊'
                  : `${(s.memberIds ?? []).filter(personaFor).length} 人`}
                ）
              </button>
            ))}
          </div>
          {stage?.type === 'single' && (
            <p className="casting__hint">单聊舞台：对方是唯一的 AI 演员，剩下的角色由你自己来演。</p>
          )}
        </div>

        <div>
          <div className="casting__section-title">选角（点头像换人）</div>
          {script.cast.map((c) => {
            const picked = bindings[c.charId];
            return (
              <div className="casting__role" key={c.charId}>
                <div className="casting__role-name">
                  {c.role}
                  {c.secret && <span className="casting__secret">· 藏着秘密</span>}
                </div>
                <div className="casting__actors">
                  {members.map((id) => {
                    const takenBy = Object.entries(bindings).find(
                      ([k, v]) => v === id && k !== c.charId,
                    );
                    const contact = contactById(id);
                    return (
                      <button
                        key={id}
                        className={[
                          'casting__actor',
                          picked === id ? 'casting__actor--picked' : '',
                          takenBy && picked !== id ? 'casting__actor--taken' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() =>
                          // Picking someone already on stage SWAPS the roles —
                          // that is what the tap means, and it can never
                          // manufacture the duplicate the validator rejects.
                          setBindings((b) => assignRole(b, c.charId, id))
                        }
                      >
                        {contact ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Avatar size={16} color={contact.avatarColor} text={contact.avatarText} imageRef={contact.avatarRef} />
                            {nameOf(id)}
                          </span>
                        ) : (
                          nameOf(id)
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {issues.length > 0 && (
          <div className="casting__issues">
            {issues.map((i) => (
              <div key={`${i.code}-${i.charId ?? ''}`}>{i.message}</div>
            ))}
          </div>
        )}

        <button
          className="casting__start"
          disabled={!ready}
          onClick={() => stage && onStart(stage.id, bindings)}
        >
          {busy ? '开演中…' : '开演'}
        </button>
      </div>
    </Sheet>
  );
}
