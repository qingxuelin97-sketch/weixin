/**
 * 剧情模式 (/story) — the visible entry for story mode (M-E5).
 *
 * Three script sources, as decided: the built-in examples, a JSON import, and
 * "write me a story about…". Starting a run needs a group conversation and a
 * cast binding, so the page refuses clearly when either is missing rather than
 * failing halfway through the first beat.
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { useGuard } from '../../app/useGuard';
import { listScripts, getScript, saveScript, deleteScript, makeSave, missingBindings, putSave, listSaves, rollbackTo, type StoryScriptRow, type StorySaveRow } from '../../ai/story-gm';
import { scheduleNextBeat, seedBuiltinScripts } from '../../ai/story-service';
import { generateScript, routerDeps, tierForPremise } from '../../ai/story-generate';
import { getRouter } from '../../llm/service';
import { globalTier } from '../../lib/nsfw-tier';
import type { Script } from '../../ai/story-script';
import './settings.css';

export function StoryPage() {
  const guard = useGuard();
  const showToast = useAppStore((s) => s.showToast);
  const conversations = useAppStore((s) => s.conversations);
  const personaFor = useAppStore((s) => s.personaFor);

  const [scripts, setScripts] = useState<StoryScriptRow[]>([]);
  const [saves, setSaves] = useState<StorySaveRow[]>([]);
  const [premise, setPremise] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const reload = async () => {
    await seedBuiltinScripts(Date.now());
    setScripts(await listScripts());
    setSaves(await listSaves());
  };
  useEffect(() => {
    guard('story.load', reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Groups are the stage: a story needs at least two persona-backed members. */
  const stages = conversations.filter(
    (c) => c.type === 'group' && !c.isHidden && (c.memberIds ?? []).filter(personaFor).length >= 2,
  );

  const start = async (row: StoryScriptRow) => {
    const script = await getScript(row.id);
    if (!script) {
      showToast('这个剧本读不出来，可能已损坏');
      return;
    }
    const stage = stages[0];
    if (!stage) {
      showToast('先建一个至少有两个 AI 的群，剧情要在群里演');
      return;
    }
    // Bind the cast to real members in order. Every character must land on
    // somebody — a run with an unbound role stalls the moment that beat arrives.
    const members = (stage.memberIds ?? []).filter(personaFor);
    const bindings: Record<string, string> = {};
    script.cast.forEach((c, i) => {
      if (members[i]) bindings[c.charId] = members[i];
    });
    const missing = missingBindings(script, bindings);
    if (missing.length) {
      showToast(`这个群里的人不够演：还差 ${missing.length} 个角色`);
      return;
    }
    const save = makeSave({
      script,
      convId: stage.id,
      bindings,
      globalTier: await globalTier(),
      now: Date.now(),
    });
    await putSave(save);
    await scheduleNextBeat(save, Date.now());
    await reload();
    showToast(`《${script.title}》开始了，去群里看`);
  };

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
      });
    reader.onerror = () => setStatus('读取文件失败');
    reader.readAsText(f);
  };

  const rollback = async (save: StorySaveRow) => {
    const target = Math.max(0, save.seq - 1);
    const r = await rollbackTo(save, target, Date.now());
    await reload();
    // The counts are shown because the cascade is the part a user has to be
    // able to trust: it says what was actually taken back, not just "done".
    showToast(`已回退一幕，撤销了 ${r.memoryRemoved.length} 条记忆、${r.momentsRemoved.length} 条朋友圈`);
  };

  return (
    <>
      <SubNav title="剧情模式" />
      <div className="page-body settings">
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
            <div className="settings__row settings__row--divided" key={s.id}>
              <span className="settings__label">
                {s.title}
                {s.origin === 'builtin' ? ' · 示例' : s.origin === 'generated' ? ' · AI 生成' : ''}
              </span>
              <button className="memory__btn" onClick={() => guard('story.start', () => start(s))}>
                开演
              </button>
              {s.origin !== 'builtin' && (
                <button
                  className="memory__btn memory__btn--danger"
                  onClick={() =>
                    guard('story.delete', async () => {
                      await deleteScript(s.id);
                      await reload();
                    })
                  }
                >
                  删除
                </button>
              )}
            </div>
          ))}
          <label className="settings__row">
            <span className="settings__label">导入剧本 JSON</span>
            <span className="settings__value">选择文件</span>
            <input type="file" accept=".json,application/json" hidden onChange={importJson} />
          </label>
        </div>

        {saves.length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">存档</div>
            {saves.map((sv) => (
              <div className="settings__row settings__row--divided" key={sv.id}>
                <span className="settings__label">
                  {sv.scriptId} · 第 {sv.seq} 幕{sv.isActive ? ' · 进行中' : ' · 已结束'}
                </span>
                <button
                  className="memory__btn"
                  disabled={sv.seq === 0}
                  onClick={() => guard('story.rollback', () => rollback(sv))}
                >
                  回退一幕
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="settings__hint">
          剧情在群聊里演：GM 管走向，导演管谁开口，角色只拿到**自己那一段**的指示——
          没人拿得到整本剧本。回退会连同这一幕写进记忆和朋友圈的内容一起撤销，
          否则角色会「记得没发生过的未来」。
          {stages.length === 0 && ' 目前还没有可用的群——先建一个至少两个 AI 的群。'}
        </p>
      </div>
    </>
  );
}
