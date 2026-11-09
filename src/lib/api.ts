import { supabase } from './supabase';

export interface QuestionPayload {
  idx: number;
  total: number;
  text: string;
  choices: string[];
  time_limit: number;
  points?: number;
  ends_in_ms?: number;
}
export interface RevealPayload {
  idx: number;
  correct_indexes: number[];
  counts: number[];
  answered: number;
}
export interface TopRow {
  rank: number;
  nickname: string;
  score: number;
  streak: number;
}
export type Status = 'lobby' | 'question' | 'reveal' | 'leaderboard' | 'ended';

export interface JoinResult {
  game_id: string;
  player_id: string;
  token: string;
  shard: number;
  nickname: string;
  title: string;
}
export interface MyResult {
  score: number;
  streak: number;
  rank: number; // 0 = chưa xếp hạng
  correct_count: number;
  last_points: number;
  last_correct: boolean;
  answered: boolean;
}
export interface PlayerState {
  status: Status;
  idx: number;
  total: number;
  title: string;
  score: number;
  streak: number;
  rank: number;
  nickname: string;
  my_choice?: number;
  question?: QuestionPayload;
  ms_left?: number;
  correct_indexes?: number[];
  counts?: number[];
  last_points?: number;
  last_correct?: boolean;
  answered?: boolean;
  top?: TopRow[];
  correct_count?: number;
}
export interface Snapshot {
  game_id: string;
  pin: string;
  title: string;
  status: Status;
  idx: number;
  total: number;
  players: number;
  answered: number;
  ms_left: number | null;
  question: QuestionPayload | null;
  recent?: string[];
  correct_indexes?: number[];
  counts?: number[];
  top?: TopRow[];
}
export interface QuizRow {
  id: string;
  title: string;
  description: string;
  updated_at: string;
  questions: { count: number }[];
}
export interface EditorQuestion {
  text: string;
  choices: string[];
  correct_indexes: number[];
  time_limit: number;
  points: number;
  speed_bonus: boolean;
}
export interface GameRow {
  id: string;
  pin: string;
  title: string;
  status: Status;
  total_questions: number;
  created_at: string;
}
export interface ResultRow { rank: number; nickname: string; score: number; correct_count: number; total_questions: number }

/** Gọi RPC, ném Error(message) với message = mã lỗi từ DB (vd 'nickname_taken'). */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const api = {
  joinGame: (pin: string, nickname: string) => rpc<JoinResult>('join_game', { p_pin: pin, p_nickname: nickname }),
  getPhase: (game: string) => rpc<{ status: Status; idx: number } | null>('get_phase', { p_game: game }),
  getPlayerState: (game: string, player: string, token: string) =>
    rpc<PlayerState>('get_player_state', { p_game: game, p_player: player, p_token: token }),
  getMyResult: (game: string, player: string, token: string) =>
    rpc<MyResult>('get_my_result', { p_game: game, p_player: player, p_token: token }),
  submitAnswer: (game: string, player: string, token: string, qIdx: number, choice: number) =>
    rpc<{ ok: boolean; reason?: string; duplicate?: boolean }>('submit_answer', {
      p_game: game, p_player: player, p_token: token, p_q_idx: qIdx, p_choice: choice,
    }),

  saveQuiz: (id: string | null, title: string, description: string, questions: EditorQuestion[]) =>
    rpc<string>('save_quiz', { p_quiz_id: id, p_title: title, p_description: description, p_questions: questions }),
  createGame: (quizId: string) => rpc<{ game_id: string; pin: string }>('create_game', { p_quiz_id: quizId }),
  hostStart: (game: string) => rpc<{ status: Status }>('host_start_question', { p_game: game }),
  hostReveal: (game: string) => rpc<RevealPayload>('host_reveal', { p_game: game }),
  hostLeaderboard: (game: string) => rpc<{ top: TopRow[]; is_last: boolean }>('host_show_leaderboard', { p_game: game }),
  hostEnd: (game: string) => rpc<null>('host_end_game', { p_game: game }),
  hostSnapshot: (game: string) => rpc<Snapshot>('host_snapshot', { p_game: game }),
  hostResults: (game: string) => rpc<ResultRow[]>('host_results', { p_game: game }),
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const jitter = (maxMs: number) => Math.random() * maxMs;

export const POINT_OPTIONS = [0, 500, 1000, 2000];
export const TIME_OPTIONS = [5, 10, 20, 30, 45, 60, 90, 120];
export const defaultQuestion = (): EditorQuestion => ({
  text: '', choices: ['', '', '', ''], correct_indexes: [0], time_limit: 20, points: 1000, speed_bonus: true,
});
