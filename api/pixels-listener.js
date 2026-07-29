// GET /api/pixels-listener?token=$CRON_SECRET
//   Cron-эндпоинт: сканит входящие транзакции на RECEIVER wallet, для
//   каждой в амаунт-окне [MIN_PAYMENT..MAX_PAYMENT] минтит один пиксельный
//   NFT покупателю через Getgems Minting API.
//
// Идемпотентность: requestId = tx.hash. Повторный запуск на ту же tx
// — no-op на стороне Getgems (см. docs). Никакого state на нашей стороне.
//
// Rate/budget: обрабатываем не больше MINT_BATCH_MAX за один tick, чтоб
// не упереться в Vercel timeout. Оставшиеся подхватит следующий cron.

const RECEIVER = process.env.RECEIVER_WALLET || 'UQCdDi4-w9ZA60l72cOQHnAl-a7qCM7VJ1zGG_NX6vAkaVPB';
const COLLECTION = process.env.PIXEL_COLLECTION || 'EQCTHxInEIDT9PnjRMMCpMOY8BwOQZVoeGWyuz1m8zEEtLxW';
const MIN_PAYMENT_NANO = 1_000_000_000n; // 1 GRAM
const MAX_PAYMENT_NANO = 1_500_000_000n; // 1.5 GRAM tolerance
const MINT_BATCH_MAX = 5;
const IMAGE = 'https://durov.dog/bg.png';

// ── crc16-xmodem (для конверсии raw→UQ адреса) ─────────────────────────
function crc16(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function rawToUQ(raw) {
  // raw: "0:hex64" → UQ...(48 chars base64url без паддинга)
  const [wcStr, hex] = String(raw).split(':');
  if (!hex || hex.length !== 64) throw new Error('bad raw address: ' + raw);
  const wc = parseInt(wcStr, 10);
  const addrBytes = new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const tag = 0x51; // non-bounceable, mainnet (UQ prefix)
  const packed = new Uint8Array(36);
  packed[0] = tag;
  packed[1] = wc === -1 ? 0xff : 0x00;
  packed.set(addrBytes, 2);
  const c = crc16(packed.slice(0, 34));
  packed[34] = (c >> 8) & 0xff;
  packed[35] = c & 0xff;
  // base64url без паддинга
  let b64 = Buffer.from(packed).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── main ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = req.headers['x-vercel-cron'] === '1';
  const token = req.query?.token;
  if (!isCron && (!cronSecret || token !== cronSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const apiKey = process.env.PIXEL_MINT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'PIXEL_MINT_API_KEY not configured' });

  const log = [];
  try {
    const url = `https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(RECEIVER)}/transactions?limit=50`;
    const headers = {};
    if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(502).json({ error: `tonapi ${r.status}` });
    const j = await r.json();
    const txs = j.transactions || [];

    // TonAPI отдаёт newest first — минтим в обратном порядке чтоб
    // старые платежи обрабатывались раньше (natural order).
    const candidates = [];
    for (const tx of txs) {
      const inMsg = tx.in_msg;
      if (!inMsg || !inMsg.source?.address) continue;
      const value = BigInt(inMsg.value || 0);
      if (value < MIN_PAYMENT_NANO || value > MAX_PAYMENT_NANO) continue;
      candidates.push({ hash: tx.hash, sender: inMsg.source.address, value: value.toString() });
    }
    candidates.reverse();

    let processed = 0;
    for (const c of candidates) {
      if (processed >= MINT_BATCH_MAX) break;
      const requestId = `pixel-${c.hash}`;
      let ownerUQ;
      try { ownerUQ = rawToUQ(c.sender); }
      catch (e) { log.push({ tx: c.hash, status: 'skip', reason: 'bad-sender:' + e.message }); continue; }

      const payload = {
        requestId,
        ownerAddress: ownerUQ,
        name: 'Durov Dog PIXEL',
        description: 'One of 1,000,000 pixels from the Durov Dog wall. Each pixel = one NFT. Together they reveal the pack. 50% of every mint funds the Durov Dog Shelter. Manifesto at durov.dog. #ad',
        image: IMAGE,
        attributes: [
          { trait_type: 'Collection size', value: 1_000_000 },
          { trait_type: 'Shelter split', value: '50%' },
          { trait_type: 'Perks', value: 'Premium on tonscanner.io + Telegram pack' },
        ],
      };

      const mintRes = await fetch(`https://api.getgems.io/public-api/minting/${COLLECTION}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const mintText = await mintRes.text();
      let mintJson;
      try { mintJson = JSON.parse(mintText); } catch { mintJson = { raw: mintText.slice(0, 200) }; }

      if (mintRes.ok && mintJson.success) {
        log.push({ tx: c.hash, status: 'minted', address: mintJson.response?.address });
        processed += 1;
      } else if (mintText.includes('already') || mintText.includes('duplicate')) {
        log.push({ tx: c.hash, status: 'already-minted' });
      } else {
        log.push({ tx: c.hash, status: 'mint-fail', code: mintRes.status, body: JSON.stringify(mintJson).slice(0, 200) });
      }
    }
    res.status(200).json({ ok: true, candidates: candidates.length, processed, log });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), log });
  }
}
