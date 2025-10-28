import express from 'express';
import axios from 'axios';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = 'https://tygo-gambles-data.vercel.app/';

const CSGOWIN_API_KEY = '14b2024c50';
const CSGOWIN_BASE_URL = 'https://api.csgowin.com';
const CSGOWIN_AFFILIATE_ENDPOINT = '/api/affiliate/external';

const RAINBET_API_KEY = 'C9Kit6DoHvTYCWp9LiNUFjmjomaGHaoG';

let rainbetCurrentCache = [];
let rainbetPreviousCache = [];

// ==========================
// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ==========================
// Helper to dynamically get current and previous month ranges (UTC)
function getMonthlyPeriods() {
  const now = new Date();

  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  const currentEnd = new Date(nextMonth.getTime() - 1);

  const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0));
  const previousEnd = new Date(currentStart.getTime() - 1);

  return {
    current: { from: currentStart, to: currentEnd },
    previous: { from: previousStart, to: previousEnd }
  };
}

// ==========================
// CSGOWin API: Fetching leaderboard with retry and error handling
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCSGOWinLeaderboard(fromTimestamp, toTimestamp, options = {}) {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const params = new URLSearchParams({
        code: 'tygo',
        gt: fromTimestamp.toString(),
        lt: toTimestamp.toString(),
        by: options.by || 'wager',
        sort: options.sort || 'desc',
        search: options.search || '',
        take: options.take || 10,
        skip: options.skip || 0,
      });

      const resp = await axios.get(
        `${CSGOWIN_BASE_URL}${CSGOWIN_AFFILIATE_ENDPOINT}?${params}`,
        {
          headers: {
            'x-apikey': CSGOWIN_API_KEY,
          },
        }
      );

      if (resp.data && resp.data.success) {
        return resp.data.data;
      }

      return null;
    } catch (error) {
      if (error.response && error.response.status === 429 && retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(`CSGOWin rate limit hit. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await sleep(delay);
        retryCount++;
        continue;
      }

      console.error('CSGOWin fetch error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      return null;
    }
  }

  return null;
}

function maskUsername(username) {
  if (!username) return 'Unknown';
  if (username.length <= 4) return username;
  return username.slice(0, 2) + '***' + username.slice(-2);
}


function formatCSGOWinOutput(data) {
  if (!data || !Array.isArray(data)) return [];
  return data.map((u) => ({
    username: maskUsername(u.username || u.name || 'Unknown'),
    wagered: u.wagered || u.wager || 0,
    weightedWager: u.weightedWager || u.wagered || u.wager || 0,
  }));
}

// ==========================
// Rainbet API helpers

function monthRangeUTC(year, month0) {
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 0));
  return {
    startStr: start.toISOString().slice(0, 10),
    endStr: end.toISOString().slice(0, 10),
  };
}

function getRainbetApiUrlForMonth(year, month0) {
  const { startStr, endStr } = monthRangeUTC(year, month0);
  return `https://services.rainbet.com/v1/external/affiliates?start_at=${startStr}&end_at=${endStr}&key=${RAINBET_API_KEY}`;
}

function maskRainbetUsername(username) {
  if (!username) return '';
  if (username.length <= 4) return username;
  return username.slice(0, 2) + '***' + username.slice(-2);
}

async function fetchAndProcessRainbet(url) {
  const response = await fetch(url);
  const json = await response.json();
  if (!json?.affiliates) throw new Error('No data from Rainbet');

  const sorted = json.affiliates.sort(
    (a, b) => parseFloat(b.wagered_amount || 0) - parseFloat(a.wagered_amount || 0)
  );

  const top10 = sorted.slice(0, 10);

  return top10.map((entry) => {
    const w = Math.max(0, Math.round(parseFloat(entry.wagered_amount || 0)));
    return {
      username: maskRainbetUsername(entry.username),
      wagered: w,
      weightedWager: w,
    };
  });
}

async function fetchAndCacheRainbetData() {
  try {
    const now = new Date();

    // Cache current month rainbet data
    rainbetCurrentCache = await fetchAndProcessRainbet(getRainbetApiUrlForMonth(now.getUTCFullYear(), now.getUTCMonth()));

    // Cache previous month rainbet data
    const prevYear = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const prevMonth0 = (now.getUTCMonth() + 11) % 12;
    rainbetPreviousCache = await fetchAndProcessRainbet(getRainbetApiUrlForMonth(prevYear, prevMonth0));

    console.log(`[✅] Rainbet data cached - current(${rainbetCurrentCache.length}), previous(${rainbetPreviousCache.length})`);
  } catch (err) {
    console.error('[❌] Failed to fetch Rainbet leaderboard:', err.message);
  }
}

// ==========================
// Express routes

// CSGOWin current month
app.get('/leaderboard/csgowin/current', async (req, res) => {
  const periods = getMonthlyPeriods();
  const data = await fetchCSGOWinLeaderboard(periods.current.from.getTime(), periods.current.to.getTime());
  if (data === null) return res.status(500).json({ error: 'Failed to fetch CSGOWin current month data' });
  res.json(formatCSGOWinOutput(data));
});

// CSGOWin previous month
app.get('/leaderboard/csgowin/previous', async (req, res) => {
  const periods = getMonthlyPeriods();
  const data = await fetchCSGOWinLeaderboard(periods.previous.from.getTime(), periods.previous.to.getTime());
  if (data === null) return res.status(500).json({ error: 'Failed to fetch CSGOWin previous month data' });
  res.json(formatCSGOWinOutput(data));
});

// Rainbet current month cached leaderboard
app.get('/leaderboard/rainbet/current', (req, res) => {
  res.json(rainbetCurrentCache);
});

// Rainbet previous month cached leaderboard
app.get('/leaderboard/rainbet/previous', (req, res) => {
  res.json(rainbetPreviousCache);
});

// Custom CSGOWin leaderboard endpoint with query params (optional)
app.get('/leaderboard/csgowin/custom', async (req, res) => {
  const fromTimestamp = req.query.from ? parseInt(req.query.from) : new Date('2025-01-01').getTime();
  const toTimestamp = req.query.to ? parseInt(req.query.to) : Date.now();
  const by = req.query.by || 'wager';
  const sort = req.query.sort || 'desc';
  const search = req.query.search || '';
  const take = req.query.take ? parseInt(req.query.take) : 10;
  const skip = req.query.skip ? parseInt(req.query.skip) : 0;

  const data = await fetchCSGOWinLeaderboard(fromTimestamp, toTimestamp, {
    by,
    sort,
    search,
    take,
    skip,
  });

  if (data === null) return res.status(500).json({ error: 'Failed to fetch CSGOWin custom leaderboard data' });
  res.json(formatCSGOWinOutput(data));
});

// Self-ping every 4.5 minutes to keep alive (for Render or similar)
setInterval(() => {
  fetch(SELF_URL)
    .then(() => console.log(`[🔁] Self-pinged ${SELF_URL}`))
    .catch((err) => console.error('[⚠️] Self-ping failed:', err.message));
}, 270000);

// Start Rainbet cache refresh and refresh every 5 minutes
fetchAndCacheRainbetData();
setInterval(fetchAndCacheRainbetData, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
