/**
 * 「她的状态」(M-I14) — the visible face of everything the simulation knows
 * about an agent right now: the long-term goal and its milestones, the
 * emotional pulse on top of the day's mood, the current lifeline arcs, and the
 * bounded personality drift *with its reasons*.
 *
 * Everything here is read-only and derived: the pure functions (goals /
 * lifeline / mood / drift) run on the live clock, and the only async read is
 * the affect pulse (a settings row). No LLM, no network.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { useNow } from '../../lib/useNow';
import { agentEpoch, goalStateAt, type GoalState } from '../../ai/goals';
import {
  goalStateFor,
  ensureGoalTemplates,
  renameCurrentGoal,
  abandonCurrentGoal,
} from '../../ai/goal-service';
import { showPrompt, showConfirm } from '../../components/dialog';
import { lifelineAt, type ArcState } from '../../ai/lifeline';
import { getDrift, explainDrift, type DriftExplanation } from '../../ai/drift';
import { moodOf } from '../../lib/mood';
import { getAffect, affectLine, type AffectState } from '../../lib/affect';
import './status.css';

const ARC_DOMAIN_LABELS: Record<ArcState['domain'], string> = {
  work: '工作',
  family: '家里',
  health: '身体',
  project: '折腾的小事',
  social: '朋友圈子',
};

const GOAL_STATUS_LABELS: Record<GoalState['status'], string> = {
  active: '进行中',
  completed: '已达成',
  abandoned: '已放下',
};

function fmtDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function StatusPage() {
  const { contactId = '' } = useParams();
  const contact = useAppStore((s) => s.contactById(contactId));
  const persona = useAppStore((s) => s.personaFor(contactId));
  const now = useNow();

  // The affect pulse and the drift ledger are the two stored inputs; read
  // them once per minute tick. Drift here is the MAIN drift system (M-H1,
  // event-driven and bounded), the same one the persona editor explains —
  // and since M-I18 `getDrift` layers the unstored goal linkage on top, which
  // is where the per-dimension `reason` below comes from.
  const [affect, setAffect] = useState<AffectState | null>(null);
  const [drifted, setDrifted] = useState<DriftExplanation[]>([]);
  // Goal state now reads through goal-service (M-J1): per-persona generated
  // templates + the user's own renames/abandons. The sync seeded derivation
  // below stays as the first-paint fallback.
  const [liveGoal, setLiveGoal] = useState<GoalState | null>(null);
  const [goalRev, setGoalRev] = useState(0);
  useEffect(() => {
    let alive = true;
    void getAffect(contactId, now)
      .then((a) => {
        if (alive) setAffect(a);
      })
      .catch(() => {});
    void getDrift(contactId, now)
      .then((d) => {
        if (alive) setDrifted(explainDrift(d));
      })
      .catch(() => {});
    void goalStateFor(contactId, now)
      .then((g) => {
        if (alive) setLiveGoal(g);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [contactId, now, goalRev]);

  // 目标模板按人设生成，一辈子一次（M-J1）。The page a user opens to look at
  // her life is the honest moment to spend that one call; failure silently
  // keeps the built-in templates — 不许空目标.
  const personaCore = persona?.core;
  const personaStyle = persona?.speechStyle;
  useEffect(() => {
    if (!personaCore) return;
    void ensureGoalTemplates(contactId, { core: personaCore, speechStyle: personaStyle })
      .then((generated) => {
        if (generated) setGoalRev((r) => r + 1);
      })
      .catch(() => {});
  }, [contactId, personaCore, personaStyle]);

  if (!contact || contact.type !== 'ai' || !persona) {
    return (
      <>
        <SubNav title="她的状态" />
        <div className="page-body status">
          <p className="settings__hint">这个联系人没有可展示的状态</p>
        </div>
      </>
    );
  }

  const epoch = agentEpoch(contactId);
  const goal = liveGoal ?? goalStateAt(contactId, now, epoch);
  const arcs = lifelineAt({ contactId }, now, epoch);
  const mood = moodOf(contactId, now);
  const name = contact.remark ?? contact.name;

  const editTitle = async () => {
    const title = await showPrompt({
      title: '改个说法',
      body: '她自己会怎么叫这个目标？（只改叫法，不改进度）',
      initial: goal.title,
      placeholder: '2~24 字',
    });
    if (title == null || !title.trim()) return;
    await renameCurrentGoal(contactId, now, title);
    setGoalRev((r) => r + 1);
  };

  const dropGoal = async () => {
    const ok = await showConfirm({
      title: '让她放下这个目标？',
      body: `「${goal.title}」会就此搁置，她过阵子自然会有下一件事。`,
      confirmText: '放下',
      cancelText: '再想想',
      danger: true,
    });
    if (!ok) return;
    await abandonCurrentGoal(contactId, now);
    setGoalRev((r) => r + 1);
  };

  return (
    <>
      <SubNav title="她的状态" />
      <div className="page-body status">
        <div className="status__head">
          <Avatar color={contact.avatarColor} text={contact.avatarText} imageRef={contact.avatarRef} size={48} />
          <div className="status__head-id">
            <div className="status__name">{name}</div>
            <div className="status__summary">
              {drifted.length ? '相处久了，她有些变化' : '状态稳定'}
            </div>
          </div>
        </div>

        <GoalCard goal={goal} now={now} onRename={editTitle} onAbandon={dropGoal} />
        <MoodCard moodLine={mood.line} affect={affect} />
        <LifelineCard arcs={arcs} />
        <DriftCard drifted={drifted} />

        <p className="status__footnote">
          以上全部由本地模拟推导，随时间自己演化——不产生任何网络请求。
        </p>
      </div>
    </>
  );
}

/* ==================================================================== */

function GoalCard({
  goal,
  now,
  onRename,
  onAbandon,
}: {
  goal: GoalState;
  now: number;
  onRename: () => void;
  onAbandon: () => void;
}) {
  const pct = Math.round(goal.progress * 100);
  const ended = goal.status !== 'active';
  return (
    <div className="status__card">
      <div className="status__card-title">
        当前目标
        <span className={`status__badge status__badge--${goal.status}`}>
          {GOAL_STATUS_LABELS[goal.status]}
        </span>
        {!ended && (
          <span className="status__goal-actions">
            <button className="status__goal-btn" onClick={onRename}>
              改标题
            </button>
            <button className="status__goal-btn status__goal-btn--drop" onClick={onAbandon}>
              放弃
            </button>
          </span>
        )}
      </div>
      <div className="status__goal-name">「{goal.title}」</div>
      <div className="status__goal-stage">
        {ended
          ? goal.status === 'completed'
            ? `${goal.endedAt ? fmtDay(goal.endedAt) : ''} 达成，正在歇口气`
            : `${goal.endedAt ? fmtDay(goal.endedAt) : ''} 放下了，先缓一缓`
          : goal.stage}
      </div>
      <div className="status__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`status__bar-fill${goal.status === 'abandoned' ? ' status__bar-fill--stalled' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="status__bar-meta">
        <span>{fmtDay(goal.startedAt)} 开始</span>
        <span>{pct}%</span>
      </div>

      <div className="status__milestones">
        {goal.milestones.map((m, i) => (
          <div key={i} className={`status__milestone${m.reached ? ' status__milestone--done' : ''}`}>
            <span className="status__milestone-dot" />
            <span className="status__milestone-text">
              {m.reached ? m.text : '……还没走到'}
            </span>
            {m.reached && <span className="status__milestone-date">{fmtDay(m.at)}</span>}
          </div>
        ))}
      </div>

      {goal.recentSetback && now - goal.recentSetback.at < 10 * 86_400_000 && (
        <div className="status__setback">最近的挫折：{goal.recentSetback.text}</div>
      )}
    </div>
  );
}

function MoodCard({ moodLine, affect }: { moodLine: string; affect: AffectState | null }) {
  const v = affect?.valence ?? 0;
  const a = affect?.arousal ?? 0;
  return (
    <div className="status__card">
      <div className="status__card-title">情绪脉冲</div>
      <div className="status__mood-line">{affect ? affectLine(moodLine, affect) : moodLine}</div>
      <CenteredMeter label="心情" value={v} left="低落" right="愉快" />
      <CenteredMeter label="起伏" value={a} left="平静" right="上头" />
    </div>
  );
}

function LifelineCard({ arcs }: { arcs: ArcState[] }) {
  return (
    <div className="status__card">
      <div className="status__card-title">生活线</div>
      {arcs.map((arc, i) => (
        <div key={i} className="status__arc">
          <div className="status__arc-head">
            <span className="status__arc-domain">{ARC_DOMAIN_LABELS[arc.domain]}</span>
            <span className="status__arc-stage">{arc.stage}</span>
          </div>
          <div className="status__bar status__bar--thin">
            <div className="status__bar-fill" style={{ width: `${Math.round(arc.progress * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DriftCard({ drifted }: { drifted: DriftExplanation[] }) {
  return (
    <div className="status__card">
      <div className="status__card-title">最近的变化</div>
      {drifted.length === 0 && <div className="status__dim-reason">和刚认识时差不多</div>}
      {drifted.map((d) => (
        <div key={d.dim} className="status__dim">
          <CenteredMeter label={d.label} value={d.delta} left="−" right="+" />
          {/* Why, when there is a why: a goal she just finished or gave up on
              (M-I14/I18). "她变了，不知道为什么" is a bug you cannot file. */}
          {d.reason && <div className="status__dim-reason">{d.reason}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * A centered ±1 meter: zero in the middle, positive fills right in brand
 * green, negative fills left in the warning orange. CSS transitions only.
 */
function CenteredMeter({
  label,
  value,
  left,
  right,
}: {
  label: string;
  value: number;
  left: string;
  right: string;
}) {
  const clamped = Math.max(-1, Math.min(1, value));
  const halfPct = Math.round(Math.abs(clamped) * 50);
  return (
    <div className="status__meter">
      <span className="status__meter-label">{label}</span>
      <span className="status__meter-end">{left}</span>
      <div className="status__meter-track">
        <div className="status__meter-zero" />
        <div
          className={`status__meter-fill${clamped < 0 ? ' status__meter-fill--neg' : ''}`}
          style={
            clamped < 0
              ? { right: '50%', width: `${halfPct}%` }
              : { left: '50%', width: `${halfPct}%` }
          }
        />
      </div>
      <span className="status__meter-end">{right}</span>
    </div>
  );
}
