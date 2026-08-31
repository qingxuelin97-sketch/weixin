/**
 * 剧本详情 (/story/script/:scriptId, M-I7).
 *
 * The page where a script stops being a row in a list: the full branch graph
 * (tap a node to inspect it), the cast with their secret markers, the 结局画廊
 * with locked endings shown as ？？？, every 周目 played so far, and the start
 * button that opens the casting sheet — explicit stage + 角色→persona mapping,
 * replacing the old "stages[0] + array order" pair of silent decisions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { showConfirm } from '../../components/dialog';
import { useAppStore } from '../../store/appStore';
import { useGuard } from '../../app/useGuard';
import {
  deleteScript,
  getScript,
  listSaves,
  listScripts,
  makeSave,
  missingBindings,
  putSave,
  runOf,
  type StoryScriptRow,
  type StorySaveRow,
} from '../../ai/story-gm';
import { scheduleNextBeat, tickMsFor, STORY_TICK_ACTIVE_MS } from '../../ai/story-service';
import {
  carriedVars,
  galleryFor,
  gallerySummary,
  legacyOf,
  nextRunNumber,
  runsOf,
  runStateLabel,
} from '../../ai/story-runs';
import { globalTier } from '../../lib/nsfw-tier';
import { describeWhen, type Script } from '../../ai/story-script';
import { StoryGraph } from './StoryGraph';
import { CastingSheet } from './CastingSheet';
import './story.css';
import '../settings/settings.css';

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function ScriptDetailPage() {
  const { scriptId } = useParams<{ scriptId: string }>();
  const navigate = useNavigate();
  const guard = useGuard();
  const showToast = useAppStore((s) => s.showToast);

  const [script, setScript] = useState<Script | null>(null);
  const [row, setRow] = useState<StoryScriptRow | null>(null);
  const [saves, setSaves] = useState<StorySaveRow[]>([]);
  const [casting, setCasting] = useState(false);
  const [starting, setStarting] = useState(false);
  /** NG+ (V4): the next start inherits the last finished run's outcome. */
  const [ngWanted, setNgWanted] = useState(false);

  const reload = useCallback(async () => {
    if (!scriptId) return;
    const [s, rows, allSaves] = await Promise.all([
      getScript(scriptId),
      listScripts(),
      listSaves(scriptId),
    ]);
    setScript(s);
    setRow(rows.find((r) => r.id === scriptId) ?? null);
    setSaves(allSaves);
  }, [scriptId]);

  useEffect(() => {
    guard('story.script.load', reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const gallery = useMemo(() => (script ? galleryFor(script, saves) : []), [script, saves]);
  const runs = useMemo(
    () => (script ? runsOf(saves, script.scriptId) : []),
    [script, saves],
  );
  const liveRun = runs.find((r) => r.isActive);
  /** What a finished run left behind — the NG+ entry exists exactly when this does. */
  const legacy = useMemo(
    () => (script ? legacyOf(saves, script.scriptId) : undefined),
    [script, saves],
  );

  const start = (convId: string, bindings: Record<string, string>) =>
    guard('story.start', async () => {
      if (!script || starting) return;
      setStarting(true);
      try {
        // Belt and braces: the sheet disables 开演 until every role has a
        // distinct in-group actor, but an unbound role would still strand the
        // run at its first beat — so the engine-side check runs regardless.
        const missing = missingBindings(script, bindings);
        if (missing.length) {
          showToast(`选角没配齐：还差 ${missing.length} 个角色`);
          return;
        }
        const now = Date.now();
        // NG+ (V4): the whitelist gate lives HERE — only `legacy.carry` vars
        // survive into the new run, and the GM gets the ending for its opening.
        const inherit =
          ngWanted && legacy
            ? {
                fromRun: legacy.run,
                endingId: legacy.endingId,
                vars: carriedVars(script, legacy.vars),
              }
            : undefined;
        const save = makeSave({
          script,
          convId,
          bindings,
          globalTier: await globalTier(),
          now,
          run: nextRunNumber(saves, script.scriptId),
          inherit,
        });
        await putSave(save);
        // Tick 1 opens the chain; every later tick is queued by `chainNextBeat`
        // before its beat runs, so a failed beat retries instead of dying.
        // Active cadence for the opener (V4): the person who just pressed 开演
        // is on their way to the chat — the curtain should not take 45s.
        await scheduleNextBeat(save, now, 1, tickMsFor(save, script, true) ?? STORY_TICK_ACTIVE_MS);
        setCasting(false);
        setNgWanted(false);
        await reload();
        showToast(
          `《${script.title}》第 ${runOf(save)} 周目${inherit ? '（NG+ 继承）' : ''}开演，去聊天里看`,
        );
      } finally {
        setStarting(false);
      }
    });

  const onDelete = () =>
    guard('story.delete', async () => {
      if (!script || !row) return;
      const ok = await showConfirm({
        title: `删除《${script.title}》？`,
        body: runs.length ? '它的周目存档会失去剧本，无法继续或回滚。' : undefined,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      await deleteScript(script.scriptId);
      navigate(-1);
    });

  if (!script) {
    return (
      <>
        <SubNav title="剧本" />
        <div className="page-body settings">
          <p className="settings__hint">这个剧本读不出来——可能已被删除或已损坏。</p>
        </div>
      </>
    );
  }

  return (
    <>
      <SubNav
        title={script.title}
        right={
          row?.origin !== 'builtin' ? (
            <button className="memory__btn memory__btn--danger" onClick={onDelete}>
              删除
            </button>
          ) : undefined
        }
      />
      <div className="page-body story">
        <div className="run-head">
          <div className="run-head__title">
            《{script.title}》
            {script.genre && <span className="story-chip">{script.genre}</span>}
            {script.nsfwLevel > 0 && <span className="story-chip story-chip--adult">18+</span>}
          </div>
          <div className="run-head__sub">
            {script.cast.length} 个角色 · {script.nodes.length} 幕 ·{' '}
            {gallerySummary(gallery)}
            {row?.origin === 'builtin' && ' · 内置示例'}
            {row?.origin === 'generated' && ' · AI 生成'}
          </div>
          <div className="run-head__actions">
            {liveRun ? (
              <button
                className="run-btn run-btn--primary"
                onClick={() => navigate(`/story/run/${liveRun.id}`)}
              >
                第 {runOf(liveRun)} 周目进行中 · 去看
              </button>
            ) : (
              <>
                <button
                  className="run-btn run-btn--primary"
                  onClick={() => {
                    setNgWanted(false);
                    setCasting(true);
                  }}
                >
                  {runs.length > 0 ? `开启第 ${nextRunNumber(saves, script.scriptId)} 周目` : '开演'}
                </button>
                {legacy && (
                  <button
                    className="run-btn"
                    onClick={() => {
                      setNgWanted(true);
                      setCasting(true);
                    }}
                  >
                    NG+ 继承开局
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">分支图（点一幕看详情）</div>
          <StoryGraph script={script} />
        </div>

        <div className="settings__group">
          <div className="settings__group-title">分幕（出口条件，不含角色指令——不剧透）</div>
          <div className="beats">
            {script.nodes.map((n) => (
              <div className="beats__row" key={n.id}>
                <div className="beats__head">
                  <span className="beats__id">{n.id}</span>
                  {n.id === script.entry && <span className="story-chip">开场</span>}
                  {n.choice && <span className="story-chip">抉择</span>}
                  {n.ending && <span className="story-chip story-chip--live">结局</span>}
                  {(n.nsfwLevel ?? 0) > 0 && (
                    <span className="story-chip story-chip--adult">18+</span>
                  )}
                </div>
                <div className="beats__goal">{n.goal}</div>
                {(n.triggers.length > 0 || n.timeout || n.choice) && (
                  <div className="beats__exits">
                    {n.triggers.map((t, i) => (
                      <div className="beats__exit" key={i}>
                        {describeWhen(t.when)} → {t.to}
                      </div>
                    ))}
                    {(n.choice?.options ?? []).map((o, i) => (
                      <div className="beats__exit" key={`c${i}`}>
                        你选「{o.label}」 → {o.goto}
                      </div>
                    ))}
                    {n.timeout && (
                      <div className="beats__exit beats__exit--timeout">
                        {n.timeout.turns} 轮没推进 → {n.timeout.to}
                      </div>
                    )}
                  </div>
                )}
                {n.directives.length > 0 && (
                  <div className="beats__meta">
                    {n.directives.length} 条角色指令（开演后各自只见自己那条）
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">角色</div>
          {script.cast.map((c) => (
            <div className="cast-row" key={c.charId}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cast-row__role">{c.role}</div>
                <div className="cast-row__hint">
                  {c.secret ? '藏着一个秘密（只有开演后的扮演者知道）' : '没有秘密'}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="settings__group">
          <div className="settings__group-title">结局画廊</div>
          <div className="gallery">
            {gallery.map((g) => (
              <div
                className={`gallery__item ${g.unlocked ? 'gallery__item--unlocked' : 'gallery__item--locked'}`}
                key={g.node.id}
              >
                <span className="gallery__medal">{g.unlocked ? '终' : '?'}</span>
                <div className="gallery__body">
                  <div className="gallery__goal">{g.unlocked ? g.node.goal : '？？？'}</div>
                  <div className="gallery__meta">
                    {g.unlocked
                      ? g.reachedBy
                          .map((r) => `第 ${r.run} 周目 · ${fmtDate(r.at)}`)
                          .join('；')
                      : '还没有哪个周目走到这里'}
                  </div>
                </div>
              </div>
            ))}
            {gallery.length === 0 && (
              <p className="settings__hint" style={{ padding: '8px 16px' }}>
                这个剧本没有结局节点——校验应该拦住它才对。
              </p>
            )}
          </div>
          {/* NG+ 入口 (V4): unlocked the moment ANY run finishes with a real
              ending. It rides the same casting flow — only the vars differ. */}
          {legacy && !liveRun && (
            <div
              className="settings__row settings__row--divided"
              onClick={() => {
                setNgWanted(true);
                setCasting(true);
              }}
            >
              <span className="settings__label">NG+ · 继承上周目</span>
              <span className="settings__value">
                第 {legacy.run} 周目的结局
                {(script.legacy?.carry?.length ?? 0) > 0
                  ? `与 ${script.legacy!.carry.length} 个变量`
                  : ''}
                会带进新档
              </span>
              <span className="settings__chevron" />
            </div>
          )}
        </div>

        <div className="settings__group">
          <button
            className="settings__row settings__row--divided"
            style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none' }}
            onClick={() =>
              guard('story.export', async () => {
                // Clipboard, not a download: <a download> is unreliable inside
                // the Capacitor WebView, and the JSON's whole job is to be
                // pasted into a note or re-imported on another device anyway.
                await navigator.clipboard.writeText(JSON.stringify(script, null, 2));
                showToast('剧本 JSON 已复制，可以存起来或分享');
              })
            }
          >
            <span className="settings__label">导出剧本 JSON</span>
            <span className="settings__value">复制到剪贴板</span>
          </button>
        </div>

        {runs.length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">周目（{runs.length}）</div>
            {runs.map((r) => (
              <button
                className="story-run-row"
                key={r.id}
                style={{ width: '100%', textAlign: 'left', border: 'none' }}
                onClick={() => navigate(`/story/run/${r.id}`)}
              >
                <div className="story-run-row__body">
                  <div className="story-run-row__title">
                    第 {runOf(r)} 周目 · 第 {r.seq} 幕
                  </div>
                  <div className="story-run-row__meta">
                    {runStateLabel(r)}
                    {r.endingId &&
                      ` · ${script.nodes.find((n) => n.id === r.endingId)?.goal ?? r.endingId}`}
                  </div>
                </div>
                <span className="settings__chevron" />
              </button>
            ))}
          </div>
        )}

        <p className="settings__hint">
          每个周目独立记账：回滚只撤销自己那一轮写下的记忆和朋友圈，绝不碰上一周目的。
          解锁全部结局需要在不同的选择上多开几轮。
        </p>
      </div>

      <CastingSheet
        script={script}
        open={casting}
        busy={starting}
        onClose={() => {
          setCasting(false);
          setNgWanted(false);
        }}
        onStart={start}
      />
    </>
  );
}
