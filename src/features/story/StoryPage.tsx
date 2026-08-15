/**
 * 剧情模式 library (/story, M-I7 rebuild).
 *
 * The 223-line M-E5 page did everything in one screen and decided too much on
 * its own (stage = stages[0], cast = array order, rollback = one幕 only). V3
 * splits it three ways:
 *
 *   /story                 — this page: sources (generate / import / builtin)
 *                            plus every run in progress, at a glance
 *   /story/script/:id      — one script: graph, cast, 结局画廊, 周目, 开演
 *   /story/run/:saveId     — one run: walked path, timeline, 任意幕回滚, 存档槽
 *
 * Starting a run moved to the script page behind the casting sheet — the two
 * silent decisions became explicit choices there.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { showPrompt } from '../../components/dialog';
import { useGuard } from '../../app/useGuard';
import {
  listSaves,
  listScripts,
  runOf,
  saveScript,
  type StoryScriptRow,
  type StorySaveRow,
} from '../../ai/story-gm';
import { seedBuiltinScripts } from '../../ai/story-service';
import { generateScript, routerDeps, tierForPremise } from '../../ai/story-generate';
import { galleryFor, gallerySummary, runStateLabel } from '../../ai/story-runs';
import { getRouter } from '../../llm/service';
import { globalTier } from '../../lib/nsfw-tier';
import { ScriptSchema, type Script } from '../../ai/story-script';
import './story.css';
import '../settings/settings.css';

export function StoryPage() {
  const guard = useGuard();
  const navigate = useNavigate();

  const [scripts, setScripts] = useState<StoryScriptRow[]>([]);
  const [saves, setSaves] = useState<StorySaveRow[]>([]);
  const [premise, setPremise] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    await seedBuiltinScripts(Date.now());
    setScripts(await listScripts());
    setSaves(await listSaves());
  }, []);

  useEffect(() => {
    guard('story.load', reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titleOf = useMemo(() => {
    const m = new Map(scripts.map((s) => [s.id, s.title]));
    return (scriptId: string) => m.get(scriptId) ?? scriptId;
  }, [scripts]);

  /**
   * `1/2 结局已解锁` per script row. Parsed straight from the stored dagJson —
   * every row went through `validateScript` on the way in, so a parse failure
   * here means a corrupted row, and the summary simply goes quiet for it.
   */
  const endingsOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of scripts) {
      try {
        const parsed = ScriptSchema.safeParse(JSON.parse(row.dagJson));
        if (parsed.success) m.set(row.id, gallerySummary(galleryFor(parsed.data, saves)));
      } catch {
        /* corrupted row: no summary beats a crashed library */
      }
    }
    return m;
  }, [scripts, saves]);

  const liveRuns = saves.filter((s) => s.isActive);
  const endedRuns = saves.filter((s) => !s.isActive);
  /** How many playthroughs each script has, for the list row's meta line. */
  const runCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of saves) m.set(s.scriptId, (m.get(s.scriptId) ?? 0) + 1);
    return m;
  }, [saves]);

  const generate = async () => {
    if (!premise.trim() || busy) return;
    setBusy(true);
    setStatus('正在写大纲…');
    try {
      const tier = tierForPremise(premise, await globalTier());
      const router = await getRouter();
      setStatus('正在生成剧本结构…');
      const r = await generateScript(premise, routerDeps(router, tier, 'story:gen'), Date.now());
      if (!r.ok || !r.script) {
        // Named plainly rather than stored broken: a script that cannot run
        // strands the user three scenes in.
        setStatus(r.error ?? '生成失败');
        return;
      }
      const saved = await saveScript(r.script as Script, 'generated', Date.now());
      setStatus(
        saved.ok
          ? `已生成《${r.script.title}》${r.attempts.length ? `（自修复 ${r.attempts.length} 次）` : ''}`
          : `校验失败：${saved.issues.join('；')}`,
      );
      await reload();
      if (saved.ok) navigate(`/story/script/${saved.id}`);
    } finally {
      setBusy(false);
    }
  };

  const importJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () =>
      guard('story.import', async () => {
        const r = await saveScript(JSON.parse(String(reader.result)), 'import', Date.now());
        setStatus(r.ok ? '导入成功' : `导入失败：${r.issues.join('；')}`);
        await reload();
        if (r.ok) navigate(`/story/script/${r.id}`);
      });
    reader.onerror = () => setStatus('读取文件失败');
    reader.readAsText(f);
  };

  return (
    <>
      <SubNav title="剧情模式" />
      <div className="page-body story">
        {liveRuns.length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">进行中（{liveRuns.length}）</div>
            {liveRuns.map((sv) => (
              <button
                className="story-run-row"
                key={sv.id}
                style={{ width: '100%', textAlign: 'left', border: 'none' }}
                onClick={() => navigate(`/story/run/${sv.id}`)}
              >
                <div className="story-run-row__body">
                  <div className="story-run-row__title">
                    《{titleOf(sv.scriptId)}》第 {runOf(sv)} 周目
                  </div>
                  <div className="story-run-row__meta">第 {sv.seq} 幕</div>
                </div>
                <span
                  className={`story-chip ${sv.stalledAt ? 'story-chip--paused' : 'story-chip--live'}`}
                >
                  {runStateLabel(sv)}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="settings__group">
          <div className="settings__group-title">一句话生成</div>
          <div className="field">
            <input
              className="field__input"
              placeholder="例：两个老朋友在雨夜重逢，其中一个隐瞒了什么"
              value={premise}
              onChange={(e) => setPremise(e.target.value.slice(0, 100))}
            />
          </div>
          <button
            className="btn-primary"
            disabled={busy || !premise.trim()}
            onClick={() => guard('story.generate', generate)}
          >
            {busy ? '生成中…' : '生成剧本'}
          </button>
          {status && <p className="settings__hint">{status}</p>}
        </div>

        <div className="settings__group">
          <div className="settings__group-title">剧本（{scripts.length}）</div>
          {scripts.map((s) => (
            <button
              className="story-script"
              key={s.id}
              style={{ width: '100%', textAlign: 'left', border: 'none' }}
              onClick={() => navigate(`/story/script/${s.id}`)}
            >
              <div className="story-script__body">
                <div className="story-script__title">
                  {s.title}
                  {s.nsfwLevel > 0 && <span className="story-chip story-chip--adult">18+</span>}
                </div>
                <div className="story-script__meta">
                  {s.genre && <span>{s.genre}</span>}
                  <span>
                    {s.origin === 'builtin'
                      ? '内置示例'
                      : s.origin === 'generated'
                        ? 'AI 生成'
                        : '导入'}
                  </span>
                  {(runCount.get(s.id) ?? 0) > 0 && <span>已玩 {runCount.get(s.id)} 周目</span>}
                  {endingsOf.get(s.id) && <span>{endingsOf.get(s.id)}</span>}
                </div>
              </div>
              <span className="settings__chevron" />
            </button>
          ))}
          <label className="settings__row settings__row--divided">
            <span className="settings__label">导入剧本 JSON</span>
            <span className="settings__value">选择文件</span>
            <input type="file" accept=".json,application/json" hidden onChange={importJson} />
          </label>
          <div
            className="settings__row"
            // The clipboard twin of the detail page's 导出——on a phone, a
            // pasted JSON is a far shorter path than the file picker.
            onClick={() =>
              guard('story.importPaste', async () => {
                const text = await showPrompt({
                  title: '粘贴剧本 JSON',
                  placeholder: '{"scriptId": …}',
                  maxLength: 100_000,
                });
                if (!text?.trim()) return;
                const r = await saveScript(JSON.parse(text), 'import', Date.now());
                setStatus(r.ok ? '导入成功' : `导入失败：${r.issues.join('；')}`);
                await reload();
                if (r.ok) navigate(`/story/script/${r.id}`);
              })
            }
          >
            <span className="settings__label">粘贴 JSON 导入</span>
            <span className="settings__chevron" />
          </div>
        </div>

        {endedRuns.length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">已落幕（{endedRuns.length}）</div>
            {endedRuns.map((sv) => (
              <button
                className="story-run-row"
                key={sv.id}
                style={{ width: '100%', textAlign: 'left', border: 'none' }}
                onClick={() => navigate(`/story/run/${sv.id}`)}
              >
                <div className="story-run-row__body">
                  <div className="story-run-row__title">
                    《{titleOf(sv.scriptId)}》第 {runOf(sv)} 周目
                  </div>
                  <div className="story-run-row__meta">{runStateLabel(sv)}</div>
                </div>
                <span className="settings__chevron" />
              </button>
            ))}
          </div>
        )}

        <p className="settings__hint">
          剧情在群聊里演：GM 管走向，导演管谁开口，角色只拿到自己那一段的指示——
          没人拿得到整本剧本。开演前先选舞台和演员；回滚会连同那之后的对话、
          记忆和朋友圈一起撤销。
        </p>
      </div>
    </>
  );
}
