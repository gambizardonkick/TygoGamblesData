import express from 'express';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

const app = express();
const PORT = process.env.PORT || 3000;

async function fetchGoogleSheets(spreadsheetId, gid) {
  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
    const response = await axios.get(csvUrl);
    
    const records = parse(response.data, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    
    const result = records
      .filter(record => record.user_name && record.wagered)
      .map(record => ({
        username: record.user_name,
        wagered: parseFloat(record.wagered.replace(/[$,]/g, '')),
        weightedWager: parseFloat(record.wagered.replace(/[$,]/g, ''))
      }));
    
    return result;
  } catch (error) {
    console.error('Error fetching Google Sheets:', error.message);
    throw error;
  }
}

app.get('/leaderboard/sheets', async (req, res) => {
  try {
    const spreadsheetId = '1ZWSfdsCXYziCWnZ-Kp34B6buOlP045E86_lI_vLVRJ4';
    const gid = '2077816179';
    
    const data = await fetchGoogleSheets(spreadsheetId, gid);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Google Sheets data' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
