/**
 * 我的二维码 (M-J7)。
 *
 * **这张码不是可扫的真码，是道具。** 说清楚这件事比把它做成真码重要：本 App
 * 没有账号体系、没有服务端（`docs/PLAN.md` 的「永不做」里写着），所以一张真
 * 能被微信扫出来的码背后没有任何东西可指向——扫出来只会是一串本地 id。做成
 * 真码需要一整套 Reed-Solomon 纠错编码，换来的是一个更精致的空指针。
 *
 * 所以这里画的是「长得对」的码：三个定位角 + 中间头像 + 由微信号种子化生成的
 * 模块点阵。种子化（`seededRng`，铁律 4）有两个真实收益：同一个微信号每次进来
 * 看到的是**同一张**码（不然它就不像一个身份），以及截图门禁能冻住它。
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { seededRng } from '../../lib/money';
import './me.css';

/** 码的边长（模块数）。21 是 QR 版本 1 的真实尺寸，看着才对。 */
const GRID = 21;
/** 定位角占 7×7，中间留 5×5 给头像。 */
const FINDER = 7;
const LOGO = 5;

/** true = 画一个黑块。纯函数，同一个 seed 永远同一张图。 */
function modules(seed: string): boolean[][] {
  const rng = seededRng(`qr:${seed}`);
  const mid = (GRID - LOGO) / 2;
  const grid: boolean[][] = [];
  for (let y = 0; y < GRID; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < GRID; x++) {
      const inFinder =
        (x < FINDER && y < FINDER) ||
        (x >= GRID - FINDER && y < FINDER) ||
        (x < FINDER && y >= GRID - FINDER);
      const inLogo = x >= mid && x < mid + LOGO && y >= mid && y < mid + LOGO;
      // 定位角与头像窗单独画，数据区才掷骰子。rng() 无论如何都要调用一次，
      // 否则跳过的格子会让后面所有格子的取值整体前移——同一个微信号在
      // 换了头像窗大小之后就成了另一张码。
      const bit = rng() < 0.45;
      row.push(inFinder || inLogo ? false : bit);
    }
    grid.push(row);
  }
  return grid;
}

/** 一个 7×7 的定位角（外框 + 中心方块），微信/QR 都长这样。 */
function Finder({ x, y }: { x: number; y: number }) {
  return (
    <>
      <rect className="qr__finder-ring" x={x} y={y} width={7} height={7} rx={1.6} />
      <rect className="qr__finder-hole" x={x + 1} y={y + 1} width={5} height={5} rx={1} />
      <rect className="qr__mod" x={x + 2} y={y + 2} width={3} height={3} rx={0.6} />
    </>
  );
}

export function QrCodePage() {
  const navigate = useNavigate();
  const me = useAppStore((s) => s.contactById('self'));
  const wxid = me?.wxid ?? 'aiwx';
  const grid = useMemo(() => modules(wxid), [wxid]);
  const mid = (GRID - LOGO) / 2;

  return (
    <>
      <SubNav title="我的二维码" />
      <div className="page-body qr-page">
        <div className="qr-card">
          <div className="qr-card__head">
            <Avatar
              color={me?.avatarColor ?? 'var(--color-brand)'}
              text={me?.avatarText ?? '我'}
              imageRef={me?.avatarRef}
              size={44}
            />
            <div className="qr-card__id">
              <div className="qr-card__name">{me?.name ?? '我'}</div>
              <div className="qr-card__wxid">微信号：{wxid}</div>
            </div>
          </div>

          <div className="qr-card__code">
            <svg viewBox={`0 0 ${GRID} ${GRID}`} className="qr" role="img" aria-label="我的二维码">
              <rect className="qr__bg" x={0} y={0} width={GRID} height={GRID} />
              {grid.map((row, y) =>
                row.map((on, x) =>
                  on ? (
                    <rect
                      key={`${x}-${y}`}
                      className="qr__mod"
                      x={x + 0.12}
                      y={y + 0.12}
                      width={0.76}
                      height={0.76}
                      rx={0.2}
                    />
                  ) : null,
                ),
              )}
              <Finder x={0} y={0} />
              <Finder x={GRID - FINDER} y={0} />
              <Finder x={0} y={GRID - FINDER} />
              {/* 中间的头像窗——微信把头像压在码中央，这是它最好认的特征 */}
              <rect className="qr__bg" x={mid} y={mid} width={LOGO} height={LOGO} rx={0.8} />
              <foreignObject x={mid + 0.4} y={mid + 0.4} width={LOGO - 0.8} height={LOGO - 0.8}>
                <div className="qr__logo">
                  <Avatar
                    color={me?.avatarColor ?? 'var(--color-brand)'}
                    text={me?.avatarText ?? '我'}
                    imageRef={me?.avatarRef}
                    size={36}
                  />
                </div>
              </foreignObject>
            </svg>
          </div>

          <p className="qr-card__hint">扫一扫上面的二维码图案，加我为朋友。</p>
        </div>

        {/* 不做「保存到相册 / 扫一扫」：前者要写系统相册权限，后者在
            docs/PLAN.md 的永不做清单上。留一个诚实的返回比留两个假按钮好。 */}
        <button className="btn-ghost" onClick={() => navigate('/profile')}>
          编辑个人信息
        </button>
      </div>
    </>
  );
}
