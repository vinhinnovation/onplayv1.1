import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shell } from '../components/Shared';
import { useI18n } from '../lib/i18n';
import { isConfigured, supabase } from '../lib/supabase';
import { useHostAuth } from '../lib/useHostAuth';

const GOOGLE = import.meta.env.VITE_ENABLE_GOOGLE === 'true';
// Đặt VITE_ENABLE_SIGNUP=false để ẩn nút đăng ký (host do admin tạo sẵn trong Supabase Auth)
const SIGNUP = import.meta.env.VITE_ENABLE_SIGNUP !== 'false';

export function HostLogin() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { session } = useHostAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);

  useEffect(() => { if (session) nav('/host', { replace: true }); }, [session, nav]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + '/host' } });
        if (error) throw error;
        if (!data.session) setMsg({ kind: 'ok', text: t('host.checkEmail') });
      }
    } catch (ex) {
      setMsg({ kind: 'err', text: ex instanceof Error ? ex.message : t('common.error') });
    } finally { setBusy(false); }
  };

  const google = async () => {
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + '/host' } });
  };

  return (
    <Shell theme="brand" back="/">
      <form className="card stack" onSubmit={(e) => { void submit(e); }} style={{ maxWidth: 440, margin: '24px auto' }}>
        <h2>{t('host.login')}</h2>
        {!isConfigured && <p className="err">{t('common.notConfigured')}</p>}
        {msg && <p className={msg.kind === 'err' ? 'err' : 'ok-note'} role="alert">{msg.text}</p>}
        <label className="field"><span>{t('host.email')}</span>
          <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>{t('host.password')}</span>
          <input className="input" type="password" required minLength={8} autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="btn big" style={{ width: '100%' }} disabled={busy}>{mode === 'in' ? t('host.signin') : t('host.signup')}</button>
        {GOOGLE && <button type="button" className="btn ghost" style={{ width: '100%' }} onClick={() => { void google(); }}>{t('host.google')}</button>}
        {SIGNUP && <button type="button" className="link" style={{ color: 'var(--teal)' }} onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(null); }}>
          {mode === 'in' ? t('host.switchSignup') : t('host.switchSignin')}
        </button>}
      </form>
    </Shell>
  );
}
