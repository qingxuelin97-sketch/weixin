/**
 * 首次体验：三步引导 (M-K9)。接模型 → 认识朋友 → 她真的来打招呼。
 *
 * 步骤与「选了谁」都在 URL 里（`?step=2&who=ai_lin`）：第一步要去现有的 `/settings/api`
 * 接模型再回来，组件状态撑不过那一趟。规则（会不会出现、问候怎么排）在 ./welcome.ts，
 * 设计见 specs/onboarding.md。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { IconCheck } from '../../components/icons';
import { useAppStore } from '../../store/appStore';
import { hasUsableProvider } from '../../llm/config';
import { logError } from '../../lib/errlog';
import { markOnboarded, scheduleWelcomeGreeting } from './welcome';
import './welcome.css';

const STEPS = 3;

/** 人设的第一句，当作一行自我介绍。 */
function firstLine(core: string | undefined): string {
  const s = (core ?? '').trim();
  const cut = s.search(/[。！？!?\n]/);
  return cut > 0 ? s.slice(0, cut + 1) : s;
}

export function WelcomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('step'));
  const step = Number.isInteger(raw) && raw >= 1 && raw <= STEPS ? raw : 1;

  const contacts = useAppStore((s) => s.contacts);
  const conversations = useAppStore((s) => s.conversations);
  const personaFor = useAppStore((s) => s.personaFor);
  // In the chat list's order (pinned first, then newest): the default pick is
  // the friend at the top of the list the user is about to land on.
  const friends = useMemo(() => {
    const rank = new Map<string, number>();
    conversations.forEach((c, i) => {
      if (c.type === 'single' && c.peerId && !c.isHidden && !rank.has(c.peerId)) rank.set(c.peerId, i);
    });
    return contacts
      .filter((c) => c.type === 'ai')
      .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }, [contacts, conversations]);
  const whoParam = params.get('who');
  const who = friends.find((f) => f.id === whoParam) ?? friends[0];

  // 每进一步重新问一次：从设置页接完模型回来，第一步就该变成「已接上」。
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void hasUsableProvider()
      .then((ok) => alive && setReady(ok))
      .catch(() => alive && setReady(false));
    return () => {
      alive = false;
    };
  }, [step]);

  const go = (n: number, nextWho = who?.id) =>
    setParams({ step: String(n), ...(nextWho ? { who: nextWho } : {}) }, { replace: true });

  const [leaving, setLeaving] = useState(false);
  const finish = async (greet: boolean) => {
    if (leaving) return;
    setLeaving(true);
    markOnboarded();
    if (greet && ready && who) {
      const conv = conversations.find((c) => c.type === 'single' && c.peerId === who.id && !c.isHidden);
      if (conv) {
        await scheduleWelcomeGreeting(who.id, conv.id, Date.now()).catch((e) =>
          logError('welcome.greet', e),
        );
      }
    }
    navigate('/chats', { replace: true });
  };

  const name = who ? (who.remark ?? who.name) : '';

  return (
    <div className="welcome">
      <div className="welcome__top">
        <div className="welcome__dots" aria-label={`第 ${step} 步，共 ${STEPS} 步`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={`welcome__dot${i + 1 === step ? ' welcome__dot--on' : ''}`} />
          ))}
        </div>
        <button className="welcome__skip" onClick={() => void finish(false)}>
          跳过
        </button>
      </div>

      <div className="welcome__body">
        {step === 1 && (
          <>
            <h1 className="welcome__title">先接上一个模型</h1>
            <p className="welcome__desc">
              他们说的每一句话，都是你接上的模型此刻写的。API key 只存在这台手机上。
            </p>
            <div className="welcome__card">
              {ready ? (
                <div className="welcome__status welcome__status--ok">
                  <IconCheck size={20} />
                  已接上模型
                </div>
              ) : ready === false ? (
                <>
                  <div className="welcome__status">还没有可用的模型</div>
                  <button className="welcome__link" onClick={() => navigate('/settings/api')}>
                    去接一个 ›
                  </button>
                </>
              ) : null}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="welcome__title">这几位已经在等你了</h1>
            <p className="welcome__desc">他们有各自的性格、作息和记忆。挑一位，让 TA 先来打个招呼。</p>
            <div className="welcome__card welcome__card--list" role="radiogroup">
              {friends.map((f) => (
                <button
                  key={f.id}
                  className="welcome__friend"
                  role="radio"
                  aria-checked={f.id === who?.id}
                  onClick={() => go(2, f.id)}
                >
                  <Avatar color={f.avatarColor} text={f.avatarText} imageRef={f.avatarRef} size={44} />
                  <span className="welcome__friend-text">
                    <span className="welcome__friend-name">{f.remark ?? f.name}</span>
                    <span className="welcome__friend-line">{firstLine(personaFor(f.id)?.core)}</span>
                  </span>
                  <span className={`welcome__pick${f.id === who?.id ? ' welcome__pick--on' : ''}`}>
                    {f.id === who?.id && <IconCheck size={16} />}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 3 &&
          (ready ? (
            <>
              <h1 className="welcome__title">{name}马上会来找你</h1>
              <p className="welcome__desc">
                不是预设台词——是 TA 用你接上的模型、按自己的人设现在写的。回到会话列表等一下。
              </p>
            </>
          ) : (
            <>
              <h1 className="welcome__title">接上模型之后，他们会自己来找你</h1>
              <p className="welcome__desc">随时可以在 我 › 设置 › AI 与模型 里接上。</p>
            </>
          ))}
      </div>

      <div className="welcome__foot">
        <button
          className="welcome__primary"
          disabled={leaving}
          onClick={() => (step < STEPS ? go(step + 1) : void finish(true))}
        >
          {step < STEPS ? '下一步' : '进入微信'}
        </button>
      </div>
    </div>
  );
}
