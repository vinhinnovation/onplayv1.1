import { useCallback, useEffect, useRef, useState } from 'react';
import { api, jitter, sleep, type MyResult, type PlayerState, type QuestionPayload, type RevealPayload, type Status, type TopRow } from './api';
import { supabase } from './supabase';

export interface Session {
  gameId: string;
  playerId: string;
  token: string;
  shard: number;
  nickname: string;
  title: string;
  pin?: string;
}
const KEY = 'onquiz.session';
export const loadSession = (): Session | null => {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : null; } catch { return null; }
};
export const saveSession = (s: Session) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } };
export const clearSession = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

export type PlayerPhase = 'loading' | Status | 'invalid';

export interface PlayerView {
  phase: PlayerPhase;
  question: QuestionPayload | null;
  /** thời điểm (performance.now) hết giờ, tính theo đồng hồ cục bộ */
  deadlineAt: number;
  myChoice: number | null;
  missed: boolean;
  reveal: RevealPayload | null;
  result: MyResult | null;
  top: TopRow[];
  connected: boolean;
}

const POLL_OK_MS = 12_000;   // polling dự phòng khi realtime đang OK
const POLL_DOWN_MS = 3_000;  // khi realtime mất kết nối

/**
 * Trạng thái phía người chơi.
 * Nguồn sự kiện chính: Realtime Broadcast (private channel game:<id>:<shard>) do DB phát.
 * Dự phòng: get_phase (rất nhẹ) theo chu kỳ + hydrate đầy đủ khi lệch trạng thái.
 */
export function usePlayerGame(session: Session) {
  const [v, setV] = useState<PlayerView>({
    phase: 'loading', question: null, deadlineAt: 0, myChoice: null, missed: false,
    reveal: null, result: null, top: [], connected: false,
  });
  const phaseRef = useRef<PlayerPhase>('loading');
  const idxRef = useRef(-2);
  const connectedRef = useRef(false);
  const aliveRef = useRef(true);

  const patch = useCallback((p: Partial<PlayerView>) => {
    if (p.phase) phaseRef.current = p.phase;
    setV((o) => ({ ...o, ...p }));
  }, []);

  /** Lấy điểm/hạng cá nhân sau jitter ngẫu nhiên để dàn đều ~5.000 request */
  const fetchResult = useCallback((delayMs: number) => {
    const run = async (attempt: number) => {
      try {
        const r = await api.getMyResult(session.gameId, session.playerId, session.token);
        if (aliveRef.current) patch({ result: r });
      } catch (e) {
        if (!aliveRef.current) return;
        if (e instanceof Error && e.message === 'invalid_player') { patch({ phase: 'invalid' }); return; }
        if (attempt < 3) { await sleep(800 * (attempt + 1) + jitter(800)); await run(attempt + 1); }
      }
    };
    setTimeout(() => { void run(0); }, delayMs);
  }, [session, patch]);

  const applyQuestion = useCallback((q: QuestionPayload, msLeft: number, myChoice: number | null) => {
    idxRef.current = q.idx;
    patch({ phase: 'question', question: q, deadlineAt: performance.now() + msLeft, myChoice, missed: false, reveal: null });
  }, [patch]);

  const hydrate = useCallback(async () => {
    try {
      const s: PlayerState = await api.getPlayerState(session.gameId, session.playerId, session.token);
      idxRef.current = s.idx;
      const result: MyResult = {
        score: s.score, streak: s.streak, rank: s.rank, correct_count: s.correct_count ?? 0,
        last_points: s.last_points ?? 0, last_correct: s.last_correct ?? false, answered: s.answered ?? false,
      };
      switch (s.status) {
        case 'lobby': patch({ phase: 'lobby', result }); break;
        case 'question':
          if (s.question) {
            applyQuestion(s.question, s.ms_left ?? 0, s.my_choice ?? null);
            patch({ result });
          }
          break;
        case 'reveal':
        case 'leaderboard':
          patch({
            phase: s.status, result, top: s.top ?? [],
            reveal: { idx: s.idx, correct_indexes: s.correct_indexes ?? [], counts: s.counts ?? [], answered: 0 },
            myChoice: s.my_choice ?? null,
          });
          break;
        case 'ended': patch({ phase: 'ended', result, top: s.top ?? [] }); break;
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'invalid_player') patch({ phase: 'invalid' });
    }
  }, [session, patch, applyQuestion]);

  useEffect(() => {
    aliveRef.current = true;
    void hydrate();

    // --- Realtime (private channel, chỉ nhận) ---
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void (async () => {
      await supabase.realtime.setAuth();
      if (!aliveRef.current) return;
      channel = supabase
        .channel(`game:${session.gameId}:${session.shard}`, { config: { private: true } })
        .on('broadcast', { event: 'question' }, ({ payload }) => {
          const q = payload as QuestionPayload;
          if (idxRef.current === q.idx && phaseRef.current === 'question') return; // trùng với hydrate
          applyQuestion(q, q.ends_in_ms ?? q.time_limit * 1000, null);
        })
        .on('broadcast', { event: 'reveal' }, ({ payload }) => {
          const r = payload as RevealPayload;
          if (phaseRef.current === 'reveal' && idxRef.current === r.idx) return;
          idxRef.current = r.idx;
          patch({ phase: 'reveal', reveal: r });
          fetchResult(jitter(3000));
        })
        .on('broadcast', { event: 'leaderboard' }, ({ payload }) => {
          patch({ phase: 'leaderboard', top: (payload as { top: TopRow[] }).top });
        })
        .on('broadcast', { event: 'ended' }, ({ payload }) => {
          patch({ phase: 'ended', top: (payload as { top: TopRow[] }).top });
          fetchResult(jitter(4000));
        })
        .subscribe((status) => {
          const ok = status === 'SUBSCRIBED';
          connectedRef.current = ok;
          patch({ connected: ok });
          if (ok) void hydrate(); // vừa (tái) kết nối: đồng bộ lại để không lỡ sự kiện
        });
    })();

    // --- Polling dự phòng, có jitter ---
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const p = await api.getPhase(session.gameId);
        if (p && (p.status !== phaseRef.current || p.idx !== idxRef.current)) await hydrate();
        if (!p) patch({ phase: 'invalid' });
      } catch { /* mạng chập chờn: thử lại ở lần sau */ }
      if (aliveRef.current) timer = setTimeout(() => { void tick(); }, (connectedRef.current ? POLL_OK_MS : POLL_DOWN_MS) + jitter(3000));
    };
    timer = setTimeout(() => { void tick(); }, POLL_OK_MS / 2 + jitter(4000));

    return () => {
      aliveRef.current = false;
      clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [session, hydrate, applyQuestion, patch, fetchResult]);

  const choose = useCallback(async (choice: number) => {
    const q = v.question;
    if (!q || phaseRef.current !== 'question' || v.myChoice !== null) return;
    patch({ myChoice: choice });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await api.submitAnswer(session.gameId, session.playerId, session.token, q.idx, choice);
        if (!r.ok) patch({ missed: true });
        return;
      } catch (e) {
        if (e instanceof Error && e.message === 'invalid_player') { patch({ phase: 'invalid' }); return; }
        await sleep(300 * (attempt + 1) + jitter(300));
      }
    }
  }, [v.question, v.myChoice, session, patch]);

  return { view: v, choose };
}
