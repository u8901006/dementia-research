#!/usr/bin/env node
/**
 * Generate index.html listing all dementia daily reports.
 */

import { readdirSync, writeFileSync } from "fs";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function getTaipeiDate() {
  const now = new Date();
  const taipei = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
  );
  return `${taipei.getFullYear()}-${String(taipei.getMonth() + 1).padStart(2, "0")}-${String(taipei.getDate()).padStart(2, "0")}`;
}

try {
  const files = readdirSync("docs")
    .filter((f) => f.startsWith("dementia-") && f.endsWith(".html"))
    .sort()
    .reverse();

  let links = "";
  for (const f of files.slice(0, 30)) {
    const date = f.replace("dementia-", "").replace(".html", "");
    let dateDisplay = date;
    let weekday = "";
    try {
      const [y, m, d] = date.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      dateDisplay = `${y}年${m}月${d}日`;
      weekday = WEEKDAYS[dt.getDay()];
    } catch {}
    links += `<li><a href="${f}">📅 ${dateDisplay}（週${weekday}）</a></li>\n`;
  }

  const total = files.length;
  const today = getTaipeiDate();

  const index = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Dementia Research &middot; 失智症研究文獻日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">🧠</div>
  <h1>Dementia Research</h1>
  <p class="subtitle">失智症研究文獻日報 &middot; 每日自動更新</p>
  <p class="count">共 ${total} 期日報</p>
  <ul>${links}</ul>
  <footer>
    <p>Powered by PubMed + Zhipu AI &middot; <a href="https://github.com/u8901006/dementia-research">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  writeFileSync("docs/index.html", index, "utf-8");
  console.log("Index page generated");
} catch (e) {
  console.error(`[ERROR] Failed to generate index: ${e.message}`);
  process.exit(1);
}
