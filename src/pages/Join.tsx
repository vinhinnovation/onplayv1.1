import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Shell } from '../components/Shared';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { saveSession } from '../lib/usePlayerGame';

export function Join() {
  const { t, err } = useI18n();
  const nav = useNavigate();
  const params = useParams();
  const [pin, setPin] = useState((params.pin ?? '').replace(/\D/g, '').slice(0, 6));
  const [nick, setNick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await api.joinGame(pin, nick);
      saveSession({ gameId: r.game_id, playerId: r.player_id, token: r.token, shard: r.shard, nickname: r.nickname, title: r.title, pin });
      nav('/play', { replace: true });
    } catch (ex) {
      setError(err(ex));
      setBusy(false);
    }
  };

  return (
    <Shell theme="brand" back="/">
      <form className="card stack" onSubmit={(e) => { void submit(e); }} style={{ maxWidth: 440, margin: '24px auto' }}>
        <h2>{t('home.join')}</h2>
        {error && <p className="err" role="alert">{error}</p>}
        <label className="field">
          <span>{t('home.pin')}</span>
          <input className="input pin-input" inputMode="numeric" autoComplete="off" maxLength={6} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        <label className="field">
          <span>{t('join.nickname')}</span>
          <input className="input" maxLength={20} autoFocus={pin.length === 6} value={nick} onChange={(e) => setNick(e.target.value)} />
        </label>
        <button className="btn big" style={{ width: '100%' }} disabled={busy || pin.length !== 6 || nick.trim().length === 0}>
          {busy ? t('common.loading') : t('join.go')}
        </button>
      </form>
    </Shell>
  );
}
