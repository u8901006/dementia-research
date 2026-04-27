#!/usr/bin/env node
/**
 * Generate dementia daily report HTML using Zhipu AI (GLM-5-Turbo).
 * Reads papers JSON, analyzes with AI, generates styled HTML.
 * Fallback: GLM-5-Turbo → GLM-4.7 → GLM-4.7-Flash
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";

const API_BASE =
  process.env.ZHIPU_API_BASE ||
  "https://open.bigmodel.cn/api/coding/paas/v4";
const FALLBACK_MODELS = ["GLM-5-Turbo", "GLM-4.7", "GLM-4.7-Flash"];
const MAX_TOKENS = 50000;
const TIMEOUT_MS = 660000;
const MAX_RETRIES = 1;

const SYSTEM_PROMPT = `你是失智症研究的資深摘要與分類分析師。你的任務是：
1. 從提供的論文摘要中，擷取出最具有臨床相關性與新穎性的內容
2. 每篇論文皆以繁體中文（台灣用語）撰寫精簡摘要、臨床實用性評估及PICO分析
3. 評估每篇文獻的臨床實用性（高/中/低）
4. 生成適合醫療專業人士閱讀的繁體中文報告

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 精確醫學術語
- 每篇論文須包含：中文標題、一句精簡摘要、PICO分析、臨床實用性、相關標籤
- 最後提供精選 TOP 5-8 篇（最重要/最具臨床實用性的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

function getTaipeiDate() {
  const now = new Date();
  const taipei = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
  );
  return `${taipei.getFullYear()}-${String(taipei.getMonth() + 1).padStart(2, "0")}-${String(taipei.getDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadPapers(inputPath) {
  return JSON.parse(readFileSync(inputPath, "utf-8"));
}

function tryParseJSON(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    cleaned = cleaned.slice(firstNewline + 1);
    cleaned = cleaned.replace(/```\s*$/, "");
  }
  cleaned = cleaned.trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }
  const jsonMatch2 = cleaned.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch2) {
    try {
      return JSON.parse(jsonMatch2[1].trim());
    } catch {}
  }
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") {
      for (let j = cleaned.length - 1; j > i; j--) {
        if (cleaned[j] === "}") {
          try {
            return JSON.parse(cleaned.slice(i, j + 1));
          } catch {}
        }
      }
    }
  }
  return null;
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || getTaipeiDate();
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 擷取的最新失智症研究文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block 包裹）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句總結今日失智症文獻的重點趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句精簡摘要（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為何實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "適合的emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句精簡摘要",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "阿茲海默症": 3,
    "失智症照護": 2
  }
}

全部論文資料：
${papersText}

請挑選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：阿茲海默症、血管性失智症、路易體失智症、額顳葉失智症、輕度認知障礙、失智症照護、BPSD、照顧者、認知評估、神經影像、生物標記、藥物治療、非藥物治療、預防、認知復健、睡眠、老年精神醫學、神經科學、失智症篩檢、類澱粉蛋白、濤蛋白、神經發炎。
注意：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const model of FALLBACK_MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        console.error(
          `[INFO] Trying ${model} (attempt ${attempt + 1})...`,
        );
        const payload = {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: MAX_TOKENS,
        };

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          TIMEOUT_MS,
        );

        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (resp.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(
            `[WARN] Rate limited, waiting ${wait / 1000}s...`,
          );
          await sleep(wait);
          continue;
        }

        if (!resp.ok) {
          const errText = await resp.text();
          console.error(
            `[ERROR] HTTP ${resp.status}: ${errText.slice(0, 200)}`,
          );
          if (resp.status >= 500) {
            await sleep(10000);
            continue;
          }
          break;
        }

        const data = await resp.json();
        const rawText =
          data?.choices?.[0]?.message?.content?.trim() || "";

        const result = tryParseJSON(rawText);
        if (!result) {
          console.error(
            `[WARN] JSON parse failed on attempt ${attempt + 1}, raw length: ${rawText.length}`,
          );
          console.error(
            `[WARN] First 500 chars: ${rawText.slice(0, 500)}`,
          );
          if (attempt < MAX_RETRIES - 1) {
            await sleep(5000);
            continue;
          }
          continue;
        }

        console.error(
          `[INFO] Analysis complete with ${model}: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`,
        );
        result._model = model;
        return result;
      } catch (e) {
        if (e.name === "AbortError") {
          console.error(
            `[WARN] ${model} timeout on attempt ${attempt + 1}`,
          );
        } else {
          console.error(
            `[ERROR] ${model} attempt ${attempt + 1} failed: ${e.message}`,
          );
        }
        if (attempt < MAX_RETRIES - 1) await sleep(5000);
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function generateHTML(analysis) {
  const dateStr = analysis.date || getTaipeiDate();
  const dateParts = dateStr.split("-");
  const dateDisplay =
    dateParts.length === 3
      ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日`
      : dateStr;

  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const usedModel = analysis._model || "GLM-5-Turbo";

  let topPicksHTML = "";
  for (const pick of topPicks) {
    const tagsHTML = (pick.tags || [])
      .map((t) => `<span class="tag">${t}</span>`)
      .join("");
    const util = pick.clinical_utility || "中";
    const utilityClass =
      util === "高"
        ? "utility-high"
        : util === "中"
          ? "utility-mid"
          : "utility-low";
    const pico = pick.pico || {};
    const picoHTML = Object.keys(pico).length
      ? `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${pico.population || "-"}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${pico.intervention || "-"}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${pico.comparison || "-"}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${pico.outcome || "-"}</span></div>
            </div>`
      : "";

    topPicksHTML += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${pick.rank || ""}</span>
            <span class="emoji-icon">${pick.emoji || "\uD83D\uDCC4"}</span>
            <span class="${utilityClass}">${util}實用性</span>
          </div>
          <h3>${pick.title_zh || pick.title_en || ""}</h3>
          <p class="journal-source">${pick.journal || ""} &middot; ${pick.title_en || ""}</p>
          <p>${pick.summary || ""}</p>
          ${picoHTML}
          <div class="card-footer">
            ${tagsHTML}
            <a href="${pick.url || "#"}" target="_blank">閱讀原文 &rarr;</a>
          </div>
        </div>`;
  }

  let allPapersHTML = "";
  for (const paper of allPapers) {
    const tagsHTML = (paper.tags || [])
      .map((t) => `<span class="tag">${t}</span>`)
      .join("");
    const util = paper.clinical_utility || "中";
    const utilityClass =
      util === "高"
        ? "utility-high"
        : util === "中"
          ? "utility-mid"
          : "utility-low";
    allPapersHTML += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji || "\uD83D\uDCC4"}</span>
            <span class="${utilityClass} utility-sm">${util}</span>
          </div>
          <h3>${paper.title_zh || paper.title_en || ""}</h3>
          <p class="journal-source">${paper.journal || ""}</p>
          <p>${paper.summary || ""}</p>
          <div class="card-footer">
            ${tagsHTML}
            <a href="${paper.url || "#"}" target="_blank">PubMed &rarr;</a>
          </div>
        </div>`;
  }

  const keywordsHTML = keywords
    .map((k) => `<span class="keyword">${k}</span>`)
    .join("");

  let topicBarsHTML = "";
  const topicEntries = Object.entries(topicDist);
  const maxCount = topicEntries.length
    ? Math.max(...topicEntries.map(([, c]) => c))
    : 1;
  for (const [topic, count] of topicEntries) {
    const widthPct = Math.round((count / maxCount) * 100);
    topicBarsHTML += `
            <div class="topic-row">
              <span class="topic-name">${topic}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
  }

  const totalCount = topPicks.length + allPapers.length;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Dementia Research &middot; 失智症研究文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 失智症研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 110px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; animation: fadeUp 0.5s ease 0.4s both; }
  .clinic-links { display: flex; flex-direction: column; gap: 12px; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } .clinic-links { gap: 8px; } .clinic-link { padding: 14px 18px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🧠</div>
    <div class="header-text">
      <h1>Dementia Research &middot; 失智症研究文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHTML ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topPicksHTML}</div>` : ""}

  ${allPapersHTML ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allPapersHTML}</div>` : ""}

  ${topicBarsHTML ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicBarsHTML}</div>` : ""}

  ${keywordsHTML ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHTML}</div></div>` : ""}

  <div class="clinic-banner">
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank">
        <span class="clinic-icon">🏥</span>
        <span class="clinic-name">李政洋身心診所首頁</span>
        <span class="clinic-arrow">&rarr;</span>
      </a>
      <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank">
        <span class="clinic-icon">📬</span>
        <span class="clinic-name">訂閱電子報</span>
        <span class="clinic-arrow">&rarr;</span>
      </a>
      <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank">
        <span class="clinic-icon">☕</span>
        <span class="clinic-name">Buy Me a Coffee</span>
        <span class="clinic-arrow">&rarr;</span>
      </a>
    </div>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${usedModel}</span>
    <span><a href="https://github.com/u8901006/dementia-research">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function updateSummarizedPMIDs(papersData) {
  const trackerFile = "docs/summarized_pmids.json";
  let existing = { pmids: [] };
  if (existsSync(trackerFile)) {
    try {
      existing = JSON.parse(readFileSync(trackerFile, "utf-8"));
    } catch {}
  }
  const pmidSet = new Set(existing.pmids || []);
  const newPmids = papersData.new_pmids || [];
  for (const id of newPmids) {
    pmidSet.add(id);
  }
  const keep = [...pmidSet].slice(-5000);
  const tracker = {
    last_updated: getTaipeiDate(),
    total_pmids: keep.length,
    pmids: keep,
  };
  mkdirSync(dirname(trackerFile), { recursive: true });
  writeFileSync(trackerFile, JSON.stringify(tracker, null, 2), "utf-8");
  console.error(
    `[INFO] Updated tracker: ${keep.length} total PMIDs`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  let inputFile = "papers.json";
  let outputFile = "";
  let apiKey = process.env.ZHIPU_API_KEY || "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) inputFile = args[++i];
    if (args[i] === "--output" && args[i + 1]) outputFile = args[++i];
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
  }

  if (!apiKey) {
    console.error(
      "[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key",
    );
    process.exit(1);
  }

  const papersData = loadPapers(inputFile);
  let analysis;

  if (!papersData || !papersData.papers || papersData.papers.length === 0) {
    console.error(
      "[WARN] No papers found, generating empty report",
    );
    analysis = {
      date: getTaipeiDate(),
      market_summary:
        "今日 PubMed 暫無新的失智症研究文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(apiKey, papersData);
    if (!analysis) {
      console.error(
        "[ERROR] Analysis failed, cannot generate report",
      );
      process.exit(1);
    }
  }

  if (!outputFile) {
    outputFile = `docs/dementia-${analysis.date || getTaipeiDate()}.html`;
  }

  const html = generateHTML(analysis);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputFile}`);

  updateSummarizedPMIDs(papersData);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
