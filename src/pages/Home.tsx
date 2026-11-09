import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Shell } from '../components/Shared';
import { useI18n } from '../lib/i18n';
import { isConfigured } from '../lib/supabase';
import { clearSession, loadSession } from '../lib/usePlayerGame';

export function Home() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [pin, setPin] = useState('');
  const [saved, setSaved] = useState(loadSession);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d{6}$/.test(pin)) nav(`/join/${pin}`);
  };

  return (
    <Shell theme="brand">
      <div className="hero">
        <div>
          <h1>{t('app.name')}</h1>
          <p>{t('app.tagline')}</p>
        </div>
        <div className="stack">
          {!isConfigured && <p className="err">{t('common.notConfigured')}</p>}
          {saved && (
            <div className="card">
              <p style={{ marginTop: 0 }}><b>{t('join.rejoin')}</b>: {saved.title} ({saved.nickname})</p>
              <div className="row">
                <button className="btn teal" onClick={() => nav('/play')}>{t('join.rejoinBtn')}</button>
                <button className="btn ghost" onClick={() => { clearSession(); setSaved(null); }}>{t('join.leave')}</button>
              </div>
            </div>
          )}
          <form className="card" onSubmit={submit}>
            <label className="field">
              <span>{t('home.pinHint')}</span>
              <input
                className="input pin-input" inputMode="numeric" autoComplete="off" placeholder="000000" maxLength={6}
                value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                aria-label={t('home.pin')}
              />
            </label>
            <button className="btn big" style={{ width: '100%' }} disabled={pin.length !== 6}>{t('home.join')}</button>
          </form>
          <div className="home-actions">
            <Link to="/host" className="btn ghost">{t('home.host')}</Link>
          </div>
        </div>
      </div>
    </Shell>
  );
}
