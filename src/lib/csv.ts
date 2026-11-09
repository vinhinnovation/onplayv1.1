import type { EditorQuestion } from './api';

/** Parser CSV tối giản: hỗ trợ dấu ngoặc kép, dấu phẩy/chấm phẩy, BOM, xuống dòng CRLF. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** Cột correct: "A", "B", hoặc nhiều đáp án đúng "A+C" / "AC" / "1+3". Cột points và time_limit không bắt buộc. */
export const CSV_TEMPLATE =
  'question,A,B,C,D,correct,time_limit,points\n' +
  '"Thủ đô của Việt Nam là gì?",Hà Nội,TP.HCM,Đà Nẵng,Huế,A,20,1000\n' +
  '"Những thành phố nào ở miền Trung?",Đà Nẵng,Huế,Cần Thơ,Hải Phòng,A+B,30,2000\n' +
  '"2 + 2 = ?",3,4,,,B,10,500\n';

function parseCorrect(raw: string, n: number): number[] | null {
  const s = raw.toUpperCase();
  const set = new Set<number>();
  for (const ch of s) {
    if ('ABCD'.includes(ch)) set.add('ABCD'.indexOf(ch));
    else if ('1234'.includes(ch)) set.add(Number(ch) - 1);
  }
  const arr = [...set].sort();
  return arr.length > 0 && arr.every((i) => i < n) ? arr : null;
}

/** Chuyển CSV -> danh sách câu hỏi. Trả về lỗi theo dòng. */
export function csvToQuestions(input: string): { questions: EditorQuestion[]; errors: string[] } {
  const rows = parseCsv(input);
  const errors: string[] = [];
  const questions: EditorQuestion[] = [];
  const start = rows[0]?.[0]?.trim().toLowerCase() === 'question' ? 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const [text, a, b, c, d, correct, time, pts] = rows[r].map((x) => (x ?? '').trim());
    const line = r + 1;
    // Chỉ giữ các lựa chọn liên tục từ A (không cho phép "lỗ hổng" giữa các đáp án)
    const choices: string[] = [];
    for (const x of [a, b, c, d]) { if (x) choices.push(x); else break; }
    if (!text) { errors.push(`Dòng ${line}: thiếu nội dung câu hỏi`); continue; }
    if (choices.length < 2) { errors.push(`Dòng ${line}: cần ít nhất 2 đáp án liên tiếp từ cột A`); continue; }
    const idx = parseCorrect(correct ?? '', choices.length);
    if (!idx) { errors.push(`Dòng ${line}: cột correct phải là A–D (vd A hoặc A+C) và trỏ tới đáp án có nội dung`); continue; }
    const t = time ? Number(time) : 20;
    if (!Number.isFinite(t) || t < 5 || t > 300) { errors.push(`Dòng ${line}: time_limit phải từ 5 đến 300 giây`); continue; }
    const p = pts ? Number(pts) : 1000;
    if (!Number.isFinite(p) || p < 0 || p > 10000) { errors.push(`Dòng ${line}: points phải từ 0 đến 10000`); continue; }
    questions.push({ text, choices, correct_indexes: idx, time_limit: Math.round(t), points: Math.round(p), speed_bonus: true });
  }
  return { questions, errors };
}

export function toCsv(rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    // Chống CSV/Excel formula injection từ nickname do người chơi tự nhập
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
