/**
 * norara 허브 채팅 — 같이 할 사람을 찾는 곳. Cloudflare Worker + Durable Object 하나.
 *
 * 채팅방은 딱 하나(lobby)라 Durable Object 도 하나만 쓴다. 게임 방·판과는 아무 관계가 없다.
 * 연결은 WebSocket Hibernation 으로 받는다. 말이 오가지 않는 동안에는 객체가 잠들어서
 * 켜 둔 탭이 많아도 무료 한도(하루 켜진 시간)를 거의 쓰지 않는다.
 *
 * 막 들어온 사람이 조금 전의 "로보77 같이 하실 분?" 을 볼 수 있게 최근 말 몇 개를 저장소에 둔다.
 * 잠들면 메모리가 비워지므로 메모리만으로는 이 일을 못 한다. 6시간이 지난 말은 지운다.
 */
import { DurableObject } from 'cloudflare:workers';

const KEEP = 40;                    // 새로 들어온 사람에게 보여 줄 최근 말 수
const KEEP_MS = 6 * 60 * 60 * 1000; // 이보다 오래된 말은 지운다
const GAP_MS = 800;                 // 한 사람이 연달아 칠 수 있는 간격
const MAX_TEXT = 200;
const MAX_NAME = 12;
const MAX_PER_IP = 8;               // 한 곳에서 여는 연결 수 — 탭 몇 개는 되고 대량 연결은 막힌다
const IP_GAP_MS = 400;              // 한 곳(주소)에서 나오는 말 사이 간격 — 연결을 새로 열어도 초기화되지 않게
const SLOW_STRIKES = 6;             // 너무 빨리 치는 걸 이만큼 되풀이하면 연결을 끊는다 — 도배가 하루 한도를 태우지 않게
const HELLO_MS = 15_000;            // 인사 없이 자리만 차지하는 연결은 이만큼 뒤 정리한다
const MAX_CLIENTS = 300;

// 허브 페이지와 로컬 개발에서만 받는다. 남의 페이지가 이 채팅을 퍼 가서 쓰지 못하게.
const ORIGINS = [
  /^https:\/\/41ways\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/** 제어 문자·방향 뒤집기 문자와 겹친 공백을 걷어내고 길이를 자른다 */
export function clean(s, n) {
  return String(s == null ? '' : s)
    // 제어 문자, 방향 뒤집기, 폭 없는 글자, 빈칸처럼 보이는 채움 글자(ㅤ U+3164 · 점자 빈칸 · 한글 채움 자모)
    .replace(/[\u0000-\u001f\u007f\u00ad\u115f\u1160\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\u3164\ufeff\uffa0]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n);
}

/** 같은 사람을 한 곳으로 묶는다. IPv6 는 한 집이 /64 한 덩어리를 통째로 받으므로 앞 네 마디로 센다. */
function placeOf(ip) {
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/hub') return new Response('norara chat', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const origin = req.headers.get('Origin') || '';
    if (!ORIGINS.some(re => re.test(origin))) return new Response('forbidden', { status: 403 });
    return env.HUB.get(env.HUB.idFromName('lobby')).fetch(req);
  },
};

export class HubChat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.log = null;
    this.lastByPlace = new Map();   // 잠들면 비워지지만 도배 막기에는 그걸로 충분하다
    // 탭이 살아 있는지 확인하는 ping 에는 객체를 깨우지 않고 가장자리에서 바로 답한다
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const ip = placeOf(req.headers.get('CF-Connecting-IP') || '?');
    const now0 = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const m = this.meta(ws);
      if (!m.greeted && now0 - (m.at || now0) > HELLO_MS) { try { ws.close(4002, 'no hello'); } catch (_) {} }
    }
    const socks = this.ctx.getWebSockets().filter(ws => { try { return ws.readyState === 1; } catch (_) { return false; } });
    if (socks.length >= MAX_CLIENTS) return new Response('busy', { status: 503 });
    if (socks.filter(ws => this.meta(ws).ip === ip).length >= MAX_PER_IP) {
      return new Response('too many', { status: 429 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ip, key: null, greeted: false, last: 0, at: now0, strikes: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  // 연결마다 붙여 둔 정보. 잠들었다 깨어나도 남아 있게 소켓에 직접 붙인다.
  meta(ws) { return ws.deserializeAttachment() || {}; }

  greeted() {
    return this.ctx.getWebSockets().filter(ws => this.meta(ws).greeted);
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* 이미 닫힌 소켓 */ }
  }

  // 보낸 사람 표시는 받는 사람마다 따로 계산한다. 연결 열쇠를 남에게 흘리지 않기 위해서다.
  view(m, key) {
    return { id: m.id, name: m.name, text: m.text, at: m.at, mine: !!m.key && m.key === key };
  }

  async recent() {
    if (!this.log) this.log = (await this.ctx.storage.get('log')) || [];
    const cut = Date.now() - KEEP_MS;
    const before = this.log.length;
    this.log = this.log.filter(m => m.at >= cut);
    if (this.log.length !== before) await this.ctx.storage.put('log', this.log);
    return this.log;
  }

  pushOnline(except) {
    const list = this.greeted().filter(ws => ws !== except);
    for (const ws of list) this.send(ws, { t: 'online', n: list.length });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const me = this.meta(ws);

    if (msg.t === 'hello') {
      me.key = clean(msg.key, 40) || null;
      const first = !me.greeted;
      me.greeted = true;
      ws.serializeAttachment(me);
      if (!first) return;
      const log = await this.recent();
      this.send(ws, { t: 'hist', list: log.map(m => this.view(m, me.key)), online: this.greeted().length });
      this.pushOnline();
      return;
    }

    if (msg.t === 'say') {
      if (!me.greeted) return;
      const now = Date.now();
      if (now - (me.last || 0) < GAP_MS || now - (this.lastByPlace.get(me.ip) || 0) < IP_GAP_MS) {
        me.strikes = (me.strikes || 0) + 1;
        ws.serializeAttachment(me);
        if (me.strikes >= SLOW_STRIKES) { try { ws.close(4003, 'too fast'); } catch (_) {} return; }
        this.send(ws, { t: 'slow' });
        return;
      }
      me.strikes = 0;
      const text = clean(msg.text, MAX_TEXT);
      if (!text) return;
      me.last = now;
      ws.serializeAttachment(me);
      this.lastByPlace.set(me.ip, now);
      // 넘치면 오래된 것만 치운다 — 통째로 비우면 그 순간 누구나 간격 제한을 벗어난다
      if (this.lastByPlace.size > 2000) for (const [k, t] of this.lastByPlace) if (now - t > 10_000) this.lastByPlace.delete(k);

      const log = await this.recent();
      const id = ((log.length && log[log.length - 1].id) || 0) + 1;
      const m = { id, name: clean(msg.name, MAX_NAME) || '손님', text, at: now, key: me.key };
      log.push(m);
      while (log.length > KEEP) log.shift();
      await this.ctx.storage.put('log', log);
      for (const c of this.greeted()) this.send(c, { t: 'msg', m: this.view(m, this.meta(c).key) });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (_) {}
    this.pushOnline(ws);
  }

  async webSocketError(ws) {
    this.pushOnline(ws);
  }
}
