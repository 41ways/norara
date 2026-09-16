/**
 * norara 오류 수집 — 게임 화면에서 터진 오류를 한곳에 모은다.
 *
 * 화면은 window.onerror 와 처리되지 않은 Promise 거절을 sendBeacon 으로 여기에 보낸다.
 * sendBeacon 은 text/plain 으로 나가서 미리 확인 요청(preflight)이 없다 — 그래서 CORS 설정이 필요 없다.
 *
 * 같은 오류(앱·메시지·파일·줄)는 한 줄에 쌓아 세기만 한다. 사람이 볼 것은 "무엇이 몇 번" 이지
 * 같은 줄 수천 개가 아니다. 그래야 D1 무료 한도(하루 쓰기 10만)도 넉넉하다.
 *
 * 보기: GET /?key=...  (표)  ·  GET /list?key=...  (JSON)
 */

const MAX_BODY = 4000;          // 한 건에 담을 수 있는 크기
const MAX_ROWS = 4000;          // 이보다 많아지면 오래된 것부터 지운다
const MAX_TEXT = 300;           // 메시지·주소 자르는 길이
const MAX_STACK = 1200;
const IP_PER_MIN = 20;          // 한 곳에서 1분에 받는 건수

// 우리 화면에서 온 것만 받는다.
const ORIGINS = [
  /^https:\/\/41ways\.github\.io$/,
  /^https:\/\/[a-z0-9-]+\.41ways\.workers\.dev$/,
  /^https:\/\/mug0\.onrender\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

// 우리 코드가 아닌 것들 — 확장 프로그램, 남의 스크립트
const JUNK_SRC = [
  /^chrome-extension:/, /^moz-extension:/, /^safari-(web-)?extension:/,
  /^webkit-masked-url:/, /^about:/,
];
const JUNK_MSG = [
  /^Script error\.?$/i,                       // 남의 출처 스크립트 — 내용을 알 수 없다
  /ResizeObserver loop/i,                     // 브라우저가 스스로 회복하는 경고
];

const cut = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const num = v => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

/** 같은 오류를 한 줄로 묶는 열쇠 */
async function keyOf(app, msg, src, line) {
  const raw = [app, msg, src || '', line == null ? '' : line].join('|');
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

const hits = new Map();         // 잠깐 켜져 있는 동안만 기억한다. 도배를 늦추는 용도.
function tooMany(ip, now) {
  const live = (hits.get(ip) || []).filter(t => now - t < 60000);
  live.push(now);
  hits.set(ip, live);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  }
  return live.length > IP_PER_MIN;
}

async function report(req, env) {
  const origin = req.headers.get('Origin') || '';
  if (!ORIGINS.some(re => re.test(origin))) return new Response('forbidden', { status: 403 });

  const ip = req.headers.get('CF-Connecting-IP') || '?';
  const now = Date.now();
  if (tooMany(ip, now)) return new Response('slow down', { status: 429 });

  const text = (await req.text()).slice(0, MAX_BODY);
  let o;
  try { o = JSON.parse(text); } catch (_) { return new Response('bad json', { status: 400 }); }
  if (!o || typeof o !== 'object') return new Response('bad', { status: 400 });

  const app = cut(o.app, 40) || 'unknown';
  const msg = cut(o.msg, MAX_TEXT);
  const src = cut(o.src, MAX_TEXT);
  if (!msg) return new Response('no message', { status: 400 });
  if (JUNK_MSG.some(re => re.test(msg))) return new Response('ignored', { status: 202 });
  if (src && JUNK_SRC.some(re => re.test(src))) return new Response('ignored', { status: 202 });

  const line = num(o.line), col = num(o.col);
  const id = await keyOf(app, msg, src, line);

  // 이미 본 오류면 세기만 한다
  const r = await env.DB.prepare(
    'UPDATE errs SET n = n + 1, last_at = ?, stack = COALESCE(?, stack), page = COALESCE(?, page) WHERE id = ?'
  ).bind(now, cut(o.stack, MAX_STACK), cut(o.page, MAX_TEXT), id).run();

  if (!r.meta.changes) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO errs (id, app, msg, src, line, col, stack, ua, page, n, first_at, last_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).bind(id, app, msg, src, line, col, cut(o.stack, MAX_STACK),
      cut(req.headers.get('User-Agent'), MAX_TEXT), cut(o.page, MAX_TEXT), now, now).run();

    // 새 줄이 늘어날 때만 청소한다 — 세기만 할 때는 건드리지 않는다
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS c FROM errs').all();
    const c = (results[0] && results[0].c) || 0;
    if (c > MAX_ROWS) {
      await env.DB.prepare(
        'DELETE FROM errs WHERE id IN (SELECT id FROM errs ORDER BY last_at ASC LIMIT ?)'
      ).bind(c - MAX_ROWS).run();
    }
  }
  return new Response('ok');
}

const esc = t => String(t == null ? '' : t)
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = t => new Date(t + 9 * 3600000).toISOString().replace('T', ' ').slice(5, 16);

/** 사람이 열어 보는 표 — 최근에 터진 것부터 */
function page(rows) {
  const tr = rows.map(r => '<tr>' +
    '<td class="n">' + r.n + '</td>' +
    '<td><b>' + esc(r.app) + '</b></td>' +
    '<td class="m">' + esc(r.msg) +
      '<div class="s">' + esc(r.src || '') + (r.line ? ':' + r.line : '') +
      (r.page ? ' · ' + esc(r.page) : '') + '</div></td>' +
    '<td class="t">' + when(r.last_at) + '<div class="s">처음 ' + when(r.first_at) + '</div></td>' +
    '</tr>').join('');

  return '<!doctype html><meta charset="utf-8"><title>norara 오류</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{font:14px/1.6 -apple-system,"Apple SD Gothic Neo",system-ui,sans-serif;margin:0;padding:22px;background:#faf7f0;color:#2f2a23}' +
    'h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 16px;color:#7b7260;font-size:13px}' +
    'table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e2d9c6;border-radius:10px;overflow:hidden}' +
    'td,th{padding:9px 11px;border-bottom:1px solid #efe8da;vertical-align:top;text-align:left}' +
    'th{background:#f4efe3;font-size:12px;color:#6e6555}' +
    'td.n{font-weight:800;color:#c0392b;white-space:nowrap}' +
    'td.m{word-break:break-all}' +
    'td.t{white-space:nowrap;color:#6e6555;font-size:12.5px}' +
    '.s{font-size:11.5px;color:#9a8f7a;word-break:break-all}' +
    '.empty{padding:40px;text-align:center;color:#9a8f7a;background:#fff;border:1px solid #e2d9c6;border-radius:10px}' +
    '</style>' +
    '<h1>norara 오류</h1>' +
    '<p class="sub">게임 화면에서 터진 오류. 같은 오류는 한 줄에 모아 셌음.</p>' +
    (rows.length
      ? '<table><tr><th>수</th><th>게임</th><th>오류</th><th>마지막</th></tr>' + tr + '</table>'
      : '<div class="empty">아직 들어온 오류가 없음</div>');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/report') {
      if (req.method !== 'POST') return new Response('post only', { status: 405 });
      return report(req, env);
    }

    // 보기 — 열쇠가 맞아야 한다
    if (url.pathname === '/' || url.pathname === '/list') {
      if (!env.VIEW_KEY || url.searchParams.get('key') !== env.VIEW_KEY) {
        return new Response('nope', { status: 401 });
      }
      const app = url.searchParams.get('app');
      const q = app
        ? env.DB.prepare('SELECT * FROM errs WHERE app = ? ORDER BY last_at DESC LIMIT 200').bind(app)
        : env.DB.prepare('SELECT * FROM errs ORDER BY last_at DESC LIMIT 200');
      const { results } = await q.all();
      if (url.pathname === '/list') return Response.json({ rows: results });
      return new Response(page(results), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return new Response('norara errors', { status: 404 });
  },
};
