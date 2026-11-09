import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LETTERS, Shell } from '../components/Shared';
import { POINT_OPTIONS, TIME_OPTIONS, api, defaultQuestion, type EditorQuestion } from '../lib/api';
import { CSV_TEMPLATE, csvToQuestions, downloadText } from '../lib/csv';
import { useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';
import { useHostAuth } from '../lib/useHostAuth';

interface DbQuestion { text: string; choices: string[]; correct_indexes: number[]; time_limit: number; points: number; speed_bonus: boolean }

/** Bỏ đáp án trống, dồn lại chỉ số và chỉ số đáp án đúng. Trả về null nếu câu hỏi chưa hợp lệ. */
function normalize(q: EditorQuestion): EditorQuestion | null {
  const map = new Map<number, number>();
  const choices: string[] = [];
  q.choices.forEach((c, i) => { if (c.trim()) { map.set(i, choices.length); choices.push(c.trim()); } });
  const correct = q.correct_indexes.filter((i) => map.has(i)).map((i) => map.get(i)!);
  if (!q.text.trim() || choices.length < 2 || correct.length === 0) return null;
  return { ...q, text: q.text.trim(), choices, correct_indexes: correct };
}

export function QuizEditor() {
  const { t, err } = useI18n();
  const nav = useNavigate();
  const { id } = useParams();
  const isNew = id === 'new';
  const { session, loading } = useHostAuth();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [qs, setQs] = useState<EditorQuestion[]>([defaultQuestion()]);
  const [ready, setReady] = useState(isNew);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!loading && !session) nav('/host/login', { replace: true }); }, [loading, session, nav]);

  useEffect(() => {
    if (!session || isNew || !id) return;
    void (async () => {
      const [q, qq] = await Promise.all([
        supabase.from('quizzes').select('title,description').eq('id', id).single(),
        supabase.from('questions').select('text,choices,correct_indexes,time_limit,points,speed_bonus').eq('quiz_id', id).order('position'),
      ]);
      if (q.error || qq.error) { setError(err(q.error ?? qq.error)); return; }
      setTitle(q.data.title); setDesc(q.data.description);
      setQs((qq.data as DbQuestion[]).map((x) => ({ ...x, choices: [...x.choices, '', '', ''].slice(0, Math.max(x.choices.length, 4)) })));
      setReady(true);
    })();
  }, [session, id, isNew, err]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const edit = (fn: () => void) => { fn(); setDirty(true); setNote(''); };
  const setQ = (i: number, patch: Partial<EditorQuestion>) => edit(() => setQs((a) => a.map((q, j) => (j === i ? { ...q, ...patch } : q))));
  const setChoice = (i: number, c: number, v: string) => setQ(i, { choices: qs[i].choices.map((x, k) => (k === c ? v : x)) });
  const toggleCorrect = (i: number, c: number) => {
    const cur = qs[i].correct_indexes;
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c].sort();
    setQ(i, { correct_indexes: next });
  };
  const move = (i: number, d: number) => edit(() => setQs((a) => {
    const b = [...a]; const j = i + d; if (j < 0 || j >= b.length) return a;
    [b[i], b[j]] = [b[j], b[i]]; return b;
  }));

  const save = async (): Promise<string | null> => {
    setError('');
    if (!title.trim()) { setError(t('ed.needTitle')); return null; }
    const norm: EditorQuestion[] = [];
    for (let i = 0; i < qs.length; i++) {
      const n = normalize(qs[i]);
      if (!n) { setError(t('ed.validation', { n: i + 1 })); return null; }
      norm.push(n);
    }
    setBusy(true);
    try {
      const qid = await api.saveQuiz(isNew ? null : id!, title.trim(), desc.trim(), norm);
      setDirty(false); setNote(t('ed.saved'));
      setQs(norm.map((q) => ({ ...q, choices: [...q.choices, '', '', ''].slice(0, Math.max(q.choices.length, 4)) })));
      if (isNew) nav(`/host/quiz/${qid}`, { replace: true });
      return qid;
    } catch (e) { setError(err(e)); return null; }
    finally { setBusy(false); }
  };

  const saveAndHost = async () => {
    const qid = await save();
    if (!qid) return;
    try { const r = await api.createGame(qid); nav(`/host/game/${r.game_id}`); } catch (e) { setError(err(e)); }
  };

  const importCsv = async (file: File) => {
    const { questions, errors } = csvToQuestions(await file.text());
    if (errors.length) setError(errors.slice(0, 5).join(' | ') + (errors.length > 5 ? ` … (+${errors.length - 5})` : ''));
    if (questions.length) {
      edit(() => setQs((a) => {
        const base = a.length === 1 && !a[0].text.trim() ? [] : a;
        return [...base, ...questions.map((q) => ({ ...q, choices: [...q.choices, '', '', ''].slice(0, Math.max(q.choices.length, 4)) }))];
      }));
      setNote(t('ed.imported', { n: questions.length }));
    }
  };

  const totalPoints = qs.reduce((s, q) => s + (Number.isFinite(q.points) ? q.points : 0), 0);

  if (!ready) return <Shell wide back="/host"><p>{error || t('common.loading')}</p></Shell>;

  return (
    <Shell wide back="/host">
      <div className="editor-head">
        <div className="row between">
          <div>
            <b>{t('ed.summary', { n: qs.length, p: totalPoints.toLocaleString() })}</b>
            {dirty && <span className="badge live" style={{ marginLeft: 10 }}>{t('ed.unsaved')}</span>}
          </div>
          <div className="row">
            <button className="btn ghost small" onClick={() => downloadText('onquiz-template.csv', CSV_TEMPLATE)}>{t('ed.template')}</button>
            <button className="btn ghost small" onClick={() => fileRef.current?.click()}>{t('ed.importCsv')}</button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ''; }} />
            <button className="btn small" disabled={busy} onClick={() => { void save(); }}>{busy ? t('ed.saving') : t('common.save')}</button>
            <button className="btn teal small" disabled={busy} onClick={() => { void saveAndHost(); }}>{t('ed.saveAndHost')}</button>
          </div>
        </div>
      </div>

      {error && <p className="err" role="alert">{error}</p>}
      {note && <p className="ok-note">{note}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <label className="field"><span>{t('ed.title')}</span>
          <input className="input" maxLength={120} value={title} onChange={(e) => edit(() => setTitle(e.target.value))} /></label>
        <label className="field" style={{ marginBottom: 0 }}><span>{t('ed.desc')}</span>
          <input className="input" maxLength={500} value={desc} onChange={(e) => edit(() => setDesc(e.target.value))} /></label>
        <p className="hint">{t('ed.csvHelp')}</p>
      </div>

      {qs.map((q, i) => (
        <section className="qcard" key={i} aria-label={`${t('ed.question')} ${i + 1}`}>
          <header>
            <span className="qnum">{i + 1}</span>
            <span className="spacer" />
            <button className="btn ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('ed.moveUp')}>↑</button>
            <button className="btn ghost small" disabled={i === qs.length - 1} onClick={() => move(i, 1)} aria-label={t('ed.moveDown')}>↓</button>
            <button className="btn ghost small" onClick={() => edit(() => setQs((a) => [...a.slice(0, i + 1), { ...a[i], choices: [...a[i].choices], correct_indexes: [...a[i].correct_indexes] }, ...a.slice(i + 1)]))}>{t('ed.duplicate')}</button>
            <button className="btn danger small" disabled={qs.length === 1} onClick={() => edit(() => setQs((a) => a.filter((_, j) => j !== i)))}>{t('ed.removeQuestion')}</button>
          </header>
          <textarea className="input" rows={2} maxLength={300} placeholder={t('ed.placeholderQ')} value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} />

          <div className="choice-grid">
            {q.choices.map((c, k) => {
              const on = q.correct_indexes.includes(k);
              return (
                <div key={k} className={on ? 'choice-edit correct' : 'choice-edit'}>
                  <span className={`letter c${k}`}>{LETTERS[k]}</span>
                  <input type="text" maxLength={120} placeholder={`${t('ed.placeholderA')} ${LETTERS[k]}`} value={c} onChange={(e) => setChoice(i, k, e.target.value)} />
                  <button type="button" className={on ? 'tick on' : 'tick'} aria-pressed={on} title={on ? t('ed.correct') : t('ed.wrong')}
                    aria-label={`${t('ed.correct')} ${LETTERS[k]}`} onClick={() => toggleCorrect(i, k)}>{on ? '✓' : ''}</button>
                </div>
              );
            })}
          </div>
          <p className="hint">{t('ed.correctHint')}</p>

          <div className="settings">
            <div>
              <span className="label">{t('ed.points')}</span>
              <div className="chips">
                {POINT_OPTIONS.map((p) => <button key={p} className={q.points === p ? 'chip on' : 'chip'} onClick={() => setQ(i, { points: p })}>{p}</button>)}
                <input className="input chip-num" type="number" min={0} max={10000} step={100} aria-label={t('ed.customPoints')} value={q.points}
                  onChange={(e) => setQ(i, { points: Math.max(0, Math.min(10000, Math.round(Number(e.target.value) || 0))) })} />
              </div>
            </div>
            <div>
              <span className="label">{t('ed.time')}</span>
              <div className="chips">
                {TIME_OPTIONS.map((s) => <button key={s} className={q.time_limit === s ? 'chip on' : 'chip'} onClick={() => setQ(i, { time_limit: s })}>{s}</button>)}
                <input className="input chip-num" type="number" min={5} max={300} aria-label={t('ed.customTime')} value={q.time_limit}
                  onChange={(e) => setQ(i, { time_limit: Math.max(5, Math.min(300, Math.round(Number(e.target.value) || 5))) })} />
              </div>
            </div>
            <div>
              <label className="switch"><input type="checkbox" checked={q.speed_bonus} onChange={(e) => setQ(i, { speed_bonus: e.target.checked })} />{t('ed.speed')}</label>
              <p className="hint">{t('ed.speedHint')}</p>
            </div>
          </div>
        </section>
      ))}

      <button className="btn ghost" onClick={() => edit(() => setQs((a) => [...a, defaultQuestion()]))}>{t('ed.addQuestion')}</button>
    </Shell>
  );
}
