#!/usr/bin/env node
/**
 * P1–P7 链上名单采集器
 * 规则：真实 DAI 投入 + 推荐关系 + 当前剩余锁仓价值。
 * 注意：官方“三个区”划分未公开，本脚本按每个地址最大的三条直推线估算。
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const RPC = 'https://rpc.anubispace.org';
const COMM = '0xc9f9a8a2dBf8188AD6610e0239105CAbE67c4993';
const MEMBER_SEL = '0x08ae4b0c';
const VE = '0x52D7f7745D4Ba3dE6C3A0B503815878aeE7eDf14';
const POS_OF = '0xf867d46b';
const POS = '0x99fbab88';
const BASE = 'https://browser.anubispace.org/api';
const POWER = '0x9E68F61E2615cc1D2C4a2D0026bFc1EBFdf68C1b';
const POWER_TOPIC = '0x41fd86243836b698405554ae311d223dec7e355200f05fd658fb3adffe567668';
const FLOW_START = 15042314;
const ROOT = '0x159ec1f43d18ff1f275156a4a8b0e53503503c1b';
const ORIGIN = '0x0000000000000000000000000000000000000001';
const LEVELS = ['P1','P2','P3','P4','P5','P6','P7'];
const ZONE_NEED = [50000,150000,500000,1500000,4000000];
const VE_NEED = [1000,3000,5000,8000,10000,15000,20000];
const pad = (v) => BigInt(v).toString(16).padStart(64,'0');

async function json(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opts));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 400 * (i + 1))); }
  }
  throw last;
}

async function rpc(data, to = COMM) {
  const j = await json(RPC, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']}) });
  return j.result || null;
}

async function head() {
  const j = await json(RPC, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]}) });
  return parseInt(j.result, 16);
}

async function getPowerLogs(from, to) {
  const u = BASE + '?module=logs&action=getLogs&address=' + POWER + '&fromBlock=' + from + '&toBlock=' + to + '&topic0=' + POWER_TOPIC;
  const j = await json(u);
  if (Array.isArray(j.result)) return j.result;
  if (/No logs found/i.test(String(j.message || ''))) return [];
  throw new Error(j.message || 'power logs failed');
}

async function collectPower() {
  const end = await head();
  const queue = [];
  for (let a = FLOW_START; a <= end; a += 100000) queue.push([a, Math.min(end, a + 99999)]);
  const all = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const task = queue[idx++];
      if (!task) break;
      const [a,b] = task;
      const logs = await getPowerLogs(a,b);
      if (logs.length >= 1000 && b > a) {
        const m = Math.floor((a+b)/2);
        queue.push([a,m],[m+1,b]);
      } else all.push(...logs);
    }
  }
  await Promise.all(Array.from({length:6}, worker));
  const own = new Map();
  for (const x of all) {
    const a = '0x' + x.topics[1].slice(26);
    const w = String(x.data).slice(2).match(/.{64}/g) || [];
    const dai = w[0] ? Number(BigInt('0x' + w[0])) / 1e18 : 0;
    own.set(a, (own.get(a) || 0) + dai);
  }
  return own;
}

async function memberBatch(addrs) {
  const body = addrs.map((a,i) => ({jsonrpc:'2.0',id:i,method:'eth_call',params:[{to:COMM,data:MEMBER_SEL + a.slice(2).padStart(64,'0')},'latest']}));
  const j = await json(RPC, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if (!Array.isArray(j)) throw new Error('member batch failed');
  return addrs.map((a,i) => j.find((x) => x.id === i)?.result || null);
}

async function mapMembers(addresses) {
  const mem = new Map();
  let pending = [...addresses];
  while (pending.length) {
    const uniq = [...new Set(pending.filter((a) => !mem.has(a)))];
    if (!uniq.length) break;
    const chunks = [];
    for (let i = 0; i < uniq.length; i += 50) chunks.push(uniq.slice(i,i+50));
    const results = new Array(chunks.length);
    let idx = 0;
    async function worker(){
      while (true) {
        const k = idx++;
        if (k >= chunks.length) break;
        results[k] = await memberBatch(chunks[k]);
      }
    }
    await Promise.all(Array.from({length:8}, worker));
    const rows = results.flat();
    const next = [];
    uniq.forEach((a,i) => {
      const h = rows[i];
      if (!h) { mem.set(a,{depth:null,parent:null}); return; }
      const depth = Number(BigInt('0x' + h.slice(2,66)));
      const ref = '0x' + h.slice(90,130).toLowerCase();
      const parent = (ref === ORIGIN || ref === ROOT || ref === a || depth <= 1) ? null : ref;
      mem.set(a,{depth,parent});
      if (parent && !mem.has(parent)) next.push(parent);
    });
    pending = next;
  }
  return mem;
}

async function veLocked(a) {
  const r = await rpc(POS_OF + a.slice(2).padStart(64,'0'), VE);
  if (!r) return 0;
  const h = r.slice(2);
  const off = Number(BigInt('0x' + h.slice(0,64))) * 2;
  const n = Number(BigInt('0x' + h.slice(off, off+64)));
  let sum = 0n;
  for (let i = 0; i < n; i++) {
    const id = BigInt('0x' + h.slice(off+64+i*64, off+128+i*64));
    const q = await rpc(POS + id.toString(16).padStart(64,'0'), VE);
    if (!q) continue;
    const w = q.slice(2).match(/.{64}/g) || [];
    if (w[2]) sum += BigInt('0x' + w[2]);
  }
  return Number(sum) / 1e18;
}

const own = await collectPower();
console.log('[levels] power users:', own.size);
const mem = await mapMembers([...own.keys()]);
console.log('[levels] members:', mem.size);
const nodes = new Set([...own.keys(), ...mem.keys()]);
const children = new Map();
for (const a of nodes) children.set(a, []);
for (const [a,m] of mem) {
  if (!m.parent) continue;
  if (!children.has(m.parent)) children.set(m.parent, []);
  children.get(m.parent).push(a);
}
const subtree = new Map();
const sorted = [...nodes].sort((a,b) => (mem.get(b)?.depth ?? -1) - (mem.get(a)?.depth ?? -1));
for (const a of sorted) {
  let total = own.get(a) || 0;
  for (const c of children.get(a) || []) total += subtree.get(c) || 0;
  subtree.set(a, total);
}
const zone = new Map();
for (const a of nodes) {
  const zones = (children.get(a) || []).map((c) => subtree.get(c) || 0).sort((x,y) => y-x).slice(0,3);
  let idx = -1;
  for (let i = 0; i < ZONE_NEED.length; i++) if (zones.length >= 3 && zones.every((v) => v >= ZONE_NEED[i])) idx = i;
  zone.set(a, { zones, idx });
}
const priceFile = join(DIR,'data.json');
let price = 0;
try { price = JSON.parse(fs.readFileSync(priceFile,'utf8')).protocol?.priceDAI || 0; } catch (e) {}
const candidates = [...nodes].filter((a) => zone.get(a).idx >= 0);
const details = new Map();
let idx = 0;
async function worker() {
  while (true) {
    const k = idx++;
    if (k >= candidates.length) break;
    const a = candidates[k];
    const locked = await veLocked(a);
    const lockValue = locked * price;
    let veIdx = -1;
    for (let i = 0; i < VE_NEED.length; i++) if (lockValue >= VE_NEED[i]) veIdx = i;
    details.set(a, { locked, lockValue, veIdx });
  }
}
await Promise.all(Array.from({length:8}, worker));
const final = new Map();
for (const a of candidates) {
  const z = zone.get(a).idx;
  const v = details.get(a).veIdx;
  final.set(a, z >= 0 && v >= 0 ? LEVELS[Math.min(z,v)] : null);
}
for (let round = 0; round < 7; round++) {
  for (const a of candidates) {
    const d = details.get(a);
    const kids = (children.get(a) || []).map((c) => final.get(c));
    if (d.veIdx >= 5 && kids.filter((x) => x === 'P5').length >= 3) final.set(a,'P6');
    if (d.veIdx >= 6 && kids.filter((x) => x === 'P6').length >= 3) final.set(a,'P7');
  }
}
const by = Object.fromEntries(LEVELS.map((lv) => [lv,[]]));
for (const a of candidates) {
  const lv = final.get(a);
  if (!lv) continue;
  const z = zone.get(a), d = details.get(a);
  by[lv].push({
    address:a,
    zone1:z.zones[0] || 0,
    zone2:z.zones[1] || 0,
    zone3:z.zones[2] || 0,
    teamDai:subtree.get(a) || 0,
    ownDai:own.get(a) || 0,
    directChildren:(children.get(a) || []).length,
    lockedAiLGNS:d.locked,
    lockValueDai:d.lockValue,
    zoneLevel:z.idx >= 0 ? LEVELS[z.idx] : null,
    finalLevel:lv
  });
}
for (const lv of LEVELS) by[lv].sort((a,b) => b.teamDai - a.teamDai);
const counts = Object.fromEntries(LEVELS.map((lv) => [lv,by[lv].length]));
const out = {
  generatedAt:new Date().toISOString(),
  method:'PowerRecorded真实DAI累计 + 推荐树三线业绩 + 当前剩余锁仓价值',
  warning:'官方“三个区”划分未公开，本表按每个地址最大的3条直推线估算；P6/P7按3条线分别有有效P5/P6估算，最终以官方DApp为准。',
  priceDai:price,
  totalPowerUsers:own.size,
  totalReferralMembers:mem.size,
  thresholds:{zones:ZONE_NEED,veValueDai:VE_NEED},
  counts,
  levels:LEVELS.map((lv) => ({level:lv,count:by[lv].length,list:by[lv]}))
};
fs.writeFileSync(join(DIR,'p-levels.json'), JSON.stringify(out,null,2));
console.log('[levels] done', counts);