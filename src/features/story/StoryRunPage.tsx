/**
 * 周目面板 (/story/run/:saveId, M-I7): one run's dashboard.
 *
 * Everything a playthrough accumulates, in one place:
 *  - where it stands (current幕, state, who plays whom);
 *  - the branch graph with the walked path drawn over it;
 *  - the timeline of past幕 with **任意幕回滚** — not just "back one";
 *  - the 存档槽 — named checkpoints the user deliberately keeps;
 *  - resume for a stalled run (STALL_NOTICE has promised this page since M-G0).
 *
 * Rollback here is the three-surface cascade (`rollbackTo`): memories, Moments
 * posts AND the transcript tail — trimmed by watermark, leaving rowid holes,
 * never touching a surviving row's timestamp. The toast reports the exact
 * counts because the cascade is the part the user has to be able to trust.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { showConfirm, showPrompt } from '../../components/dialog';
import { useAppStore } from '../../store/appStore';
import { useGuard } from '../../app/useGuard';
import {
  canRestoreSlot,
  collectRunTraces,
  dropSlot,
  getSave,
  getScript,
  planRollback,
  putSave,
  restoreSlot,
  rollbackTo,
  runOf,
  writeSlot,
  endRun,
  isStalled,
  type RollbackPlan,
  type RollbackResult,
  type RunTraces,
  type StorySaveRow,
} from '../../ai/story-gm';
import { latestMessageId, resumeRun } from '../../ai/story-service';
import { runStateLabel } from '../../ai/story-runs';
import { visitedNodeIds } from '../../ai/story-layout';
import type { Script } from '../../ai/story-script';
import { StoryGraph } from './StoryGraph';
import './story.css';
import '../settings/settings.css';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line summarizing what a rollback actually took back. */
export function rollbackSummary(r: RollbackResult): string {
  return `已回滚：撤销 ${r.memoryRemoved.length} 条记忆、${r.momentsRemoved.length} 条朋友圈、${r.messagesRemoved.length} 条消息`;
}

/**
 * The confirm dialog's body, from the dry-run (M-I7). Concrete on purpose:
 * agreeing to lose "3 条记忆" is different from agreeing to lose「那个雨夜的
 * 访客其实是旧识」— the preview names what the abstract count hides.
 */
export function rollbackConfirmBody(plan: RollbackPlan): string {
  const parts = [
    `将撤销 ${plan.memory.length} 条记忆、${plan.moments.length} 条朋友圈、${plan.messageCount} 条消息，无法恢复。`,
  ];
  if (plan.memory.length > 0) {
    const named = plan.memory.slice(0, 3).map((f) => `「${f.fact}」`);
    parts.push(`被撤销的记忆：${named.join('')}${plan.memory.length > 3 ? ' 等' : ''}`);
  }
  if (plan.slotsLost.length > 0) {
    parts.push(`存档槽「${plan.slotsLost.join('」「')}」在那之后，将失效。`);
  }
  if (!plan.trimsMessages) {
    parts.push('这段快照没有记录消息水位（旧存档），聊天记录会原样保留。');
  }
  return parts.join(' ');
}

/** `1小时23分` / `4分钟` — how long a run has been (or was) playing. */
export function fmtDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

export function StoryRunPage() {
  const { saveId } = useParams<{ saveId: string }>();
  const navigate = useNavigate();
  const guard = useGuard();
  const showToast = useAppStore((s) => s.showToast);
  const reloadConversation = useAppStore((s) => s.reloadConversation);
  const contactById = useAppStore((s) => s.contactById);
  const conversationById = useAppStore((s) => s.conversationById);

  const [save, setSave] = useState<StorySaveRow | null>(null);
  const [script, setScript] = useState<Script | null>(null);
  const [traces, setTraces] = useState<RunTraces | null>(null);
  const [missing, setMissing] = useState(false);

  const reload = useCallback(async () => {
    if (!saveId) return;
    const row = await getSave(saveId);
    if (!row) {
      setMissing(true);
      return;
    }
    setSave(row);
    setScript(await getScript(row.scriptId));
    setTraces(await collectRunTraces(row));
  }, [saveId]);

  useEffect(() => {
    guard('story.run.load', reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const visited = useMemo(() => (save ? visitedNodeIds(save) : undefined), [save]);
  const currentNode = useMemo(
    () => (script && save ? script.nodes.find((n) => n.id === save.nodeId) : undefined),
    [script, save],
  );

  const nameOf = (id: string) => {
    const c = contactById(id);
    return c?.remark ?? c?.name ?? id;
  };

  /** Shared tail of every rollback path: refresh store + this page, report. */
  const afterRollback = async (convId: string, r: RollbackResult) => {
    await reloadConversation(convId);
    await reload();
    showToast(rollbackSummary(r));
  };

  const rollbackToSeq = (targetSeq: number) =>
    guard('story.rollback', async () => {
      if (!save) return;
      // Dry-run first: the dialog states EXACTLY what dies, from the same
      // query the deletion will run — preview and execution cannot disagree.
      const plan = await planRollback(save, targetSeq);
      const ok = await showConfirm({
        title: `回到第 ${plan.restoredSeq} 幕？`,
        body: rollbackConfirmBody(plan),
        confirmText: '回滚',
        danger: true,
      });
      if (!ok) return;
      const r = await rollbackTo(save, targetSeq, Date.now());
      await afterRollback(save.convId, r);
    });

  const onResume = () =>
    guard('story.resume', async () => {
      if (!save) return;
      const resumed = await resumeRun(save.id, Date.now());
      if (resumed) {
        await reload();
        showToast('剧情已继续，下一幕马上开演');
      }
    });

  const onEnd = () =>
    guard('story.end', async () => {
      if (!save) return;
      const ok = await showConfirm({
        title: '结束这一轮？',
        body: '这一周目会归档为「已中止」，不会解锁结局。已发生的剧情保留。',
        confirmText: '结束',
        danger: true,
      });
      if (!ok) return;
      await endRun(save, Date.now());
      await reload();
    });

  const onSaveSlot = () =>
    guard('story.slot.save', async () => {
      if (!save) return;
      const name = await showPrompt({
        title: '存档当前进度',
        placeholder: `例：第 ${save.seq} 幕，摊牌之前`,
        maxLength: 20,
        allowEmpty: true,
      });
      if (name == null) return;
      const cursor = await latestMessageId(save.convId);
      const { save: next, slot } = writeSlot(save, name, cursor, Date.now());
      await putSave(next);
      setSave(next);
      showToast(`已存档「${slot.name}」`);
    });

  const onRestoreSlot = (slotId: string) =>
    guard('story.slot.restore', async () => {
      if (!save) return;
      const slot = (save.slots ?? []).find((s) => s.id === slotId);
      if (!slot) return;
      const plan = await planRollback(save, slot.seq);
      const ok = await showConfirm({
        title: `读档「${slot.name}」？`,
        body: `回到第 ${slot.seq} 幕。${rollbackConfirmBody(plan)}`,
        confirmText: '读档',
        danger: true,
      });
      if (!ok) return;
      const r = await restoreSlot(save, slotId, Date.now());
      if ('error' in r) {
        showToast(r.error);
        return;
      }
      await afterRollback(save.convId, r);
    });

  const onDropSlot = (slotId: string) =>
    guard('story.slot.drop', async () => {
      if (!save) return;
      const ok = await showConfirm({ title: '删除这个存档槽？', confirmText: '删除', danger: true });
      if (!ok) return;
      const next = dropSlot(save, slotId, Date.now());
      await putSave(next);
      setSave(next);
    });

  if (missing) {
    return (
      <>
        <SubNav title="剧情周目" />
        <div className="page-body settings">
          <p className="settings__hint">这个周目的存档不见了——可能已被删除。</p>
        </div>
      </>
    );
  }
  if (!save || !script) {
    return (
      <>
        <SubNav title="剧情周目" />
        <div className="page-body settings" />
      </>
    );
  }

  const stalled = isStalled(save);
  const stage = conversationById(save.convId);
  const slots = save.slots ?? [];
  const timeline = [...save.history];

  return (
    <>
      <SubNav title={`第 ${runOf(save)} 周目`} />
      <div className="page-body story">
        <div className="run-head">
          <div className="run-head__title">
            《{script.title}》
            <span
              className={`story-chip${
                save.isActive ? (stalled ? ' story-chip--paused' : ' story-chip--live') : ''
              }`}
            >
              {runStateLabel(save)}
            </span>
          </div>
          <div className="run-head__sub">
            第 {save.seq} 幕 · {currentNode ? currentNode.goal : '（当前节点已不在剧本里）'}
            {save.endingId && (
              <>
                <br />
                结局：{script.nodes.find((n) => n.id === save.endingId)?.goal ?? save.endingId}
              </>
            )}
            <br />
            舞台：{stage?.title ?? save.convId}
          </div>
          <div className="run-head__actions">
            <button className="run-btn" onClick={() => navigate(`/chat/${save.convId}`)}>
              去群里看
            </button>
            {save.isActive && stalled && (
              <button className="run-btn run-btn--primary" onClick={onResume}>
                继续剧情
              </button>
            )}
            {save.isActive && (
              <button className="run-btn run-btn--danger" onClick={onEnd}>
                结束这一轮
              </button>
            )}
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">这一轮的班底</div>
          <div className="cast-board">
            {script.cast.map((c) => {
              const actorId = save.bindings[c.charId];
              const contact = actorId ? contactById(actorId) : undefined;
              return (
                <button
                  className="cast-board__cell"
                  key={c.charId}
                  disabled={!contact}
                  onClick={() => contact && navigate(`/contact/${contact.id}`)}
                >
                  {contact ? (
                    <Avatar
                      size={40}
                      color={contact.avatarColor}
                      text={contact.avatarText}
                      imageRef={contact.avatarRef}
                    />
                  ) : (
                    <span className="cast-board__hole">?</span>
                  )}
                  <span className="cast-board__name">
                    {contact ? (contact.remark ?? contact.name) : '未绑定'}
                  </span>
                  <span className="cast-board__role">
                    {c.role}
                    {c.secret ? ' ·有秘密' : ''}
                  </span>
                </button>
              );
            })}
          </div>
          <div
            className="settings__row"
            onClick={() => navigate(`/story/script/${save.scriptId}`)}
          >
            <span className="settings__label">剧本详情与结局画廊</span>
            <span className="settings__chevron" />
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">分支图 · 走过的路</div>
          <StoryGraph script={script} currentId={save.nodeId} visited={visited} />
        </div>

        {Object.keys(save.vars).length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">剧情变量（触发条件读的就是它们）</div>
            <div className="vars">
              {Object.entries(save.vars).map(([k, v]) => (
                <span className="vars__chip" key={k}>
                  {k} = {String(v)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="settings__group">
          <div className="settings__group-title">时间线（点任意一幕回滚）</div>
          <div className="timeline">
            {timeline.length === 0 && (
              <div className="timeline__item">
                <span className="timeline__dot" />
                <div className="timeline__body">
                  <div className="timeline__meta">还没走过任何分支——第一幕还在演。</div>
                </div>
              </div>
            )}
            {timeline.map((h) => {
              const node = script.nodes.find((n) => n.id === h.nodeId);
              return (
                <div className="timeline__item" key={h.seq}>
                  <span className="timeline__dot" />
                  <div className="timeline__body">
                    <div className="timeline__title">
                      第 {h.seq} 幕 · {node?.goal ?? h.nodeId}
                    </div>
                    <div className="timeline__meta">{fmtTime(h.at)}</div>
                  </div>
                  <button className="memory__btn" onClick={() => rollbackToSeq(h.seq)}>
                    回到这幕
                  </button>
                </div>
              );
            })}
            <div className="timeline__item timeline__item--current">
              <span className="timeline__dot" />
              <div className="timeline__body">
                <div className="timeline__title">
                  第 {save.seq} 幕 · {currentNode?.goal ?? save.nodeId}（现在）
                </div>
                <div className="timeline__meta">{fmtTime(save.updatedAt)}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">存档槽（{slots.length}）</div>
          {slots.map((s) => (
            <div className="slot-row" key={s.id}>
              <div className="slot-row__body">
                <div className="slot-row__name">{s.name}</div>
                <div className="slot-row__meta">
                  第 {s.seq} 幕 · {fmtTime(s.at)}
                  {!canRestoreSlot(save, s) && ' · 已失效'}
                </div>
              </div>
              <button
                className="memory__btn"
                disabled={!canRestoreSlot(save, s)}
                onClick={() => onRestoreSlot(s.id)}
              >
                读档
              </button>
              <button className="memory__btn memory__btn--danger" onClick={() => onDropSlot(s.id)}>
                删除
              </button>
            </div>
          ))}
          {save.isActive && (
            <div className="settings__actions" style={{ padding: '10px 16px' }}>
              <button className="settings__btn" onClick={onSaveSlot}>
                存档当前进度
              </button>
            </div>
          )}
          {slots.length === 0 && !save.isActive && (
            <p className="settings__hint" style={{ padding: '8px 16px' }}>
              这一轮没有留下存档槽。
            </p>
          )}
        </div>

        {traces && (
          <div className="settings__group">
            <div className="settings__group-title">这一轮的痕迹</div>
            <div className="run-stats">
              <div className="run-stats__cell">
                <div className="run-stats__num">{save.seq}</div>
                <div className="run-stats__label">幕</div>
              </div>
              <div className="run-stats__cell">
                <div className="run-stats__num">{traces.messageCount}</div>
                <div className="run-stats__label">剧情消息</div>
              </div>
              <div className="run-stats__cell">
                <div className="run-stats__num">{traces.facts.length}</div>
                <div className="run-stats__label">写进记忆</div>
              </div>
              <div className="run-stats__cell">
                <div className="run-stats__num">{traces.moments.length}</div>
                <div className="run-stats__label">朋友圈</div>
              </div>
              <div className="run-stats__cell">
                <div className="run-stats__num">
                  {fmtDuration((save.endedAt ?? save.updatedAt) - save.createdAt)}
                </div>
                <div className="run-stats__label">{save.isActive ? '已演' : '共演'}</div>
              </div>
            </div>
            {traces.facts.length > 0 && (
              <div className="run-traces">
                {traces.facts.slice(0, 5).map((f) => (
                  <div className="run-traces__row" key={f.id}>
                    <span className="run-traces__who">{nameOf(f.subjectId)} 记住了</span>
                    {f.fact}
                  </div>
                ))}
                {traces.facts.length > 5 && (
                  <div className="run-traces__row run-traces__row--more">
                    还有 {traces.facts.length - 5} 条……
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <p className="settings__hint">
          回滚会连同之后的对话、记忆和朋友圈一起撤销——消息按水位裁剪，行号留洞、
          时间戳不动。存档槽是你亲手留下的检查点：读档等于回滚到那一幕，回滚过头会让
          更晚的槽位失效。
        </p>
      </div>
    </>
  );
}
