#!/usr/bin/env node
/**
 * Fetch latest dementia research papers from PubMed E-utilities API.
 * Uses search templates from dementia_research_pubmed_toolkit.md
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";

const PUBMED_SEARCH =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH =
  "https://eutils.ncbi.nlm.nih.gov/entrez/efetch.fcgi";
const HEADERS = {
  "User-Agent": "DementiaResearchBot/1.0 (research aggregator)",
};
const NCBI_PARAMS = {
  tool: "DementiaResearchBot",
  email: "u8901006@users.noreply.github.com",
};

const SEARCH_QUERIES = [
  {
    name: "broad-dementia",
    query: (days) =>
      `("Dementia"[Mesh] OR dementia[tiab] OR "major neurocognitive disorder"[tiab] OR "mild cognitive impairment"[tiab]) AND (diagnosis OR treatment OR prevention OR biomarker* OR neuroimaging OR caregiving OR neuropsychological) AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "alzheimer-biomarker",
    query: (days) =>
      `("Alzheimer Disease"[Mesh] OR "Alzheimer*"[tiab]) AND (biomarker* OR amyloid OR tau OR plasma OR CSF OR PET OR MRI) AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "dementia-subtypes",
    query: (days) =>
      `("vascular dementia"[tiab] OR "Lewy body"[tiab] OR "frontotemporal dementia"[tiab] OR "Parkinson disease dementia"[tiab] OR "mixed dementia"[tiab]) AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "bpsd-caregiver",
    query: (days) =>
      `(dementia OR "Alzheimer Disease") AND (BPSD OR "behavioral and psychological symptoms" OR agitation OR caregiver* OR burden OR "quality of life") AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "high-impact-journals",
    query: (days) =>
      `(("Neurology"[Journal]) OR ("JAMA Neurol"[Journal]) OR ("Lancet Neurol"[Journal]) OR ("Nat Med"[Journal]) OR ("N Engl J Med"[Journal])) AND (dementia OR "Alzheimer Disease" OR "mild cognitive impairment") AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "treatment-pharma",
    query: (days) =>
      `(dementia OR "Alzheimer Disease" OR "Lewy body dementia") AND (lecanemab OR donanemab OR donepezil OR rivastigmine OR memantine OR "disease-modifying" OR "anti-amyloid") AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "neuroimaging-cognition",
    query: (days) =>
      `(dementia OR "Alzheimer Disease" OR "mild cognitive impairment") AND (MRI OR PET OR fMRI OR "functional connectivity" OR "brain network" OR atrophy) AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "prevention-lifestyle",
    query: (days) =>
      `(dementia OR "cognitive decline" OR "mild cognitive impairment") AND (prevention OR exercise OR diet OR sleep OR "social engagement" OR "cognitive reserve" OR "risk factor") AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "psychosocial-intervention",
    query: (days) =>
      `(dementia OR "mild cognitive impairment") AND ("cognitive rehabilitation" OR "cognitive stimulation" OR psychotherapy OR "music therapy" OR "reminiscence" OR "caregiver intervention" OR "nonpharmacological") AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
  {
    name: "screening-diagnosis",
    query: (days) =>
      `(dementia OR "Alzheimer Disease" OR "mild cognitive impairment") AND (screening OR diagnosis OR "early detection" OR MoCA OR MMSE OR "cognitive assessment" OR "blood biomarker") AND english[lang] AND "${lookbackDate(days)}"[Date - Publication] : "3000"[Date - Publication]`,
  },
];

function lookbackDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function getTaipeiDate() {
  const now = new Date();
  const taipei = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
  );
  return `${taipei.getFullYear()}-${String(taipei.getMonth() + 1).padStart(2, "0")}-${String(taipei.getDate()).padStart(2, "0")}`;
}

async function fetchJSON(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp.text();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchPapers(query, retmax = 30) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const data = await fetchJSON(url);
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const allPapers = [];
  const batchSize = 20;
  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    const body = new URLSearchParams();
    body.set("db", "pubmed");
    body.set("id", batch.join(","));
    body.set("retmode", "xml");
    body.set("tool", NCBI_PARAMS.tool);
    body.set("email", NCBI_PARAMS.email);
    try {
      console.error(
        `[INFO] Fetching batch ${Math.floor(i / batchSize) + 1} (${batch.length} PMIDs)...`,
      );
      const resp = await fetch(PUBMED_FETCH, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(
          `[ERROR] PubMed efetch HTTP ${resp.status}: ${errText.slice(0, 300)}`,
        );
        continue;
      }
      const xml = await resp.text();
      const papers = parseXML(xml);
      allPapers.push(...papers);
      console.error(`  Got ${papers.length} papers from batch`);
    } catch (e) {
      console.error(`[ERROR] PubMed fetch batch failed: ${e.message}`);
    }
    if (i + batchSize < pmids.length) await sleep(400);
  }
  return allPapers;
}

function parseXML(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "ArticleTitle");
    const journal = extractTag(block, "<Title>");
    const pmid = extractTag(block, "<PMID");
    const abstract = extractAbstract(block);
    const pubDate = extractPubDate(block);
    const keywords = extractKeywords(block);
    const url = pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : "";

    if (title) {
      papers.push({
        pmid,
        title: cleanText(title),
        journal: cleanText(journal),
        date: pubDate,
        abstract: abstract.slice(0, 2000),
        url,
        keywords,
      });
    }
  }
  return papers;
}

function extractTag(block, tag) {
  const openTag =
    tag.startsWith("<") && !tag.endsWith(">") ? tag : `<${tag}>`;
  const closeTag = openTag.includes(" ")
    ? `</${openTag.replace(/<(\w+).*/, "$1")}>`
    : `</${openTag.slice(1)}`;
  const regex = new RegExp(
    `${escapeRegex(openTag)}([\\s\\S]*?)${escapeRegex(closeTag)}`,
  );
  const m = block.match(regex);
  return m ? m[1].trim() : "";
}

function extractAbstract(block) {
  const parts = [];
  const regex =
    /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
  let m;
  while ((m = regex.exec(block)) !== null) {
    const label = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text) parts.push(label ? `${label}: ${text}` : text);
  }
  if (parts.length) return parts.join(" ");
  const simpleRegex =
    /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
  while ((m = simpleRegex.exec(block)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, "").trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

function extractPubDate(block) {
  const y = extractTag(block, "<Year>");
  const m = extractTag(block, "<Month>");
  const d = extractTag(block, "<Day>");
  return [y, m, d].filter(Boolean).join(" ");
}

function extractKeywords(block) {
  const kws = [];
  const regex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
  let m;
  while ((m = regex.exec(block)) !== null) {
    const t = m[1].trim();
    if (t) kws.push(t);
  }
  return kws;
}

function cleanText(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadAlreadySummarized() {
  const trackerFile = "docs/summarized_pmids.json";
  if (!existsSync(trackerFile)) return new Set();
  try {
    const data = JSON.parse(readFileSync(trackerFile, "utf-8"));
    return new Set(data.pmids || []);
  } catch {
    return new Set();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let days = 7;
  let maxPapers = 50;
  let outputFile = "papers.json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) days = parseInt(args[++i]);
    if (args[i] === "--max-papers" && args[i + 1])
      maxPapers = parseInt(args[++i]);
    if (args[i] === "--output" && args[i + 1]) outputFile = args[++i];
  }

  const alreadySummarized = loadAlreadySummarized();
  console.error(
    `[INFO] Already summarized PMIDs: ${alreadySummarized.size}`,
  );

  const allPmids = new Set();

  for (const sq of SEARCH_QUERIES) {
    const query = sq.query(days);
    console.error(`[INFO] Searching: ${sq.name}...`);
    try {
      const pmids = await searchPapers(query, 30);
      pmids.forEach((id) => allPmids.add(id));
      console.error(`  Found ${pmids.length} PMIDs`);
    } catch (e) {
      console.error(`  [WARN] Search failed: ${e.message}`);
    }
    await sleep(400);
  }

  const newPmids = [...allPmids].filter(
    (id) => !alreadySummarized.has(id),
  );
  console.error(
    `[INFO] Total unique PMIDs: ${allPmids.size}, New: ${newPmids.length}`,
  );

  const pmidsToFetch = newPmids.slice(0, maxPapers);

  let papers = [];
  if (pmidsToFetch.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < pmidsToFetch.length; i += batchSize) {
      const batch = pmidsToFetch.slice(i, i + batchSize);
      console.error(
        `[INFO] Fetching details batch ${Math.floor(i / batchSize) + 1}...`,
      );
      const batchPapers = await fetchDetails(batch);
      papers.push(...batchPapers);
      if (i + batchSize < pmidsToFetch.length) await sleep(400);
    }
  }

  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const outputData = {
    date: getTaipeiDate(),
    count: papers.length,
    new_pmids: pmidsToFetch,
    papers,
  };

  writeFileSync(outputFile, JSON.stringify(outputData, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${outputFile}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
