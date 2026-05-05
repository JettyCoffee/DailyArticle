import { requestUrl, Notice } from "obsidian";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ARXIV_DELAY_MS = 3500; // between requests to avoid 429
const MAX_RETRIES = 3;

export interface ArxivPaper {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  link: string;
  category: string;
}

interface ArxivApiResponse {
  entries: ArxivPaper[];
  totalResults: number;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}${m}${d}${hh}${mm}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseAtomXml(xml: string): ArxivApiResponse {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const entries = doc.querySelectorAll("entry");
  const papers: ArxivPaper[] = [];

  // Use getElementsByTagNameNS for namespace-aware queries; fall back to localName
  const totalResultsEl =
    doc.querySelector("totalResults") ||
    doc.querySelector("opensearch\\:totalResults");
  const totalResults = totalResultsEl
    ? parseInt(totalResultsEl.textContent || "0")
    : entries.length;

  for (const entry of Array.from(entries)) {
    const idEl = entry.querySelector("id");
    const titleEl = entry.querySelector("title");
    const summaryEl = entry.querySelector("summary");
    const publishedEl = entry.querySelector("published");

    const authorEls = entry.querySelectorAll("author name");
    const authors: string[] = Array.from(authorEls).map(
      (el) => el.textContent || ""
    );

    const linkEl = entry.querySelector("link[title='pdf']");
    const link = linkEl
      ? linkEl.getAttribute("href") || ""
      : idEl?.textContent?.replace("http:", "https:") || "";

    // Try localName first (Chromium's querySelector can match by localName across namespaces)
    let catEl: Element | null =
      entry.querySelector("primary_category") ||
      entry.querySelector("arxiv\\:primary_category");
    const category = catEl
      ? catEl.getAttribute("term") || ""
      : entry.querySelector("category")?.getAttribute("term") || "";

    const id = idEl?.textContent?.trim() || "";
    const title = decodeXmlEntities(
      (titleEl?.textContent?.trim() || "").replace(/\s+/g, " ")
    );
    const summary = decodeXmlEntities(
      (summaryEl?.textContent?.trim() || "").replace(/\s+/g, " ")
    );
    const published = publishedEl?.textContent?.trim() || "";

    papers.push({ id, title, summary, authors, published, link, category });
  }

  return { entries: papers, totalResults };
}

async function queryArxiv(
  query: string,
  maxResults: number
): Promise<ArxivApiResponse> {
  const params = new URLSearchParams({
    search_query: query,
    start: "0",
    max_results: String(maxResults),
    sortBy: "submittedDate",
    sortOrder: "descending",
  });

  const url = `https://export.arxiv.org/api/query?${params.toString()}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await requestUrl({ url });

    if (response.status >= 500) {
      throw new Error(`Arxiv API error: ${response.status}`);
    }

    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        const backoff = ARXIV_DELAY_MS * Math.pow(2, attempt);
        console.warn(`arXiv 429, retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await delay(backoff);
        continue;
      }
      throw new Error("Arxiv API rate limited (429) after max retries");
    }

    if (response.status >= 400) {
      throw new Error(`Arxiv API error: ${response.status}`);
    }

    const xml = response.text;
    return parseAtomXml(xml);
  }

  throw new Error("Arxiv API: unreachable");
}

/**
 * Fetch papers for a single category submitted within the last 24 hours.
 */
export async function fetchPapersByCategory(
  category: string,
  maxResults: number
): Promise<ArxivPaper[]> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const dateRange = `submittedDate:[${formatDate(yesterday)} TO ${formatDate(now)}]`;
  const query = `cat:${category.trim()} AND ${dateRange}`;

  const result = await queryArxiv(query, maxResults);
  return result.entries;
}

/**
 * Fetch papers by an Arxiv search query (using all: field to search title + abstract).
 * @param queryString - the search query
 * @param maxResults - max results to return
 * @param startDate - optional: start of date range. Requires endDate.
 * @param endDate - optional: end of date range. Requires startDate.
 *                  If both omitted, searches the last 24 hours.
 */
export async function fetchPapersByQuery(
  queryString: string,
  maxResults: number,
  startDate?: Date,
  endDate?: Date
): Promise<ArxivPaper[]> {
  let dateRange: string;
  if (startDate && endDate) {
    dateRange = `submittedDate:[${formatDate(startDate)} TO ${formatDate(endDate)}]`;
  } else {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    dateRange = `submittedDate:[${formatDate(yesterday)} TO ${formatDate(now)}]`;
  }
  const query = `${queryString} AND ${dateRange}`;

  const result = await queryArxiv(query, maxResults);
  return result.entries;
}

/**
 * Fetch papers for multiple search queries and merge/deduplicate by paper ID.
 * @param queries - search queries
 * @param maxResultsPerQuery - max results per query
 * @param startDate - optional: start of date range
 * @param endDate - optional: end of date range
 */
export async function fetchPapersByQueries(
  queries: string[],
  maxResultsPerQuery: number,
  startDate?: Date,
  endDate?: Date
): Promise<ArxivPaper[]> {
  const seen = new Set<string>();
  const allPapers: ArxivPaper[] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    try {
      const papers = await fetchPapersByQuery(query, maxResultsPerQuery, startDate, endDate);
      for (const paper of papers) {
        if (!seen.has(paper.id)) {
          seen.add(paper.id);
          allPapers.push(paper);
        }
      }
    } catch (e) {
      console.error(`Failed to fetch query "${query.slice(0, 80)}":`, e);
      new Notice(`⚠️ arXiv 请求错误: ${(e as Error).message?.slice(0, 100)}`, 6000);
    }

    // respect arxiv rate limit between requests
    if (i < queries.length - 1) {
      await delay(ARXIV_DELAY_MS);
    }
  }

  return allPapers;
}

/**
 * Prepare paper data for scoring by DeepSeek — truncate abstracts to save tokens.
 */
export function preparePaperForScoring(papers: ArxivPaper[]): Array<{
  id: string;
  title: string;
  summary: string;
}> {
  return papers.map((p) => ({
    id: p.id,
    title: p.title,
    summary: truncate(p.summary, 300),
  }));
}
