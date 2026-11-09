import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Shell } from '../components/Shared';
import { api, type GameRow, type QuizRow } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import { useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';
import { useHostAuth } from '../lib/useHostAuth';

export function HostDashboard() {
  const { t, err, lang } = useI18n();
  const nav = useNavigate();
  const { session, loading } = useHostAuth();
  const [quizzes, setQuizzes] = useState<QuizRow[] | null>(null);
  const [games, setGames] = useState<GameRow[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => { if (!loading && !session) nav('/host/login', { replace: true }); }, [loading, session, nav]);

  const load = useCallback(async () => {
    const [q, g] = await Promise.all([
      supabase.from('quizzes').select('id,title,description,updated_at,questions(count)').order('updated_at', { ascending: false }),
      supabase.from('games').select('id,pin,slug,title,status,total_questions,created_at').order('created_at', { ascending: false }).limit(30),
    ]);
    if (q.error || g.error) { setError(err(q.error ?? g.error)); return; }
    setQuizzes(q.data as unknown as QuizRow[]);
    setGames(g.data as GameRow[]);
  }, [err]);
  useEffect(() => { if (session) void load(); }, [session, load]);

  const host = async (quizId: string) => {
    setBusyId(quizId); setError('');
    try { const r = await api.createGame(quizId); nav(`/host/game/${r.game_id}`); }
    catch (e) { setError(err(e)); setBusyId(''); }
  };
  const remove = async (id: string) => {
    if (!window.confirm(t('host.confirmDelete'))) return;
    const { error: e } = await supabase.from('quizzes').delete().eq('id', id);
    if (e) setError(err(e)); else void load();
  };
  const exportGame = async (g: GameRow) => {
    try {
      const rows = await api.hostResults(g.id);
      downloadCsv(`onquiz-${g.pin}-${g.created_at.slice(0, 10)}.csv`,
        [['rank', 'nickname', 'score', 'correct', 'total_questions'], ...rows.map((r) => [r.rank, r.nickname, r.score, r.correct_count, r.total_questions])]);
    } catch (e) { setError(err(e)); }
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Shell wide right={<button className="link" onClick={() => { void supabase.auth.signOut(); }}>{t('common.signout')}</button>}>
      <div className="row between" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>{t('host.myQuizzes')}</h1>
        <Link to="/host/quiz/new" className="btn">{t('host.newQuiz')}</Link>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {quizzes === null ? <p>{t('common.loading')}</p> : quizzes.length === 0 ? (
        <div className="card center"><p>{t('host.noQuizzes')}</p></div>
      ) : (
        <ul className="list">
          {quizzes.map((q) => (
            <li key={q.id} className="item">
              <div>
                <h3>{q.title}</h3>
                <span className="muted">{q.questions[0]?.count ?? 0} {t('host.questions')} · {t('host.updated')} {fmt(q.updated_at)}</span>
              </div>
              <div className="row">
                <Link to={`/host/quiz/${q.id}`} className="btn ghost small">{t('common.edit')}</Link>
                <button className="btn danger small" onClick={() => { void remove(q.id); }}>{t('common.delete')}</button>
                <button className="btn teal" disabled={busyId === q.id || (q.questions[0]?.count ?? 0) === 0} onClick={() => { void host(q.id); }}>
                  {t('host.startGame')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ marginTop: 36 }}>{t('host.history')}</h2>
      {games.length === 0 ? <p className="muted">{t('host.noHistory')}</p> : (
        <ul className="list">
          {games.map((g) => (
            <li key={g.id} className="item">
              <div>
                <h3>{g.title} <span className={g.status === 'ended' ? 'badge' : 'badge live'}>{g.status === 'ended' ? t('host.statusEnded') : t('host.statusRunning')}</span></h3>
                <span className="muted">PIN {g.pin}{g.slug ? ` · /${g.slug}` : ''} · {fmt(g.created_at)} · {g.total_questions} {t('host.questions')}</span>
              </div>
              <div className="row">
                {g.status !== 'ended' && <Link className="btn teal small" to={`/host/game/${g.id}`}>{t('game.resume')}</Link>}
                <button className="btn ghost small" onClick={() => { void exportGame(g); }}>{t('host.exportCsv')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
