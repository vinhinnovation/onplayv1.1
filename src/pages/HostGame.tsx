import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { LETTERS, Leaderboard, Podium, Shell, SoundToggle, TimerBar, useCountdown } from '../components/Shared';
import { sound, type Track } from '../lib/sound';
import { api, normalizeSlug, sleep, SLUG_RE, type Snapshot } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import { useI18n } from '../lib/i18n';
import { useHostAuth } from '../lib/useHostAuth';

const POLL_MS = 1500;
const REVEAL_GRACE_MS = 1200; // server chấp nhận câu trả lời đến deadline + 1.5s; chờ 1.2s để không mất câu trả lời đang bay

export function HostGame() {
  const { t, err } = useI18n();
  const nav = useNavigate();
  const { id } = useParams();
  const { session, loading } = useHostAuth();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deadlineAt, setDeadlineAt] = useState(0);
  const revealedFor = useRef(-1);

  useEffect(() => { if (!loading && !session) nav('/host/login', { replace: true }); }, [loading, session, nav]);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const s = await api.hostSnapshot(id);
      setSnap(s);
      if (s.status === 'question' && s.ms_left !== null) setDeadlineAt(performance.now() + s.ms_left);
      setError('');
    } catch (e) { setError(err(e)); }
  }, [id, err]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const loop = async () => {
      while (alive) { await refresh(); await sleep(POLL_MS); }
    };
    void loop();
    return () => { alive = false; };
  }, [session, refresh]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }, [refresh, err]);

  const status = snap?.status;
  const msLeft = useCountdown(deadlineAt, status === 'question');

  // --- Âm thanh trên màn hình chiếu: nhạc nền theo trạng thái game + tiếng tích tắc 5 giây cuối ---
  useEffect(() => { sound.init('host'); return () => sound.stop(); }, []);
  useEffect(() => {
    const scene: Partial<Record<string, Track>> = { lobby: 'lobby', question: 'question', leaderboard: 'leaderboard', ended: 'victory' };
    sound.music(status ? scene[status] ?? null : null);
    if (status === 'question') sound.sfx('start');
    if (status === 'reveal') sound.sfx('reveal');
  }, [status]);
  const secsLeft = Math.ceil(msLeft / 1000);
  useEffect(() => { if (status === 'question' && secsLeft >= 1 && secsLeft <= 5) sound.sfx('tick'); }, [secsLeft, status]);

  // Tự chốt câu hỏi khi hết giờ (+ grace) hoặc khi tất cả người chơi đã trả lời.
  // Chỉ phụ thuộc vào giá trị nguyên thủy để timer không bị reset mỗi lần polling.
  const st = snap?.status, qi = snap?.idx ?? -1, players = snap?.players ?? 0, answered = snap?.answered ?? 0;
  useEffect(() => {
    if (st !== 'question' || !id || revealedFor.current === qi) return;
    const everyone = players > 0 && answered >= players;
    if (!everyone && msLeft > 0) return;
    const timer = setTimeout(() => {
      if (revealedFor.current === qi) return;
      revealedFor.current = qi;
      void act(() => api.hostReveal(id));
    }, everyone ? 400 : REVEAL_GRACE_MS);
    return () => clearTimeout(timer);
  }, [st, qi, players, answered, msLeft > 0, id, act]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!id) return null;
  if (!snap) return <Shell theme="dark" back="/host"><p className="center">{error || t('common.loading')}</p></Shell>;

  // Có link đơn giản thì QR + dòng hướng dẫn dùng link đó, không thì dùng /join/<pin> như cũ
  const joinUrl = snap.slug ? `${window.location.origin}/${snap.slug}` : `${window.location.origin}/join/${snap.pin}`;
  const q = snap.question;
  const last = snap.idx + 1 >= snap.total;
  const nextLabel = last ? t('game.finish') : t('game.next');
  const next = () => act(() => api.hostStart(id));
  const endGame = () => { if (window.confirm(t('game.endConfirm'))) void act(() => api.hostEnd(id)); };
  const exportCsv = async () => {
    try {
      const rows = await api.hostResults(id);
      downloadCsv(`onquiz-${snap.pin}.csv`, [['rank', 'nickname', 'score', 'correct', 'total_questions'],
        ...rows.map((r) => [r.rank, r.nickname, r.score, r.correct_count, r.total_questions])]);
    } catch (e) { setError(err(e)); }
  };

  const choices = (reveal: boolean) => q && (
    <div className="answers">
      {q.choices.map((c, i) => {
        const right = reveal && (snap.correct_indexes ?? []).includes(i);
        return (
          <div key={i} className={`ans static c${i} ${reveal && !right ? 'dim' : ''} ${right ? 'right' : ''}`}>
            <span className="l">{LETTERS[i]}</span><span>{c}</span>
            {reveal && <span className="cnt">{snap.counts?.[i] ?? 0}</span>}
          </div>
        );
      })}
    </div>
  );

  let body;
  switch (snap.status) {
    case 'lobby':
      body = (
        <div className="center stack">
          {snap.slug && <div className="slug-big">{window.location.host}/<b>{snap.slug}</b></div>}
          <p style={{ margin: 0 }}>{snap.slug ? t('slug.orPin') : <>{t('game.joinAt')} <b>{window.location.host}</b> {t('game.withPin')}</>}</p>
          <div className="big-pin">{snap.pin}</div>
          <div className="qrbox"><QRCodeSVG value={joinUrl} size={180} /></div>
          <p style={{ margin: 0, opacity: .8 }}>{t('game.orScan')}</p>
          <SlugEditor gameId={id} current={snap.slug ?? null} joinUrl={joinUrl} onSaved={refresh} />
          <h2 style={{ margin: 0 }}>{snap.title}</h2>
          <div className="stat"><b>{snap.players}</b>{t('game.players')}</div>
          {snap.players === 0 && <p style={{ opacity: .75 }}>{t('game.waitPlayers')}</p>}
          <div className="chipwall">{(snap.recent ?? []).map((n) => <span key={n}>{n}</span>)}</div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn big" disabled={busy || snap.players === 0} onClick={() => { void next(); }}>{t('game.start')}</button>
            <button className="btn ghost" onClick={endGame}>{t('game.end')}</button>
          </div>
        </div>
      );
      break;
    case 'question':
      body = q && (
        <div className="stack">
          <div className="row between">
            <b>{t('game.questionOf', { i: q.idx + 1, n: q.total })}</b>
            <span><b>{snap.answered}</b>/{snap.players} {t('game.answered')}</span>
            <b style={{ fontSize: '1.6rem' }}>{Math.ceil(msLeft / 1000)}{t('game.sec')}</b>
          </div>
          <TimerBar msLeft={msLeft} totalMs={q.time_limit * 1000} />
          <div className="qtext">{q.text}</div>
          {choices(false)}
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" disabled={busy} onClick={() => { revealedFor.current = snap.idx; void act(() => api.hostReveal(id)); }}>{t('game.skip')}</button>
            <button className="btn ghost" onClick={endGame}>{t('game.end')}</button>
          </div>
          <p className="center" style={{ opacity: .7, margin: 0 }}>{t('game.autoNote')}</p>
        </div>
      );
      break;
    case 'reveal':
    case 'leaderboard':
      body = (
        <div className="stack">
          {q && <div className="row between"><b>{t('game.questionOf', { i: q.idx + 1, n: q.total })}</b><span>{snap.answered}/{snap.players} {t('game.answered')}</span></div>}
          {q && <div className="qtext" style={{ margin: '8px 0' }}>{q.text}</div>}
          {choices(true)}
          {snap.status === 'leaderboard' && <div className="panel"><h2>{t('play.top5')}</h2><Leaderboard top={snap.top ?? []} /></div>}
          <div className="row" style={{ justifyContent: 'center' }}>
            {snap.status === 'reveal' && <button className="btn" disabled={busy} onClick={() => { void act(() => api.hostLeaderboard(id)); }}>{t('game.showBoard')}</button>}
            <button className={snap.status === 'reveal' ? 'btn teal' : 'btn big'} disabled={busy} onClick={() => { void next(); }}>{nextLabel}</button>
            <button className="btn ghost" onClick={endGame}>{t('game.end')}</button>
          </div>
        </div>
      );
      break;
    case 'ended':
      body = (
        <div className="center stack">
          <h1>{t('game.podium')}</h1>
          <Podium top={snap.top ?? []} />
          <div className="panel" style={{ textAlign: 'left', maxWidth: 560, margin: '0 auto', width: '100%' }}><Leaderboard top={snap.top ?? []} /></div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => { void exportCsv(); }}>{t('game.exportCsv')}</button>
            <button className="btn ghost" onClick={() => nav('/host')}>{t('game.newGame')}</button>
          </div>
        </div>
      );
      break;
  }

  return (
    <Shell theme="dark" wide footer={false} back="/host" right={<span className="row" style={{ gap: 8 }}><SoundToggle /><span className="badge">PIN {snap.pin}</span></span>}>
      {error && <p className="err" role="alert">{error}</p>}
      {body}
    </Shell>
  );
}

/**
 * Ô đặt link đơn giản cho game (hiện ở lobby). Server kiểm tra lại định dạng, từ khoá hệ thống
 * và trùng lặp; ở đây chỉ chuẩn hoá khi gõ để host thấy ngay link cuối cùng.
 */
function SlugEditor({ gameId, current, joinUrl, onSaved }: {
  gameId: string; current: string | null; joinUrl: string; onSaved: () => Promise<void>;
}) {
  const { t, err } = useI18n();
  const [draft, setDraft] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Đồng bộ khi slug trên server đổi (vd host mở game ở máy khác)
  useEffect(() => { setDraft(current ?? ''); }, [current]);

  const clean = normalizeSlug(draft);
  const valid = SLUG_RE.test(clean) && !/^[0-9]+$/.test(clean);
  const save = async (value: string) => {
    setBusy(true); setMsg(null);
    try {
      await api.hostSetSlug(gameId, value);
      await onSaved();
      setMsg({ ok: true, text: value ? t('slug.saved') : t('slug.cleared') });
    } catch (e) { setMsg({ ok: false, text: err(e) }); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(joinUrl); setMsg({ ok: true, text: t('slug.copied') }); }
    catch { setMsg({ ok: false, text: joinUrl }); } // clipboard bị chặn: hiện link để host tự chép
  };

  return (
    <div className="panel slug-panel">
      <label className="field" style={{ marginBottom: 8 }}>
        <span style={{ color: 'inherit' }}>{t('slug.label')}</span>
        <div className="slug-input">
          <span className="slug-prefix">{window.location.host}/</span>
          <input className="input" maxLength={40} placeholder="tet-2027" value={draft} autoComplete="off" spellCheck={false}
            onChange={(e) => setDraft(normalizeSlug(e.target.value, false))}
            onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void save(clean); }} />
        </div>
      </label>
      <p className="slug-hint">{t('slug.hint')}</p>
      {msg && <p className={msg.ok ? 'ok-note' : 'err'} role="status">{msg.text}</p>}
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn teal small" disabled={busy || !valid || clean === current} onClick={() => { void save(clean); }}>
          {current ? t('slug.update') : t('slug.save')}
        </button>
        {current && <button className="btn ghost small" disabled={busy} onClick={() => { void save(''); }}>{t('slug.clear')}</button>}
        <button className="btn ghost small" onClick={() => { void copy(); }}>{t('slug.copy')}</button>
      </div>
    </div>
  );
}
