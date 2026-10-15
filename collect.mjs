#!/usr/bin/env node
/**
 * AiLGNS 观测站 · 数据采集器
 * 1) 从 Anubis 公共 RPC 读取链上实时状态（权威）
 * 2) 从 ailgns.ai 公开页面解析动态奖励名单解析结果（第三方整理）
 * 输出 data.json，供 index.html 直接读取。
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'data.json');

const RPC = 'https://rpc.anubispace.org';
const SRC_REWARDS = 'https://ailgns.ai/data/rewards';
const SRC_HELIX = 'https://ailgns.ai/data/helix';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const errors = [];
const note = (m) => { errors.push(m); console.error('[warn] ' + m); };

/* ---------- 基础工具 ---------- */
async function getText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' } });
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return await r.text();
}

function flatten(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<\/(div|p|li|tr|h1|h2|h3|h4|section|article|td|th|table|ul|ol)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&#x2F;/g, '/');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n\s*\n+/g, '\n');
  return s.trim();
}

const num = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return isFinite(n) ? n : null;
};
function pick(re, s, group) {
  const m = s.match(re);
  return m ? m[group == null ? 1 : group] : null;
}
function pickNum(re, s, g) { return num(pick(re, s, g)); }

/* ---------- 链上（权威） ---------- */
async function chain() {
  const rpcCall = async (method, params) => {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
    return j.result;
  };
  const hex = await rpcCall('eth_blockNumber', []);
  const block = parseInt(hex, 16);
  let gasPriceGwei = null;
  try { gasPriceGwei = Number(BigInt(await rpcCall('eth_gasPrice', []))) / 1e9; } catch (e) { note('eth_gasPrice: ' + e.message); }
  return {
    block,
    blockTime: new Date().toISOString(),
    gasPriceGwei,
    rpc: RPC,
    explorer: 'https://browser.anubispace.org/block/' + block,
    chainId: 6714,
  };
}

/* ---------- 动态奖励 ---------- */
function parseRewards(text) {
  const out = { unitPriceHistory: [], levels: [], history: [], latest: null };

  // 最新一期头部
  const dateLabel = pick(/(\d+月\d+日)的名单/, text);
  const day = pickNum(/第\s*(\d+)\s*天，第\s*\d+\s*版/, text);
  const status = pick(/\n(待确认|已确认)\n/, text) || pick(/(待确认|已确认)/, text);
  const publishAt = pick(/(\d+月\d+日\s*\d+:\d+)\s*公布/, text);
  const claimAt = pick(/待确认，(\d+月\d+日\s*\d+:\d+)\s*后可以领取/, text);

  const total = pickNum(/发放合计\s*([\d,.]+)\s*AiLGNS/, text);
  // 增长/网络/共识 三部分（在"发放合计"之后、下一节之前）
  const segHead = text.slice(text.indexOf('发放合计'), text.indexOf('每一份权重发多少'));
  const growth = pickNum(/增长\s*([\d,.]+)\s*AiLGNS/, segHead);
  const network = pickNum(/网络\s*([\d,.]+)\s*AiLGNS/, segHead);
  const consensus = pickNum(/共识\s*([\d,.]+)\s*AiLGNS/, segHead);
  const budget = pickNum(/当天动态奖励预算\s*([\d,.]+)\s*的/, segHead);
  const ratio = pickNum(/的\s*([\d.]+)%/, segHead);
  const addresses = pickNum(/发给\s*([\d,]+)\s*个地址/, segHead);

  out.latest = { dateLabel, day, status, publishAt, claimAt, total, growth, network, consensus, budget, ratio, addresses };

  // 当天单价
  const gp = pickNum(/增长\s*·\s*每\s*1\s*DAI\s*权重\s*([\d.]+)\s*AiLGNS/, text);
  const gpDelta = pickNum(/增长\s*·\s*每\s*1\s*DAI\s*权重\s*[\d.]+\s*AiLGNS\s*比前一天\s*(-?[\d.]+)%/, text);
  const np = pickNum(/网络\s*·\s*每\s*1\s*点权重\s*([\d.]+)\s*AiLGNS/, text);
  const npDelta = pickNum(/网络\s*·\s*每\s*1\s*点权重\s*[\d.]+\s*AiLGNS\s*比前一天\s*(-?[\d.]+)%/, text);
  const cm = text.match(/共识\s*·\s*每个地址一份\s*P1\s*([\d.]+)\s*P2\s*([\d.]+)\s*P3\s*([\d.]+)/);
  const cP1 = cm ? num(cm[1]) : null;
  const cP2 = cm ? num(cm[2]) : null;
  const cP3 = cm ? num(cm[3]) : null;
  out.unitPrice = { growth: gp, growthDelta: gpDelta, network: np, networkDelta: npDelta, consensus: { P1: cP1, P2: cP2, P3: cP3 } };

  // 最近 7 天单价
  const unitRe = /(\d+月\d+日)\s*增长\s*([\d.]+)\s*·\s*网络\s*([\d.]+)\s*共识\s*P1\s*([\d.]+)\s*·\s*P2\s*([\d.]+)\s*·\s*P3\s*([\d.]+)/g;
  let m;
  while ((m = unitRe.exec(text)) !== null) {
    out.unitPriceHistory.push({ date: m[1], growth: num(m[2]), network: num(m[3]), p1: num(m[4]), p2: num(m[5]), p3: num(m[6]) });
  }

  // 各等级拿到多少
  const lvRe = /(P[1-7])\s*·\s*([\d,]+)\s*人([\s\S]{0,220}?)(?=\n\s*P[1-7]\s*·\s*[\d,]+\s*人|\n\s*逐个地址)/g;
  let lm;
  while ((lm = lvRe.exec(text)) !== null) {
    const lv = lm[1], cnt = num(lm[2]), body = lm[3];
    const consM = body.match(/\u5171\u8bc6\uff08\u6bcf\u4eba\uff09\s*([\d.]+)(?:\s*\u5230\s*([\d.]+))?/);
    const netPair = body.match(/网络\s*([\d.]+)(?:\s*到\s*([\d.]+))?/);
    const groPair = body.match(/增长\s*([\d.]+)(?:\s*到\s*([\d.]+))?/);
    const totPair = body.match(/合计\s*([\d.]+)(?:\s*到\s*([\d.]+))?/);
    const med = pickNum(/中位数\s*([\d.]+)/, body);
    out.levels.push({
      level: lv, count: cnt,
      consensusMin: consM ? num(consM[1]) : null,
      consensusMax: consM && consM[2] ? num(consM[2]) : null,
      consensusEach: consM ? num(consM[1]) : null,
      networkMin: netPair ? num(netPair[1]) : null,
      networkMax: netPair && netPair[2] ? num(netPair[2]) : null,
      growthMin: groPair ? num(groPair[1]) : null,
      growthMax: groPair && groPair[2] ? num(groPair[2]) : null,
      totalMin: totPair ? num(totPair[1]) : null,
      totalMax: totPair && totPair[2] ? num(totPair[2]) : null,
      median: med,
    });
  }
  out.levels.sort((a, b) => a.level.localeCompare(b.level));

  // 每天汇总表
  const hIdx = text.indexOf('每天发放的三部分');
  if (hIdx > 0) {
    const tail = text.slice(hIdx);
    const rowRe = /(\d+月\d+日)\s*\n\s*(待确认|已确认)\s*\n\s*([\d,.]+)\s*\n\s*([\d,.]+)\s*\n\s*([\d,.]+)\s*\n\s*([\d,.]+)\s*\n\s*([\d,.]+)\s*\n\s*([\d,]+)\s*\n\s*([\d.]+|—)\s*\n\s*([\d.]+|—)\s*\n\s*([\d.]+|—)/g;
    let hm;
    while ((hm = rowRe.exec(tail)) !== null) {
      out.history.push({
        date: hm[1], status: hm[2],
        total: num(hm[3]), growth: num(hm[4]), network: num(hm[5]), consensus: num(hm[6]),
        budget: num(hm[7]), addresses: num(hm[8]),
        p1Median: hm[9] === '\u2014' ? null : num(hm[9]),
        p2Median: hm[10] === '\u2014' ? null : num(hm[10]),
        p3Median: hm[11] === '\u2014' ? null : num(hm[11]),
      });
    }
  }
  return out;
}

/* ---------- 链上协议状态页 ---------- */
function parseProtocol(text) {
  const p = {};
  p.day = pickNum(/协议第\s*(\d+)\s*天/, text);
  p.powerDAI = pickNum(/全网有效算力[\s\S]{0,160}?([\d,]+\.\d+)\s*DAI/, text);
  p.powerMultiplier = pickNum(/算力倍率\s*×\s*([\d.]+)/, text);
  p.dailyPayRatio = pickNum(/每日兑付上限\s*([\d.]+)%/, text);
  p.priceDAI = pickNum(/协议价格\s*([\d,.]+)\s*DAI/, text);
  p.poolPriceDAI = pickNum(/池现价[\s\S]{0,200}?([\d.]+)\s*DAI/, text);
  p.poolAiLGNS = pickNum(/池内 AiLGNS\s*([\d,.]+)\s*AiLGNS/, text);
  p.poolDAI = pickNum(/池内 DAI\s*([\d,.]+)\s*DAI/, text);
  p.reserveDAI = pickNum(/储备中的 DAI\s*([\d,.]+)\s*DAI/, text);
  p.totalSupply = pickNum(/总供应量\s*([\d,]+)\s*AiLGNS/, text);
  p.devWallet = pickNum(/仍在部署者钱包\s*([\d,]+)\s*AiLGNS/, text);
  p.buyOpen = /公开买入\s*(已开放|开放)/.test(text) ? true : (/公开买入\s*未开放/.test(text) ? false : null);
  p.buyFee = pick(/买入手续费目前为\s*([\d.]+%)/, text);
  p.sellFee = pick(/卖出手续费\s*([\d.]+%)/, text);
  const dep = text.match(/今天已存入\s*([\d,.]+)\s*DAI([\s\S]{0,120}?)每天上限\s*([\d,.]+)\s*DAI/);
  if (dep) { p.depositedToday = num(dep[1]); p.depositCap = num(dep[3]); }
  p.queueToday = pickNum(/今天已转入待生效\s*([\d,.]+)\s*DAI/, text);
  p.released = pickNum(/已释放 AiLGNS\s*([\d,.]+)\s*AiLGNS/, text);
  p.emissionVault = pickNum(/排放金库余额\s*([\d,.]+)\s*AiLGNS/, text);
  p.insuranceVault = pickNum(/保险金库余额\s*([\d,.]+)\s*AiLGNS/, text);
  return p;
}


/* ---------- 资金流水：用 DAI 买算力 ---------- */
const DAI_TOKEN   = '0x83fd06f0846d9d90b3016bf670efe2e0b11cde14';
const POWERLEDGER = '0x9e68f61e2615cc1d2c4a2d0026bfc1ebfdf68c1b';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FLOW_START = 15042314;   // 2026-09-28 13:00 UTC+8 官方算力参与开放

const hx = (n) => '0x' + n.toString(16);
const p64 = (a) => '0x' + a.toLowerCase().replace('0x', '').padStart(64, '0');

async function rpcGet(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (Date.now() % 1e6), method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + j.error.message);
  return j.result;
}

async function scanInflow(fromBlock, toBlock, label) {
  let total = 0n, count = 0;
  for (let s = fromBlock; s <= toBlock; s += 4999) {
    const logs = await rpcGet('eth_getLogs', [{
      address: DAI_TOKEN, topics: [TRANSFER_TOPIC, null, p64(POWERLEDGER)],
      fromBlock: hx(s), toBlock: hx(Math.min(s + 4998, toBlock)),
    }]);
    if (Array.isArray(logs)) logs.forEach((l) => { total += BigInt(l.data); count++; });
    if (s % 100000 === 0 && label) console.log('    ' + label + ' ' + s);
  }
  return { total, count };
}

async function collectFlow(prev) {
  const head = parseInt(await rpcGet('eth_blockNumber', []), 16);
  const p = prev || {};
  let scannedTo = Number(p.scannedToBlock || 0);
  if (scannedTo < FLOW_START - 1) scannedTo = FLOW_START - 1;
  if (scannedTo > head) scannedTo = head - 1;
  let totalWei = BigInt(p.totalWei || '0'), txCount = Number(p.txCount || 0);

  if (scannedTo < head) {
    const r = await scanInflow(scannedTo + 1, head, '增量');
    totalWei += r.total; txCount += r.count;
    scannedTo = head;
  }
  // 最近 24 小时
  const day = await scanInflow(Math.max(FLOW_START, head - 86400), head, null);

  const d = (v) => Number(v / 1000000000000n) / 1e6;
  return {
    scannedToBlock: scannedTo,
    totalWei: totalWei.toString(),
    txCount: txCount,
    totalDai: d(totalWei),
    totalFrom: '2026-09-28 13:00 (UTC+8) 官方算力参与开放',
    last24hDai: d(day.total),
    last24hTx: day.count,
  };
}


/* ---------- 各等级的钱包名单 ---------- */
function parseWho(text) {
  const start = text.indexOf('有 P 等级的地址各拿到多少');
  if (start < 0) return null;
  const seg = text.slice(start);   // 名单段落很长（可达 30 万字符），不能截断
  const marks = [];
  const lvRe = /<h3[^>]*>\s*(P[1-7])\s*<\/h3>/g;
  let m;
  while ((m = lvRe.exec(seg)) !== null) marks.push({ lv: m[1], i: m.index });
  if (!marks.length) return null;
  const out = {};
  marks.forEach((L, k) => {
    const j = k + 1 < marks.length ? marks[k + 1].i : seg.length;
    const body = seg.slice(L.i, j);
    const items = body.split('<li').slice(1);
    const list = [];
    items.forEach((li) => {
      const a = li.match(/title="(0x[0-9a-fA-F]{40})"/);
      if (!a) return;
      const plain = li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const amt = plain.match(/\u5408\u8ba1\s*([\d.]+)/);
      list.push({ a: a[1], t: amt ? Number(amt[1]) : null });
    });
    if (list.length) out[L.lv] = list;
  });
  return Object.keys(out).length ? out : null;
}

/* ---------- 主流程 ---------- */
async function main() {
  const started = new Date();
  const data = {
    site: { name: 'AiLGNS 观测站', generatedAt: started.toISOString(), generator: 'ailgns-monitor/collect.mjs' },
    chain: null, protocol: null, rewards: null, sources: { rewards: SRC_REWARDS, helix: SRC_HELIX }, errors: [],
  };

  try { data.chain = await chain(); } catch (e) { note('chain: ' + e.message); }

  try {
    const rt = await getText(SRC_REWARDS);
    data.rewards = parseRewards(flatten(rt));
    try {
      data.who = parseWho(rt);
      if (data.who && data.rewards) {
        const LV = ['P1','P2','P3','P4','P5','P6','P7'];
        LV.forEach((lv) => {
          const c = (data.rewards.levels.find((x) => x.level === lv) || {}).count || 0;
          const w = (data.who[lv] || []).length;
          if (c !== w) note('who 与等级表人数不一致 ' + lv + '：等级表 ' + c + '，名单 ' + w);
        });
      }
    } catch (e) { note('who: ' + e.message); }
  } catch (e) { note('rewards: ' + e.message); }

  try {
    let prevFlow = null;
    if (existsSync(OUT)) { try { prevFlow = JSON.parse(readFileSync(OUT, 'utf8')).flow || null; } catch (e) {} }
    data.flow = await collectFlow(prevFlow);
    console.log('  买算力累计 ' + data.flow.totalDai.toFixed(0) + ' DAI / ' + data.flow.txCount + ' 笔');
  } catch (e) { note('flow: ' + e.message); }

  try {
    const ht = await getText(SRC_HELIX);
    data.protocol = parseProtocol(flatten(ht));
  } catch (e) { note('protocol: ' + e.message); }

  // 保留上一次成功的数据，避免个别字段解析失败导致页面空白
  if (existsSync(OUT)) {
    try {
      const prev = JSON.parse(readFileSync(OUT, 'utf8'));
      if (!data.rewards || !data.rewards.latest || data.rewards.latest.total == null) {
        if (prev.rewards && prev.rewards.latest) { data.rewards = prev.rewards; note('rewards 解析为空，沿用上一次快照'); }
      }
      if (!data.protocol || data.protocol.day == null) {
        if (prev.protocol) { data.protocol = prev.protocol; note('protocol 解析为空，沿用上一次快照'); }
      }
      if (!data.flow && prev.flow) { data.flow = prev.flow; note('flow 抓取失败，沿用上一次快照'); }
      if (!data.who && prev.who) { data.who = prev.who; note('who 抓取失败，沿用上一次快照'); }
    } catch (e) { note('读取旧快照失败: ' + e.message); }
  }

  data.errors = errors;
  data.elapsedMs = Date.now() - started.getTime();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');

  const L = data.rewards && data.rewards.latest;
  console.log('[ok] ' + OUT);
  console.log('  链上区块 ' + (data.chain ? data.chain.block : '-') + ' | 协议第 ' + (data.protocol ? data.protocol.day : '-') + ' 天');
  if (L) console.log('  最新一期 ' + L.dateLabel + ' 第' + L.day + '天 | 合计 ' + L.total + ' | 共识 P1 ' + data.rewards.unitPrice.consensus.P1 + ' P2 ' + data.rewards.unitPrice.consensus.P2 + ' P3 ' + data.rewards.unitPrice.consensus.P3);
  if (errors.length) console.log('  警告 ' + errors.length + ' 条');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
