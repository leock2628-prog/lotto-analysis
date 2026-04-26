/**
 * 台灣大樂透開獎資料爬蟲
 * 使用 Playwright 抓取台彩官網，更新 draws.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '..', 'draws.json');

// ── 解析號碼字串 ─────────────────────────────────
function parseNums(str) {
  return String(str)
    .split(/[,、\s]+/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => n >= 1 && n <= 49);
}

// ── 格式化日期 yyyy-mm-dd ─────────────────────────
function formatDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/年/g,'-').replace(/月/g,'-').replace(/日/g,'').trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
}

// ── 讀取現有資料 ──────────────────────────────────
function loadExisting() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const raw = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data.draws) ? data.draws : [];
    }
  } catch (e) { console.error('讀取現有資料失敗:', e.message); }
  return [];
}

// ── 合併去重 ──────────────────────────────────────
function mergeDraws(existing, newDraws) {
  const map = new Map();
  existing.forEach(d => map.set(d.period, d));
  let added = 0;
  newDraws.forEach(d => {
    if (!map.has(d.period)) { map.set(d.period, d); added++; }
  });
  const merged = Array.from(map.values())
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return { merged, added };
}

// ── 儲存資料 ──────────────────────────────────────
function saveDraws(draws) {
  const output = {
    updatedAt: new Date().toISOString(),
    total: draws.length,
    draws
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`✅ 儲存完成，共 ${draws.length} 期`);
}

// ── 主爬蟲 ────────────────────────────────────────
async function scrape() {
  console.log('🚀 啟動 Playwright...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-TW',
  });
  const page = await context.newPage();
  const results = [];

  try {
    // ── 方法1: 台彩官網 大樂透開獎頁 ──────────────
    console.log('📡 嘗試抓取台彩官網...');
    await page.goto('https://www.taiwanlottery.com/lotto/result/lotto649', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2000);

    // 抓表格資料
    const tableRows = await page.$$eval('table tbody tr, .result-table tr', rows => {
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        return cells;
      }).filter(cells => cells.length >= 3);
    }).catch(() => []);

    console.log(`   找到 ${tableRows.length} 行表格資料`);

    for (const cells of tableRows) {
      // 嘗試各種欄位排列
      // 格式: [期數, 日期, 號碼1, 號碼2, 號碼3, 號碼4, 號碼5, 號碼6, 特別號]
      // 或:   [期數, 日期, 所有號碼(合併), 特別號]
      const periodMatch = cells.join(' ').match(/1\d{5}/);
      if (!periodMatch) continue;
      const period = periodMatch[0];

      let nums = [], special = 0, dateStr = '';

      // 找日期
      for (const cell of cells) {
        const d = formatDate(cell);
        if (d) { dateStr = d; break; }
      }

      // 找號碼 (逐格找6個主號碼)
      const numCells = cells.filter(c => /^\d{1,2}$/.test(c.trim()))
                            .map(c => parseInt(c.trim(), 10))
                            .filter(n => n >= 1 && n <= 49);
      if (numCells.length >= 7) {
        nums    = numCells.slice(0, 6).sort((a,b)=>a-b);
        special = numCells[6];
      } else if (numCells.length === 6) {
        nums    = numCells.sort((a,b)=>a-b);
      }

      // 找合併號碼格
      for (const cell of cells) {
        const parsed = parseNums(cell).filter(n=>n>=1&&n<=49);
        if (parsed.length === 7) {
          nums    = parsed.slice(0,6).sort((a,b)=>a-b);
          special = parsed[6];
          break;
        }
        if (parsed.length === 6 && nums.length === 0) {
          nums = parsed.sort((a,b)=>a-b);
        }
      }

      if (nums.length === 6 && special >= 1 && special <= 49) {
        results.push({ period: `第${period}期`, date: dateStr, numbers: nums, special, jackpot: '無人中獎' });
      }
    }

    // ── 方法2: 台彩 JSON API ───────────────────────
    if (results.length < 5) {
      console.log('📡 嘗試台彩 JSON API...');
      const apiUrl = 'https://www.taiwanlottery.com/lotto/result/getLottoRes.do?gameCode=6&rowsPerPage=30&pageNum=1';
      const resp = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, {
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              'Referer': 'https://www.taiwanlottery.com/lotto/result/lotto649'
            }
          });
          return await r.text();
        } catch(e) { return null; }
      }, apiUrl);

      if (resp) {
        try {
          const json = JSON.parse(resp);
          const list = json.lottoRes || json.content || json.data || json.result || json.list || [];
          console.log(`   API 回傳 ${list.length} 筆資料`);
          for (const item of list) {
            const term = String(item.drawTerm || item.term || '');
            if (!/^\d{6}$/.test(term)) continue;
            const nums = [item.no1,item.no2,item.no3,item.no4,item.no5,item.no6]
              .map(Number).filter(n=>n>=1&&n<=49).sort((a,b)=>a-b);
            const sp = Number(item.superNo || item.bonus || 0);
            if (nums.length !== 6 || !sp) continue;
            const dateRaw = String(item.drawDate || item.date || '');
            const dateStr = formatDate(dateRaw) || dateRaw.replace(/\//g,'-').slice(0,10);
            const jackpot = Number(item.prize1) > 0
              ? `${(item.prize1/1e8).toFixed(1)}億 ${item.prize1qty||1}注`
              : '無人中獎';
            results.push({ period:`第${term}期`, date:dateStr, numbers:nums, special:sp, jackpot });
          }
        } catch(e) { console.warn('   API JSON 解析失敗:', e.message); }
      }
    }

    // ── 方法3: 直接解析頁面文字 ───────────────────
    if (results.length < 5) {
      console.log('📡 嘗試解析頁面文字...');
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const regex = /第(1\d{5})期[\s\S]{0,200}?(\d{4}[\/年]\d{1,2}[\/月]\d{1,2})[日]?[\s\S]{0,200}?((?:\d{1,2}[、，,\s]+){5}\d{1,2})[\s\S]{0,80}?特別號[：:\s]*(\d{1,2})/g;
      let m;
      while ((m = regex.exec(bodyText)) !== null) {
        const term = m[1];
        const date = formatDate(m[2]);
        const nums = parseNums(m[3]).filter(n=>n>=1&&n<=49).sort((a,b)=>a-b);
        const sp   = parseInt(m[4]);
        if (nums.length === 6 && sp >= 1 && sp <= 49) {
          results.push({ period:`第${term}期`, date, numbers:nums, special:sp, jackpot:'無人中獎' });
        }
      }
    }

    // ── 方法4: 備用 - 彩票統計網站 ───────────────
    if (results.length < 3) {
      console.log('📡 嘗試備用來源...');
      await page.goto('https://atsunny.tw/lotto-649/', {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {});
      await page.waitForTimeout(1500);
      const text2 = await page.evaluate(() => document.body.innerText).catch(() => '');
      const r2 = /第?(1\d{5})期[^\n]*\n[^\n]*(\d{4}[-\/]\d{2}[-\/]\d{2})[^\n]*\n[^\n]*((?:\d{2}[\s]+){5}\d{2})[^\n]*(\d{2})/g;
      let m2;
      while ((m2 = r2.exec(text2)) !== null) {
        const nums = parseNums(m2[3]).sort((a,b)=>a-b);
        const sp = parseInt(m2[4]);
        if (nums.length===6 && sp>=1 && sp<=49) {
          results.push({ period:`第${m2[1]}期`, date:m2[2], numbers:nums, special:sp, jackpot:'無人中獎' });
        }
      }
    }

  } catch (e) {
    console.error('爬蟲錯誤:', e.message);
  } finally {
    await browser.close();
  }

  // 去除重複（同一期只保留一筆）
  const seen = new Set();
  const unique = results.filter(d => {
    const key = d.period;
    if (seen.has(key)) return false;
    seen.add(key);
    return d.numbers.length === 6 && d.special >= 1 && d.special <= 49;
  });

  console.log(`📊 抓取到 ${unique.length} 筆新資料`);
  return unique;
}

// ── 執行 ──────────────────────────────────────────
(async () => {
  try {
    const existing = loadExisting();
    console.log(`📂 現有資料: ${existing.length} 期`);

    const newDraws = await scrape();

    if (newDraws.length === 0) {
      console.warn('⚠️ 未抓到任何資料，保留現有資料');
      if (existing.length > 0) {
        saveDraws(existing); // 更新 updatedAt 時間戳
      }
      process.exit(0);
    }

    const { merged, added } = mergeDraws(existing, newDraws);
    console.log(`➕ 新增 ${added} 期，總計 ${merged.length} 期`);
    saveDraws(merged);

    if (added > 0) {
      console.log('🆕 新增期數:');
      newDraws.filter(d => !existing.find(e => e.period === d.period))
        .forEach(d => console.log(`   ${d.period} ${d.date} [${d.numbers.join(',')}] +${d.special}`));
    }
  } catch (e) {
    console.error('💥 執行失敗:', e);
    process.exit(1);
  }
})();
