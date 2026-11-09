import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { LETTERS, Leaderboard, Shell, SoundToggle, TimerBar, useCountdown } from '../components/Shared';
import { sound, type Track } from '../lib/sound';
import { useI18n } from '../lib/i18n';
import { clearSession, loadSession, usePlayerGame, type Session } from '../lib/usePlayerGame';

export function Play() {
  const nav = useNavigate();
  const session = loadSession();
  useEffect(() => { if (!session) nav('/', { replace: true }); }, [session, nav]);
  if (!session) return null;
  return <PlayInner session={session} />;
}

function PlayInner({ session }: { session: Session }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { view: v, choose } = usePlayerGame(session);
  const q = v.question;
  const msLeft = useCountdown(v.deadlineAt, v.phase === 'question');
  const leave = () => { clearSession(); nav('/', { replace: true }); };

  // --- Âm thanh: nhạc nền theo màn hình (mặc định tắt trên điện thoại người chơi, bật được bằng nút ♪) ---
  useEffect(() => { sound.init('player'); return () => sound.stop(); }, []);
  useEffect(() => {
    const scene: Partial<Record<typeof v.phase, Track>> = { lobby: 'lobby', question: 'question', leaderboard: 'leaderboard', ended: 'victory' };
    sound.music(scene[v.phase] ?? null);
  }, [v.phase]);
  // Âm báo bắt đầu câu hỏi
  const qIdx = v.phase === 'question' ? (q?.idx ?? -1) : -1;
  useEffect(() => { if (qIdx >= 0) sound.sfx('start'); }, [qIdx]);
  // Đúng/sai tính ngay tại máy từ đáp án host vừa công bố (không chờ điểm từ server)
  const revIdx = v.phase === 'reveal' && v.reveal ? v.reveal.idx : -1;
  const playedFor = useRef(-1);
  useEffect(() => {
    if (revIdx < 0 || playedFor.current === revIdx) return;
    playedFor.current = revIdx;
    if (v.myChoice === null) sound.sfx('timeup');
    else sound.sfx(v.reveal?.correct_indexes.includes(v.myChoice) ? 'correct' : 'wrong');
  }, [revIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const right = (
    <span className="row" style={{ gap: 8 }}>
      <SoundToggle />
      <span title={v.connected ? 'online' : t('play.reconnecting')}><span className={v.connected ? 'dot' : 'dot off'} />{session.nickname}</span>
      <button className="link" onClick={leave}>{t('join.leave')}</button>
    </span>
  );

  let body;
  switch (v.phase) {
    case 'loading':
      body = <p className="center">{t('common.loading')}</p>;
      break;
    case 'invalid':
      body = (
        <div className="panel center stack">
          <p>{t('err.invalid_player')}</p>
          <button className="btn" onClick={leave}>{t('join.go')}</button>
        </div>
      );
      break;
    case 'lobby':
      body = (
        <div className="center" style={{ marginTop: 40 }}>
          <h1>{t('play.lobbyTitle')}</h1>
          <p className="big-nick" style={{ fontSize: '1.6rem', fontWeight: 800 }}>{session.nickname}</p>
          <p>{session.title}</p>
          <p className="muted" style={{ color: 'rgba(255,255,255,.75)' }}>{t('play.lobbyWait')}</p>
        </div>
      );
      break;
    case 'question': {
      if (!q) { body = null; break; }
      const total = q.time_limit * 1000;
      const locked = v.myChoice !== null;
      const over = msLeft <= 0;
      body = (
        <div className="stack">
          <div className="row between">
            <b>{t('play.question')} {q.idx + 1}{t('play.of')}{q.total}</b>
            <b style={{ fontSize: '1.4rem' }}>{Math.ceil(msLeft / 1000)}{t('game.sec')}</b>
          </div>
          <TimerBar msLeft={msLeft} totalMs={total} />
          <p className="center" style={{ margin: 0, opacity: .8 }}>
            {q.points === 0 ? t('play.noPoints') : t('play.pointsWorth', { p: q.points ?? 0 })}
          </p>
          <div className="qtext">{q.text}</div>
          <div className="answers">
            {q.choices.map((c, i) => (
              <button key={i} className={`ans c${i} ${locked && v.myChoice !== i ? 'dim' : ''} ${v.myChoice === i ? 'picked' : ''}`}
                disabled={locked || over} onClick={() => { sound.sfx('click'); void choose(i); }}>
                <span className="l">{LETTERS[i]}</span><span>{c}</span>
              </button>
            ))}
          </div>
          <p className="center" style={{ minHeight: '1.5em' }}>
            {locked ? t('play.locked') : over ? t('play.timeUp') : ''}
            {v.missed && <><br />{t('play.missed')}</>}
          </p>
        </div>
      );
      break;
    }
    case 'reveal':
    case 'leaderboard': {
      const r = v.result;
      const rev = v.reveal;
      const ok = r?.last_correct;
      body = (
        <div className="stack">
          {q && rev && (
            <div className="answers">
              {q.choices.map((c, i) => {
                const right = rev.correct_indexes.includes(i);
                const mine = v.myChoice === i;
                return (
                  <div key={i} className={`ans static c${i} ${right ? 'right' : mine ? 'wrong-pick dim' : 'dim'} ${mine ? 'picked' : ''}`}>
                    <span className="l">{LETTERS[i]}</span><span>{c}</span>
                  </div>
                );
              })}
            </div>
          )}
          {!r ? <p className="center">{t('common.loading')}</p> : (
            <>
              <div className={`result-big ${ok ? 'good' : 'bad'}`}>
                {!r.answered ? t('play.missed') : ok ? t('play.correct') : t('play.wrong')}
                {ok && <> +{r.last_points}</>}
              </div>
              <div className="panel stats">
                <div className="stat"><b>{r.score.toLocaleString()}</b>{t('play.score')}</div>
                <div className="stat"><b>{r.rank > 0 ? `#${r.rank}` : '–'}</b>{t('play.rank')}</div>
                <div className="stat"><b>{r.streak}</b>{t('play.streak')}</div>
              </div>
            </>
          )}
          {v.phase === 'leaderboard' && (
            <div className="panel"><h2>{t('play.top5')}</h2><Leaderboard top={v.top} me={session.nickname} /></div>
          )}
        </div>
      );
      break;
    }
    case 'ended': {
      const r = v.result;
      body = (
        <div className="stack center">
          <h1>{t('play.final')}</h1>
          {r && (
            <div className="panel stats">
              <div className="stat"><b>{r.rank > 0 ? `#${r.rank}` : '–'}</b>{t('play.yourRank')}</div>
              <div className="stat"><b>{r.score.toLocaleString()}</b>{t('play.score')}</div>
              <div className="stat"><b>{r.correct_count}</b>{t('play.correctCount')}</div>
            </div>
          )}
          <div className="panel" style={{ textAlign: 'left' }}><h2>{t('play.top5')}</h2><Leaderboard top={v.top} me={session.nickname} /></div>
          <button className="btn" onClick={leave}>{t('common.back')}</button>
        </div>
      );
      break;
    }
  }

  return <Shell theme="dark" right={right} footer={false}>{body}</Shell>;
}
