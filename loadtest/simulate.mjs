#!/usr/bin/env node
/**
 * Giả lập N người chơi để kiểm tra tải TRƯỚC sự kiện lớn (chỉ gọi RPC qua HTTP, không dùng websocket).
 * Đo độ trễ của join_game và submit_answer, đồng thời thử chạy 1 game đầy đủ bằng tài khoản host.
 *
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=... \
 *   HOST_EMAIL=host@congty.vn HOST_PASSWORD=... PLAYERS=1000 node loadtest/simulate.mjs
 *
 * Chú ý: chạy trên Supabase project THẬT sẽ tạo 1 game + N người chơi trong DB (game hiển thị trong lịch sử host).
 * Nên chạy trên project staging, hoặc xóa game test sau đó. Một máy đơn lẻ có thể bị giới hạn băng thông/IP trước khi chạm giới hạn của Supabase.
 */
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
const N = Number(process.env.PLAYERS ?? 200), CONC = Number(process.env.CONCURRENCY ?? 100);
if (!URL_ || !KEY || !process.env.HOST_EMAIL || !process.env.HOST_PASSWORD) {
  console.error('Thiếu biến môi trường: SUPABASE_URL, SUPABASE_ANON_KEY, HOST_EMAIL, HOST_PASSWORD'); process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lat = { join: [], answer: [], result: [] }; let failures = 0;

async function rpc(fn, body, token = KEY, bucket) {
  const t0 = performance.now();
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (bucket) lat[bucket].push(performance.now() - t0);
  const j = await r.json().catch(() => null);
  if (!r.ok) { failures++; throw new Error(`${fn}: ${j?.message ?? r.status}`); }
  return j;
}
async function pool(items, size, fn) { const q = [...items]; await Promise.all(Array.from({ length: size }, async () => { for (let x; (x = q.shift()) !== undefined;) await fn(x).catch(() => {}); })); }
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(0) : '-');
const report = (k) => console.log(`${k.padEnd(7)} n=${lat[k].length}  p50=${pct(lat[k], .5)}ms  p95=${pct(lat[k], .95)}ms  max=${pct(lat[k], 1)}ms`);

const auth = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.HOST_EMAIL, password: process.env.HOST_PASSWORD }) })).json();
const H = auth.access_token; if (!H) { console.error('Đăng nhập host thất bại:', auth); process.exit(1); }

const quizId = await rpc('save_quiz', { p_quiz_id: null, p_title: `[LOADTEST] ${new Date().toISOString()}`, p_description: '', p_questions: [
  { text: 'Q1', choices: ['A', 'B', 'C', 'D'], correct_indexes: [0], time_limit: 20, points: 1000, speed_bonus: true },
  { text: 'Q2', choices: ['A', 'B'], correct_indexes: [1], time_limit: 20, points: 1000, speed_bonus: true }] }, H);
const { game_id: gid, pin } = await rpc('create_game', { p_quiz_id: quizId }, H);
console.log(`Game ${pin}: đang cho ${N} người chơi vào phòng (đồng thời ${CONC})…`);

const players = [];
await pool(Array.from({ length: N }, (_, i) => i), CONC, async (i) => players.push(await rpc('join_game', { p_pin: pin, p_nickname: `bot${i}` }, KEY, 'join')));
console.log(`Vào phòng: ${players.length}/${N}`); report('join');

for (let q = 0; q < 2; q++) {
  await rpc('host_start_question', { p_game: gid }, H);
  const t0 = performance.now();
  await pool(players, CONC, (p) => rpc('submit_answer', { p_game: gid, p_player: p.player_id, p_token: p.token, p_q_idx: q, p_choice: Math.floor(Math.random() * 2) }, KEY, 'answer'));
  console.log(`Câu ${q + 1}: ${players.length} câu trả lời trong ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const t1 = performance.now(); await rpc('host_reveal', { p_game: gid }, H); console.log(`  host_reveal (chấm điểm ${players.length} người): ${(performance.now() - t1).toFixed(0)}ms`);
  await pool(players, CONC, (p) => rpc('get_my_result', { p_game: gid, p_player: p.player_id, p_token: p.token }, KEY, 'result'));
}
await rpc('host_end_game', { p_game: gid }, H);
report('answer'); report('result'); console.log(`Lỗi: ${failures}`);
console.log('Ngưỡng tham khảo: p95 < 800ms và 0 lỗi. Nếu vượt, tăng compute của database trước sự kiện.');
