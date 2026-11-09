import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Shell } from '../components/Shared';
import { api, normalizeSlug } from '../lib/api';
import { useI18n } from '../lib/i18n';

/** /:slug -> hỏi server PIN của game đang mở với link này -> chuyển sang /join/<pin> để nhập biệt danh. */
export function SlugJoin() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { slug = '' } = useParams();
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    const s = normalizeSlug(slug);
    if (s.length < 3) { setNotFound(true); return; }
    api.resolveSlug(s)
      .then((r) => { if (alive) nav(`/join/${r.pin}`, { replace: true }); })
      .catch(() => { if (alive) setNotFound(true); });
    return () => { alive = false; };
  }, [slug, nav]);

  return (
    <Shell theme="brand" back="/">
      <div className="card stack center" style={{ maxWidth: 440, margin: '24px auto' }}>
        {notFound ? (
          <>
            <p className="err" role="alert">{t('slug.notFound')}</p>
            <Link to="/join" className="btn big" style={{ width: '100%' }}>{t('slug.enterPin')}</Link>
          </>
        ) : <p>{t('slug.resolving')}</p>}
      </div>
    </Shell>
  );
}
