#!/usr/bin/env node
/**
 * AiLGNS 观测站 · 链上原生采集器
 * 数据源：Anubis RPC + Anubis Blockscout 原始链上日志
 * 不再依赖 ailgns.ai
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'data.json');
const WATCH_FILE = join(__dirname, 'watchlist.txt');
const LEVEL_FILE = join(__dirname, 'p-levels.json');
const EXPLORER = 'https://browser.anubispace.org';
const OFFICIAL_API = 'https://awakehelix.io/api/v1';
const EXPLORER_API = EXPLORER + '/api';
const RPC_LIST = ['https://rpc.anubispace.org', 'https://rpc2.anubispace.org', 'https://rpc3.anubispace.org'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
let RPC_IDX = 0;
let RPC = RPC_LIST[0];
const errors = [];
const note = (m) => { errors.push(String(m)); console.error('[warn] ' + m); };

const A = {
  CLOCK: '0x6C5352E15A8327C3F44898FE220100Edc2989C58',
  POWER: '0x9E68F61E2615cc1D2C4a2D0026bFc1EBFdf68C1b',
  AILGNS: '0x256EdB652db43E721EC6A12B6b51b6967D3bb8cB',
  DAI: '0x83fd06F0846d9D90B3016bF670Efe2E0B11cDe14',
  PAIR: '0x0a1Cce65d995C6C5100e6F5bA3c388Ef34CEcaf0',
  RESERVE: '0x27Cb55eE75E777fF972B74B6E68782D12Bd4ec46',
  COMMUNITY: '0xc9f9a8a2dBf8188AD6610e0239105CAbE67c4993',
  COMMUNITY_VAULT: '0x3DEea5f638cA0dFb03A0873CF4c0b90BA50E1aA2',
  INSURANCE: '0x22841307af7e663F8Ce784230C8F8e10a46888cF',
  TURBINE: '0xE884A336550a4482Ca6A17A3F93aa30Ed4eD9BaD'
};

const S = {
  currentDay: '0x5c9302c9',
  currentEpoch: '0x76671808',
  activePower: '0xf2cfb069',
  recordedPower: '0x8a420cfb',
  powerRateBps: '0xbe7f8c68',
  queuedDaiPower: '0x7f8e31a4',
  dailyDaiDepositCap: '0x1732f076',
  depositsOpen: '0x549c4627',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  getReserves: '0x0902f1ac',
  token0: '0x0dfe1681',
  quote: '0xed1bd76c',
  totalSellFeeBps: '0xfd6d5ad8',
  sellFeeBps: '0x23cbe1f3',
  dynamicFeeBps: '0xfe023865',
  totalActivePowerOf: '0x6cf2fa36',
  totalPowerOf: '0x4f343040',
  referrals: '0xc01b35a1',
  members: '0x08ae4b0c',
  commRoot: '0xa788371f'
};

const T = {
  communitySettled: '0x91dfa08597fd3a8af82de15a379094239ef672f8a7db3d481834c8060b63975b',
  dynamicRoot: '0xce1281bbe035883e4d8e329a4e92ce777c42ec0f072558a5868bd845baa45d99',
  staticClaimed: '0x4c80b813621f984c5d34c5126aabaccd262b9ca81236927656681e7303356164',
  dynamicClaimed: '0x834a7928c8bc071f15b35f427d0a750bf524f2bbeb96c04c0a05ee38ff8fca35'
};
// DynamicClaimed topic is computed from the ABI below; kept literal to avoid a runtime keccak dependency.

const DAI_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FLOW_START = 15042314;

const hx = (n) => '0x' + Number(n).toString(16);
const pad = (a) => '0x' + String(a).toLowerCase().replace('0x', '').padStart(64, '0');
const amountPad = (v) => BigInt(v).toString(16).padStart(64, '0');
const toNum = (v, decimals = 18) => Number(v) / (10 ** decimals);
const words = (data) => {
  const h = String(data || '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push('0x' + h.slice(i, i + 64));
  return out;
};
const asAddr = (topic) => '0x' + String(topic || '').slice(-40);
const localDate = (iso) => {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
};

async function fetchJson(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, Object.assign({ headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' } }, opts));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 350 * (i + 1)));
    }
  }
  throw last;
}

async function officialJson(path) {
  const r = await fetchJson(OFFICIAL_API + path, { headers: { 'content-type': 'application/json' } }, 4);
  return r;
}
async function officialLevel(a) {
  return await officialJson('/level/' + a);
}
async function officialCommunity(a) {
  return await officialJson('/community/' + a);
}
async function rpc(method, params) {
  let last;
  for (let i = 0; i < RPC_LIST.length * 2; i++) {
    try {
      const j = await fetchJson(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e6, method, params })
      }, 2);
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) {
      last = e;
      RPC_IDX = (RPC_IDX + 1) % RPC_LIST.length;
      RPC = RPC_LIST[RPC_IDX];
    }
  }
  throw last;
}

async function rpcBatch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 40) {
    const part = calls.slice(i, i + 40);
    const body = part.map((c, j) => ({ jsonrpc: '2.0', id: j, method: 'eth_call', params: [c, 'latest'] }));
    const arr = await fetchJson(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!Array.isArray(arr)) throw new Error('RPC batch failed');
    const sorted = arr.slice().sort((a, b) => a.id - b.id);
    for (let k = 0; k < part.length; k++) out.push(sorted[k] && sorted[k].result ? sorted[k].result : null);
  }
  return out;
}

async function explorerAll(addr, topic) {
  let url = EXPLORER + '/api/v2/addresses/' + addr + '/logs?topic=' + topic;
  const items = [];
  for (let guard = 0; guard < 100 && url; guard++) {
    const j = await fetchJson(url);
    if (Array.isArray(j.items)) items.push(...j.items);
    const p = j.next_page_params;
    if (!p) break;
    const q = new URLSearchParams();
    Object.keys(p).forEach((k) => { if (p[k] !== null && p[k] !== undefined) q.set(k, p[k]); });
    url = EXPLORER + '/api/v2/addresses/' + addr + '/logs?' + q.toString();
  }
  return items;
}

async function logsRange(addr, topic, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const url = EXPLORER_API + '?module=logs&action=getLogs&address=' + addr +
    '&fromBlock=' + fromBlock + '&toBlock=' + toBlock + '&topic0=' + topic;
  const j = await fetchJson(url);
  if (!Array.isArray(j.result)) {
    if (/No logs found/i.test(String(j.message || ''))) return [];
    throw new Error(j.message || 'explorer logs error');
  }
  if (j.result.length >= 1000 && toBlock > fromBlock) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await logsRange(addr, topic, fromBlock, mid);
    const right = await logsRange(addr, topic, mid + 1, toBlock);
    return left.concat(right);
  }
  return j.result;
}

async function logsRangeUser(addr, topic, user, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const topic1 = '0x' + user.toLowerCase().replace('0x', '').padStart(64, '0');
  const url = EXPLORER_API + '?module=logs&action=getLogs&address=' + addr +
    '&fromBlock=' + fromBlock + '&toBlock=' + toBlock +
    '&topic0=' + topic + '&topic1=' + topic1 + '&topic0_1_opr=and';
  const j = await fetchJson(url);
  if (Array.isArray(j.result)) return j.result;
  if (/No logs found/i.test(String(j.message || ''))) return [];
  throw new Error(j.message || 'explorer user logs error');
}
function parseCommunitySettled(items) {
  return items.map((x) => {
    const w = words(x.data);
    const day = Number(BigInt(x.topics[1] || '0x0'));
    return {
      day, block: Number(x.block_number), blockTime: x.block_timestamp,
      date: localDate(x.block_timestamp),
      base: toNum(BigInt(w[0] || '0x0')),
      factorBps: Number(BigInt(w[1] || '0x0')),
      actual: toNum(BigInt(w[2] || '0x0')),
      staticAmount: toNum(BigInt(w[3] || '0x0')),
      dynamicAmount: toNum(BigInt(w[4] || '0x0')),
      suppressed: toNum(BigInt(w[5] || '0x0')),
      tx: x.transaction_hash
    };
  }).sort((a, b) => a.day - b.day);
}

function parseDynamicRoot(items) {
  return items.map((x) => {
    const w = words(x.data);
    const day = Number(BigInt(x.topics[1] || '0x0'));
    return {
      day, block: Number(x.block_number), blockTime: x.block_timestamp,
      date: localDate(x.block_timestamp),
      total: toNum(BigInt(w[1] || '0x0')),
      growth: toNum(BigInt(w[2] || '0x0')),
      network: toNum(BigInt(w[3] || '0x0')),
      consensus: toNum(BigInt(w[4] || '0x0')),
      noRecipient: toNum(BigInt(w[5] || '0x0')),
      tx: x.transaction_hash
    };
  }).sort((a, b) => a.day - b.day);
}

async function collectProtocol() {
  const bal = (addr) => S.balanceOf + addr.slice(2).padStart(64, '0');
  const quoteData = S.quote + amountPad(10n ** 18n);
  const calls = [
    { to: A.CLOCK, data: S.currentDay },
    { to: A.CLOCK, data: S.currentEpoch },
    { to: A.POWER, data: S.activePower },
    { to: A.POWER, data: S.recordedPower },
    { to: A.POWER, data: S.powerRateBps },
    { to: A.POWER, data: S.queuedDaiPower },
    { to: A.POWER, data: S.dailyDaiDepositCap },
    { to: A.POWER, data: S.depositsOpen },
    { to: A.AILGNS, data: S.totalSupply },
    { to: A.AILGNS, data: bal(A.COMMUNITY_VAULT) },
    { to: A.AILGNS, data: bal(A.INSURANCE) },
    { to: A.DAI, data: bal(A.RESERVE) },
    { to: A.AILGNS, data: S.totalSellFeeBps },
    { to: A.AILGNS, data: S.sellFeeBps },
    { to: A.AILGNS, data: S.dynamicFeeBps },
    { to: A.PAIR, data: S.getReserves },
    { to: A.PAIR, data: S.token0 },
    { to: A.TURBINE, data: quoteData }
  ];
  const r = await rpcBatch(calls);
  const u = (x) => x ? toNum(BigInt(x)) : null;
  const day = r[0] ? Number(BigInt(r[0])) : null;
  const epoch = r[1] ? Number(BigInt(r[1])) : null;
  const activePower = u(r[2]);
  const recordedPower = u(r[3]);
  const rateBps = r[4] ? Number(BigInt(r[4])) : 25000;
  const queuedPower = u(r[5]);
  const depositCap = u(r[6]);
  const depositsOpen = r[7] ? BigInt(r[7]) !== 0n : null;
  const supply = u(r[8]);
  const emissionVault = u(r[9]);
  const insuranceVault = u(r[10]);
  const reserve = u(r[11]);
  const sellBps = r[12] ? Number(BigInt(r[12])) : null;
  const qw = words(r[17] || '0x');
  const protocolPrice = qw[0] ? toNum(BigInt(qw[0])) : null;
  const reserves = words(r[15] || '0x');
  const token0 = r[16] ? asAddr(r[16]) : null;
  let reserveAi = reserves[0] ? toNum(BigInt(reserves[0])) : null;
  let reserveDai = reserves[1] ? toNum(BigInt(reserves[1])) : null;
  if (token0 && token0.toLowerCase() !== A.AILGNS.toLowerCase()) {
    const tmp = reserveAi; reserveAi = reserveDai; reserveDai = tmp;
  }
  return {
    day, epoch, activePower, recordedPower,
    powerMultiplier: rateBps / 10000,
    dailyPayRatio: 0.2795,
    priceDAI: protocolPrice,
    poolPriceDAI: reserveAi > 0 ? reserveDai / reserveAi : null,
    poolAiLGNS: reserveAi,
    poolDAI: reserveDai,
    reserveDAI: reserve,
    totalSupply: supply,
    emissionVault, insuranceVault,
    queuedPower,
    depositedToday: null,
    depositCap,
    buyOpen: depositsOpen,
    buyFee: '2.5%',
    sellFee: sellBps == null ? null : (sellBps / 100).toFixed(2) + '%',
    queueToday: null,
    released: null,
    suppressed: null
  };
}

async function collectFlow(prev) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const p = prev || {};
  let scannedTo = Number(p.scannedToBlock || 0);
  if (scannedTo < FLOW_START - 1) scannedTo = FLOW_START - 1;
  if (scannedTo > head) scannedTo = head - 1;
  let totalWei = BigInt(p.totalWei || '0');
  let txCount = Number(p.txCount || 0);
  async function scan(from, to) {
    let total = 0n, count = 0;
    for (let s = from; s <= to; s += 4999) {
      const logs = await rpc('eth_getLogs', [{
        address: A.DAI, topics: [DAI_TRANSFER, null, pad(A.POWER)],
        fromBlock: hx(s), toBlock: hx(Math.min(s + 4998, to))
      }]);
      (logs || []).forEach((l) => { total += BigInt(l.data); count++; });
    }
    return { total, count };
  }
  if (scannedTo < head) {
    const add = await scan(scannedTo + 1, head);
    totalWei += add.total; txCount += add.count; scannedTo = head;
  }
  const day = await scan(Math.max(FLOW_START, head - 86400), head);
  const d = (v) => Number(v / 1000000000000n) / 1e6;
  return {
    scannedToBlock: scannedTo,
    totalWei: totalWei.toString(),
    txCount,
    totalDai: d(totalWei),
    totalFrom: '2026-09-28 13:00 (UTC+8) 官方算力参与开放',
    last24hDai: d(day.total),
    last24hTx: day.count
  };
}

const FLOW_ACCOUNTS = [
  ['协议储备', A.RESERVE, '买算力的钱全部进入这里'],
  ['AiLGNS/DAI 主池', A.PAIR, '主池内的 DAI 储备'],
  ['涡轮 Turbine', A.TURBINE, '激活排放收到的 DAI'],
  ['手续费归集', '0x7088e192b9b7f41A07bB3f79378e13454D8a80D5', '卖出费里的 1%'],
  ['算力账本', A.POWER, '中转站，收到后立即转出']
];
async function collectFlowBalances() {
  const calls = FLOW_ACCOUNTS.map((x) => ({ to: A.DAI, data: S.balanceOf + x[1].slice(2).padStart(64, '0') }));
  const res = await rpcBatch(calls);
  return FLOW_ACCOUNTS.map((x, i) => ({ name:x[0], addr:x[1], note:x[2], dai:res[i] ? toNum(BigInt(res[i])) : null }));
}

async function collectTree() {
  const rootHex = await rpc('eth_call', [{ to: A.COMMUNITY, data: S.commRoot }, 'latest']);
  const root = asAddr(rootHex);
  const seen = new Map([[root.toLowerCase(), { parent: null, depth: 0 }]]);
  let frontier = [root.toLowerCase()];
  let scanned = 0;
  while (frontier.length) {
    const next = [];
    for (let i = 0; i < frontier.length; i += 12) {
      const chunk = frontier.slice(i, i + 12);
      const first = await rpcBatch(chunk.map((a) => ({ to: A.COMMUNITY, data: S.referrals + a.slice(2).padStart(64, '0') + amountPad(0) + amountPad(60) })));
      const pages = first.map((r) => {
        if (!r) return { total: 0, list: [] };
        const w = words(r);
        const total = Number(BigInt(w[0] || '0x0'));
        const off = Number(BigInt(w[1] || '0x0')) / 32;
        const n = Number(BigInt(w[off] || '0x0'));
        const list = [];
        for (let k = 0; k < n; k++) list.push(asAddr(w[off + 1 + k]));
        return { total, list };
      });
      const extra = [];
      pages.forEach((p, k) => { for (let off = 60; off < p.total; off += 60) extra.push({ k, off }); });
      if (extra.length) {
        const rr = await rpcBatch(extra.map((e) => ({ to: A.COMMUNITY, data: S.referrals + chunk[e.k].slice(2).padStart(64, '0') + amountPad(e.off) + amountPad(60) })));
        extra.forEach((e, j) => {
          const w = words(rr[j] || '0x');
          const off2 = w[1] ? Number(BigInt(w[1])) / 32 : 2;
          const n2 = w[off2] ? Number(BigInt(w[off2])) : 0;
          for (let k = 0; k < n2; k++) pages[e.k].list.push(asAddr(w[off2 + 1 + k]));
        });
      }
      pages.forEach((p, k) => {
        p.list.forEach((a) => {
          const c = a.toLowerCase();
          if (!seen.has(c)) {
            seen.set(c, { parent: chunk[k], depth: seen.get(chunk[k]).depth + 1 });
            next.push(c);
          }
        });
      });
      scanned += chunk.length;
    }
    frontier = next;
  }
  const levels = {};
  seen.forEach((v) => { levels[v.depth] = (levels[v.depth] || 0) + 1; });
  return { root, total: seen.size, maxDepth: Math.max(...Object.keys(levels).map(Number)), levels, scanned, map: seen };
}

async function collectClaims(latestRoot, head, claimMap) {
  if (!latestRoot) return { date: null, day: null, all: [], top: [], addresses: 0, staticTotal: 0, dynamicTotal: 0, total: 0 };
  const from = latestRoot.block;
  const [st, dy] = await Promise.all([
    logsRange(A.COMMUNITY_VAULT, T.staticClaimed, from, head),
    logsRange(A.COMMUNITY_VAULT, T.dynamicClaimed, from, head)
  ]);
  function add(items, type) {
    (items || []).forEach((x) => {
      const a = asAddr(x.topics[1]).toLowerCase();
      const w = words(x.data);
      const v = type === 'static' ? (w[0] ? toNum(BigInt(w[0])) : 0) : (w[1] ? toNum(BigInt(w[1])) : 0);
      if (!claimMap.has(a)) claimMap.set(a, { a, static: 0, dynamic: 0, total: 0, events: 0 });
      const e = claimMap.get(a);
      e[type] += v; e.total += v; e.events++;
    });
  }
  add(st, 'static');
  add(dy, 'dynamic');
  const all = Array.from(claimMap.values()).sort((a, b) => b.total - a.total);
  const staticTotal = all.reduce((s, x) => s + x.static, 0);
  const dynamicTotal = all.reduce((s, x) => s + x.dynamic, 0);
  const top = all.slice(0, 200);
  return {
    date: latestRoot.date, day: latestRoot.day, fromBlock: from, toBlock: head,
    addresses: all.length, staticTotal, dynamicTotal, total: staticTotal + dynamicTotal,
    events: (st || []).length + (dy || []).length,
    all: top, top
  };
}

function loadWatchlist() {
  if (!existsSync(WATCH_FILE)) return [];
  return readFileSync(WATCH_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
}

async function collectWatch(list, tree, claims) {
  const out = {};
  const calls = [];
  list.forEach((a) => {
    calls.push({ to: A.POWER, data: S.totalActivePowerOf + a.slice(2).padStart(64, '0') });
    calls.push({ to: A.POWER, data: S.totalPowerOf + a.slice(2).padStart(64, '0') });
    calls.push({ to: A.COMMUNITY, data: S.referrals + a.slice(2).padStart(64, '0') + amountPad(0) + amountPad(1) });
    calls.push({ to: A.COMMUNITY, data: S.members + a.slice(2).padStart(64, '0') });
  });
  const r = await rpcBatch(calls);
  const userClaims = await Promise.all(list.map(async (a) => {
    const [st, dy] = await Promise.all([
      logsRangeUser(A.COMMUNITY_VAULT, T.staticClaimed, a, claims.fromBlock || 0, claims.toBlock || Number.MAX_SAFE_INTEGER),
      logsRangeUser(A.COMMUNITY_VAULT, T.dynamicClaimed, a, claims.fromBlock || 0, claims.toBlock || Number.MAX_SAFE_INTEGER)
    ]);
    let sv = 0, dv = 0;
    st.forEach((x) => { const w = words(x.data); if (w[0]) sv += toNum(BigInt(w[0])); });
    dy.forEach((x) => { const w = words(x.data); if (w[1]) dv += toNum(BigInt(w[1])); });
    return { static: sv, dynamic: dv, total: sv + dv, events: st.length + dy.length };
  }));
  list.forEach((a, i) => {
    const ref = r[i * 4 + 2], mem = r[i * 4 + 3], node = tree.map.get(a.toLowerCase()), c = userClaims[i];
    let direct = 0, parent = node ? node.parent : null;
    if (ref) {
      const w = words(ref); direct = w[0] ? Number(BigInt(w[0])) : 0;
    }
    if (mem) {
      const w = words(mem);
      parent = parent || (w[1] ? asAddr(w[1]) : null);
    }
    out[a] = {
      powerEff: r[i * 4] ? toNum(BigInt(r[i * 4])) : null,
      powerReg: r[i * 4 + 1] ? toNum(BigInt(r[i * 4 + 1])) : null,
      direct,
      depth: node ? node.depth : null,
      parent,
      claimStatic: c.static,
      claimDynamic: c.dynamic,
      claimTotal: c.total,
      claimEvents: c.events
    };
  });
  return out;
}


async function main() {
  const started = new Date();
  console.log('[chain] 开始采集');
  let prev = {};
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) {} }
  const headHex = await rpc('eth_blockNumber', []);
  const head = parseInt(headHex, 16);
  const block = await rpc('eth_getBlockByNumber', [headHex, false]);

  const chain = {
    block: head,
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    gasPriceGwei: Number(BigInt(await rpc('eth_gasPrice', []))) / 1e9,
    rpc: RPC,
    explorer: EXPLORER + '/block/' + head,
    chainId: 6714
  };

  const protocol = await collectProtocol();
  protocol.powerDAI = protocol.activePower;
  protocol.powerRecordedDAI = protocol.recordedPower;
  let flow = prev.flow || null;
  try { flow = await collectFlow(prev.flow); } catch (e) { note('flow: ' + e.message); }

  const settledItems = await explorerAll(A.COMMUNITY_VAULT, T.communitySettled);
  const rootItems = await explorerAll(A.COMMUNITY_VAULT, T.dynamicRoot);
  const settledRaw = parseCommunitySettled(settledItems);
  const rootsRaw = parseDynamicRoot(rootItems);
  const settledMap = new Map();
  settledRaw.forEach((x) => { const old = settledMap.get(x.day); if (!old || x.block >= old.block) settledMap.set(x.day, x); });
  const rootMap = new Map();
  rootsRaw.forEach((x) => { const old = rootMap.get(x.day); if (!old || x.block >= old.block) rootMap.set(x.day, x); });
  const settled = Array.from(settledMap.values()).sort((a, b) => a.day - b.day);
  const roots = Array.from(rootMap.values()).sort((a, b) => a.day - b.day);
  const settledByDay = new Map(settled.map((x) => [x.day, x]));

  const history = roots.map((r) => {
    const c = settledByDay.get(r.day) || {};
    return Object.assign({}, r, {
      status: '链上已结算',
      budget: c.actual != null ? c.actual : null,
      base: c.base != null ? c.base : null,
      factorBps: c.factorBps != null ? c.factorBps : null,
      actual: c.actual != null ? c.actual : null,
      staticAmount: c.staticAmount != null ? c.staticAmount : null,
      dynamicAmount: c.dynamicAmount != null ? c.dynamicAmount : null,
      suppressed: c.suppressed != null ? c.suppressed : null
    });
  });
  const latestRoot = history.length ? history[history.length - 1] : null;
  const rewards = {
    latest: latestRoot,
    history: history.slice().reverse(),
    unitPrice: {},
    unitPriceHistory: history.map((x) => ({ date: x.date, day: x.day }))
  };

  const claimMap = new Map();
  let claims = await collectClaims(latestRoot, head, claimMap);
  rewards.latest = Object.assign({}, latestRoot, { addresses: claims.addresses });

  const released = settled.reduce((s, x) => s + (x.actual || 0), 0);
  const suppressed = settled.reduce((s, x) => s + (x.suppressed || 0), 0);
  protocol.released = released;
  protocol.suppressed = suppressed;
  protocol.queueToday = flow ? flow.last24hDai : null;
  protocol.depositedToday = flow ? flow.last24hDai : null;
  if (flow) {
    try {
      const liveRows = await collectFlowBalances();
      if (liveRows.every((x) => x.dai != null)) flow.rows = liveRows;
      else if (prev.flow && prev.flow.rows) flow.rows = prev.flow.rows;
    } catch (e) {
      if (prev.flow && prev.flow.rows) flow.rows = prev.flow.rows;
      note('flow balances: ' + e.message);
    }
  }

  let officialLevelsData = prev.officialLevels || null;
  try { officialLevelsData = await officialJson('/level'); } catch (e) { note('official levels: ' + e.message); }
  let tree = { root: null, total: null, maxDepth: null, levels: {}, map: new Map() };
  try { tree = await collectTree(); } catch (e) { note('tree: ' + e.message); }
  const watch = await collectWatch(loadWatchlist(), tree, claims).catch((e) => { note('watch: ' + e.message); return {}; });
  try {
    const keys = Object.keys(watch);
    const official = await Promise.all(keys.map(async (a) => {
      const [ol, oc] = await Promise.all([officialLevel(a), officialCommunity(a)]);
      return { a, ol, oc };
    }));
    official.forEach((x) => { watch[x.a].officialLevel = x.ol; watch[x.a].officialCommunity = x.oc; });
  } catch (e) { note('official watch: ' + e.message); }

  let pLevels = prev.pLevels || null;
  if (existsSync(LEVEL_FILE)) {
    try { pLevels = JSON.parse(readFileSync(LEVEL_FILE, 'utf8')); } catch (e) { note('p-levels: ' + e.message); }
  }

  const data = {
    mode: 'chain',
    site: {
      name: 'AiLGNS 链上观测站',
      generatedAt: started.toISOString(),
      generator: 'ailgns-monitor/collect-chain.mjs',
      dataSource: 'Anubis RPC + 原始链上日志',
      thirdParty: false
    },
    chain, protocol, flow,
    rewards, emissions: {
      latest: history.length ? history[history.length - 1] : null,
      history: history.slice().reverse(),
      settled: settled.slice().reverse(),
      latestSettled: settled.length ? settled[settled.length - 1] : null
    },
    claims,
    pLevels,
    officialLevels: officialLevelsData,
    tree: { root: tree.root, total: tree.total, maxDepth: tree.maxDepth, levels: tree.levels },
    watch,
    errors
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');
  console.log('[ok] ' + OUT);
  console.log('  区块 ' + head + ' | 链上第 ' + protocol.day + ' 天 | 结算 ' + history.length + ' 天');
  console.log('  最新分配 ' + (latestRoot ? latestRoot.total : '-') + ' AiLGNS | 领取地址 ' + claims.addresses);
  if (errors.length) console.log('  警告 ' + errors.length + ' 条');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
