/**
 * AiLGNS 个人领取数据 · 官方地址详情页解析
 * 供 collect.mjs（定时抓取关注钱包）和 server.mjs（本地实时查询）共用。
 */
export const flat = (h) => h
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

const num = (s) => Number(String(s).replace(/,/g, ''));

export function parseAddrPage(text) {
  const o = { payHist: [], rwHist: [] };
  let m;
  m = text.match(/累计已兑付\s*([\d.,]+)\s*AiLGNS\s*约\s*([\d.,]+)\s*DAI\s*·\s*(\d+)\s*天/);
  if (m) { o.payCum = num(m[1]); o.payCumDAI = num(m[2]); o.days = Number(m[3]); }
  m = text.match(/已领取\s*([\d.,]+)\s*AiLGNS\s*(\d+)\s*次\s*·\s*待领取\s*([\d.,]+)/);
  if (m) { o.payClaimed = num(m[1]); o.payTimes = Number(m[2]); o.payPending = num(m[3]); }
  m = text.match(/官方累计\s*([\d.,]+)\s*AiLGNS\s*增长\s*([\d.,]+)\s*·\s*网络\s*([\d.,]+)\s*·\s*共识\s*([\d.,]+)/);
  if (m) { o.rwCum = num(m[1]); o.rwGrowth = num(m[2]); o.rwNetwork = num(m[3]); o.rwConsensus = num(m[4]); }
  m = text.match(/链上已记入\s*([\d.,]+)\s*AiLGNS[，,]\s*已领取\s*([\d.,]+)/);
  if (m) { o.rwOnchain = num(m[1]); o.rwClaimed = num(m[2]); }
  m = text.match(/后预计\s*([\d.,]+)\s*DAI/) || text.match(/预计\s*([\d.,]+)\s*DAI\s*按现价约\s*([\d.,]+)\s*AiLGNS/);
  const today = text.match(/预计\s*([\d.,]+)\s*DAI\s*按现价约\s*([\d.,]+)\s*AiLGNS/);
  if (today) { o.todayDAI = num(today[1]); o.todayAi = num(today[2]); }
  const rePay = /(\d+月\d+日)\s+([\d.,]+)\s*AiLGNS\s*算力\s*([\d.,]+)\s*·\s*约\s*([\d.,]+)\s*DAI/g;
  while ((m = rePay.exec(text)) !== null) o.payHist.push({ d: m[1], v: num(m[2]), power: num(m[3]), dai: num(m[4]) });
  const reRw = /(\d+月\d+日)\s+([\d.,]+)\s+(P[1-7])\s*·\s*增长权重/g;
  while ((m = reRw.exec(text)) !== null) o.rwHist.push({ d: m[1], v: num(m[2]), lv: m[3] });
  if (o.payCum == null && o.rwCum == null && !o.payHist.length && !o.rwHist.length) return null;
  return o;
}
