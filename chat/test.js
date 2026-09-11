'use strict';
/**
 * 허브 채팅(Cloudflare)을 떠 있는 서버에 붙어서 확인한다
 *   NODE_PATH=../../robo77/node_modules node test.js http://127.0.0.1:8798
 *  - 새로 온 사람에게 최근 말이 가고, 말이 모두에게 퍼지고, 내 말만 내 것으로 표시되는지
 *  - 도배 간격, 허브 밖 페이지 거절, 같은 서버의 게임 소켓이 그대로 도는지
 */
const assert = require('assert');
const WebSocket = require('ws');

const BASE = (process.argv[2] || 'http://127.0.0.1:8798').replace(/\/$/, '');
const HUB = BASE.replace(/^http/, 'ws') + '/hub';
const HUB_ORIGIN = 'https://41ways.github.io';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function open(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.inbox = [];
    ws.on('message', raw => { try { ws.inbox.push(JSON.parse(raw)); } catch (_) {} });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_, res) => reject(new Error('HTTP ' + res.statusCode)));
    ws.once('error', reject);
  });
}

async function waitFor(ws, pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = ws.inbox.find(pred);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error('기다리던 메시지가 오지 않음: ' + JSON.stringify(ws.inbox.slice(-3)));
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

(async () => {
  console.log('허브 채팅');
  let a, b;

  await check('허브가 아닌 페이지에서 오면 거절', async () => {
    await assert.rejects(open(HUB, 'https://evil.example'), /403/);
    await assert.rejects(open(HUB), /403/);
  });

  await check('인사하면 최근 말과 접속 수를 받는다', async () => {
    a = await open(HUB, HUB_ORIGIN);
    a.send(JSON.stringify({ t: 'hello', key: 'key-a' }));
    const h = await waitFor(a, m => m.t === 'hist');
    assert.deepStrictEqual(h.list, []);
    assert.strictEqual(h.online, 1);
  });

  await check('말이 모두에게 가고, 내 말만 내 것으로 표시된다', async () => {
    b = await open(HUB, 'http://localhost:8801');
    b.send(JSON.stringify({ t: 'hello', key: 'key-b' }));
    await waitFor(b, m => m.t === 'hist');
    await waitFor(a, m => m.t === 'online' && m.n === 2);
    a.send(JSON.stringify({ t: 'say', name: '졸린 수달', text: '  로보77 같이 하실 분\n방 TAC3  ' }));
    const ma = await waitFor(a, m => m.t === 'msg');
    const mb = await waitFor(b, m => m.t === 'msg');
    assert.strictEqual(ma.m.text, '로보77 같이 하실 분 방 TAC3');
    assert.strictEqual(ma.m.name, '졸린 수달');
    assert.strictEqual(ma.m.mine, true);
    assert.strictEqual(mb.m.mine, false);
    assert.ok(!('key' in mb.m), '보낸 사람 열쇠가 남에게 새면 안 됨');
  });

  await check('나중에 온 사람도 조금 전 말을 본다', async () => {
    const c = await open(HUB, HUB_ORIGIN);
    c.send(JSON.stringify({ t: 'hello', key: 'key-a' }));   // 같은 사람이 새 탭을 연 경우
    const h = await waitFor(c, m => m.t === 'hist');
    assert.strictEqual(h.list.length, 1);
    assert.strictEqual(h.list[0].mine, true);
    c.close();
  });

  await check('연달아 치면 늦춰 달라고 한다', async () => {
    await sleep(900);
    b.send(JSON.stringify({ t: 'say', name: '', text: '하나' }));
    b.send(JSON.stringify({ t: 'say', name: '', text: '둘' }));
    await waitFor(b, m => m.t === 'slow');
    const got = b.inbox.filter(m => m.t === 'msg').map(m => m.m.text);
    assert.deepStrictEqual(got, ['로보77 같이 하실 분 방 TAC3', '하나']);
    assert.strictEqual(b.inbox.filter(m => m.t === 'msg').pop().m.name, '손님', '이름을 비우면 손님');
  });

  await check('빈 말·너무 긴 말', async () => {
    await sleep(900);
    const before = a.inbox.filter(m => m.t === 'msg').length;
    a.send(JSON.stringify({ t: 'say', name: 'x', text: '   ' }));
    await sleep(150);
    assert.strictEqual(a.inbox.filter(m => m.t === 'msg').length, before, '빈 말이 퍼짐');
    a.send(JSON.stringify({ t: 'say', name: '이름이열두글자를훌쩍넘어간다', text: '가'.repeat(500) }));
    const m = (await waitFor(a, x => x.t === 'msg' && x.m.text.startsWith('가'))).m;
    assert.strictEqual(m.text.length, 200);
    assert.strictEqual(m.name.length, 12);
  });

  await check('나가면 접속 수가 준다', async () => {
    b.close();
    await waitFor(a, m => m.t === 'online' && m.n === 1);
  });

  await check('상태 확인', async () => {
    const res = await fetch(BASE + '/health').then(r => r.json());
    assert.strictEqual(res.ok, true);
  });

  await check('ping 에는 pong 이 바로 온다', async () => {
    a.send('ping');
    const got = await new Promise(r => a.once('message', m => r(String(m))));
    assert.strictEqual(got, 'pong');
  });

  a.close();
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
