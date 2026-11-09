import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import type { TopRow } from '../lib/api';
import { sound, useSound } from '../lib/sound';

export const LETTERS = ['A', 'B', 'C', 'D'];

export function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang" role="group" aria-label="Language">
      <button className={lang === 'vi' ? 'on' : ''} onClick={() => setLang('vi')}>VI</button>
      <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  );
}

export type Theme = 'light' | 'dark' | 'brand';

/** Logo OnPoint: bản màu trên nền sáng, bản trắng trên nền tối/đỏ. */
export function Logo({ theme }: { theme: Theme }) {
  const { t } = useI18n();
  return theme === 'light' ? (
    <span className="brand-lockup">
      <img src="/brand/logo-horizontal.png" alt="OnPoint" />
    </span>
  ) : (
    <span className="brand-lockup">
      <img src="/brand/icon-white.png" alt="" style={{ height: 34 }} />
      <img src="/brand/wordmark-white.png" alt="OnPoint" style={{ height: 22 }} />
      <span className="by" aria-hidden>{t('app.name')}</span>
    </span>
  );
}

export function Shell({ children, wide = false, back, theme = 'light', right, footer = true }: {
  children: ReactNode; wide?: boolean; back?: string; theme?: Theme; right?: ReactNode; footer?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={`shell ${theme}`}>
      <header className="top">
        <div className="row">
          <Link to="/" className="brand" aria-label="OnQuiz by OnPoint"><Logo theme={theme} /></Link>
          {back && <Link to={back} className="link">← {t('common.back')}</Link>}
        </div>
        <div className="right">{right}<LangToggle /></div>
      </header>
      <main className={wide ? 'main wide' : 'main'}>{children}</main>
      {footer && <div className="foot">{t('app.name')} {t('app.by')}</div>}
    </div>
  );
}

/** Đếm ngược theo đồng hồ cục bộ (performance.now), cập nhật 10 lần/giây. */
export function useCountdown(deadlineAt: number, active: boolean) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [active, deadlineAt]);
  return Math.max(0, deadlineAt - now);
}

export function TimerBar({ msLeft, totalMs }: { msLeft: number; totalMs: number }) {
  const pct = totalMs > 0 ? Math.max(0, Math.min(100, (msLeft / totalMs) * 100)) : 0;
  return (
    <div className="timer" aria-hidden>
      <div className={pct < 25 ? 'bar low' : 'bar'} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Leaderboard({ top, me }: { top: TopRow[]; me?: string }) {
  return (
    <ol className="board">
      {top.map((r) => (
        <li key={r.rank + r.nickname} className={me && r.nickname === me ? 'me' : ''}>
          <span className="pos">{r.rank}</span>
          <span className="nick">{r.nickname}</span>
          <span className="pts">{r.score.toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}

export function Podium({ top }: { top: TopRow[] }) {
  const [first, second, third] = [top[0], top[1], top[2]];
  const col = (r: TopRow | undefined, cls: string) =>
    r ? (
      <div className={`pcol ${cls}`}>
        <div className="pname">{r.nickname}</div>
        <div className="pscore">{r.score.toLocaleString()}</div>
        <div className="pstep">{r.rank}</div>
      </div>
    ) : <div className="pcol empty" />;
  return (
    <div className="podium">
      {col(second, 'p2')}
      {col(first, 'p1')}
      {col(third, 'p3')}
    </div>
  );
}

/** Hai nút nhỏ: ♪ nhạc nền, 🔊 hiệu ứng. Trình duyệt chỉ cho phát tiếng sau lần chạm đầu tiên nên có gợi ý khi đang bị khoá. */
export function SoundToggle() {
  const { t } = useI18n();
  const s = useSound();
  return (
    <span className="snd" role="group" aria-label={t('snd.label')}>
      <button className={s.musicOn ? 'on' : ''} aria-pressed={s.musicOn} title={t('snd.music')} aria-label={t('snd.music')}
        onClick={() => sound.setMusic(!s.musicOn)}>♪</button>
      <button className={s.sfxOn ? 'on' : ''} aria-pressed={s.sfxOn} title={t('snd.sfx')} aria-label={t('snd.sfx')}
        onClick={() => sound.setSfx(!s.sfxOn)}>{s.sfxOn ? '🔊' : '🔇'}</button>
      {s.musicOn && s.locked && <span className="snd-hint">{t('snd.tap')}</span>}
    </span>
  );
}
