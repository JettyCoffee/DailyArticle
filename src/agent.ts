import { ArxivPaper, fetchPapersByQueries, fetchPapersByQuery } from "./arxiv";
import type { ScoredPaper, PaperSummary } from "./deepseek";

// ──── Progress Reporting ────

export interface ProgressInfo {
  step: "query" | "fetch" | "score" | "summarize" | "crawl" | "done" | "error";
  message: string;
  percent: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

// ──── Orchestrator Result ────

export interface OrchestratorResult {
  allPapers: ArxivPaper[];
  topPapers: ArxivPaper[];
  scoredPapers: ScoredPaper[];
  summaries: PaperSummary[];
}

// ──── Cached Scoring ────

const scoringCache = new Map<string, { score: number; reason: string }>();

function getCachedScore(id: string): { score: number; reason: string } | undefined {
  return scoringCache.get(id);
}

function setCachedScore(id: string, score: number, reason: string): void {
  scoringCache.set(id, { score, reason });
}

// ──── Core: Tool-calling DeepSeek API ────

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
  };
}

async function callDeepSeekWithTools(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  tools: ToolDefinition[],
): Promise<string> {
  // Try with tool_choice="required" for structured output
  const body = {
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userMessage },
    ],
    tools,
    tool_choice: "required" as const,
    temperature: 0.3,
    max_tokens: 4096,
  };

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `DeepSeek API error: ${response.status} ${response.statusText}\n${errorBody}`
    );
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  // If tool_calls were returned, extract arguments from the first tool call
  if (choice?.message?.tool_calls?.[0]?.function?.arguments) {
    return choice.message.tool_calls[0].function.arguments;
  }

  // Fallback: if the model responded with plain text content (e.g., tools not supported)
  if (choice?.message?.content) {
    return choice.message.content;
  }

  throw new Error("Unexpected DeepSeek response: no tool_calls or content");
}

// ──── Fallback: JSON-mode DeepSeek call ────

async function callDeepSeekJson(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userMessage },
    ],
    response_format: { type: "json_object" as const },
    temperature: 0.3,
    max_tokens: 4096,
  };

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `DeepSeek API error: ${response.status} ${response.statusText}\n${errorBody}`
    );
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ──── QueryAgent ────

const QUERY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_queries",
    description: "Submit Arxiv search queries",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Array of Arxiv search queries, each starting with all: prefix",
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
};

async function expandSearchQueries(
  apiKey: string,
  model: string,
  directions: string[],
): Promise<string[]> {
  const systemPrompt =
    "You are a research assistant that generates Arxiv search queries. " +
    "Given research directions, produce 1-2 short queries per direction. " +
    "EVERY query MUST start with all: prefix. Use quotes for multi-word phrases. " +
    "Keep queries broad and simple. Do NOT stack multiple AND conditions.";

  const userMessage = `Generate Arxiv search queries for:\n${directions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`;

  let content: string;
  try {
    content = await callDeepSeekWithTools(apiKey, model, systemPrompt, userMessage, [QUERY_TOOL]);
  } catch {
    // Fallback to JSON mode
    const fallbackPrompt = systemPrompt + "\n\nReturn a JSON object: { \"queries\": [\"...\"] }";
    content = await callDeepSeekJson(apiKey, model, fallbackPrompt, userMessage);
  }

  const result = JSON.parse(content);
  if (!result.queries || !Array.isArray(result.queries)) {
    throw new Error("Query expansion failed: missing 'queries' array");
  }

  return result.queries.map((q: string) => {
    const t = q.trim();
    if (t.startsWith("all:") || t.startsWith("cat:")) return t;
    return `all:${t}`;
  });
}

// ──── ScoringAgent ────

const SCORE_BATCH_SIZE = 20;

const SCORE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_paper_scores",
    description: "Submit scored paper evaluations",
    parameters: {
      type: "object",
      properties: {
        papers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Paper ID" },
              score: { type: "number", description: "Score 1-10" },
              reason: { type: "string", description: "Brief reason for the score" },
            },
            required: ["id", "score", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["papers"],
      additionalProperties: false,
    },
  },
};

async function scorePaperBatch(
  apiKey: string,
  model: string,
  batch: ArxivPaper[],
  language: string,
): Promise<ScoredPaper[]> {
  const langHint = language === "zh-CN" ? "中文" : "English";
  const systemPrompt =
    "You are a research paper reviewer. Score each paper 1-10 on novelty, " +
    "impact, quality, and relevance. Be critical — most papers score 3-7. " +
    `Write reasons in ${langHint}.`;

  const paperList = batch
    .map(
      (p, i) =>
        `[${i + 1}] ID: ${p.id}\nTitle: ${p.title}\nAbstract: ${p.summary}`
    )
    .join("\n---\n");

  const userMessage = `Score these ${batch.length} papers:\n\n${paperList}`;

  let content: string;
  try {
    content = await callDeepSeekWithTools(apiKey, model, systemPrompt, userMessage, [SCORE_TOOL]);
  } catch {
    const fallbackPrompt =
      systemPrompt +
      "\n\nReturn JSON: { \"papers\": [{ \"id\": \"...\", \"score\": 0, \"reason\": \"...\" }] }";
    content = await callDeepSeekJson(apiKey, model, fallbackPrompt, userMessage);
  }

  const result = JSON.parse(content);
  if (!result.papers || !Array.isArray(result.papers)) {
    throw new Error("Scoring failed: missing 'papers' array");
  }
  return result.papers as ScoredPaper[];
}

async function scorePapers(
  apiKey: string,
  model: string,
  papers: ArxivPaper[],
  language: string,
  onProgress?: ProgressCallback,
): Promise<ScoredPaper[]> {
  if (papers.length === 0) return [];

  // Deduplicate by checking cache
  const toScore: ArxivPaper[] = [];
  const cachedResults: ScoredPaper[] = [];
  for (const p of papers) {
    const cached = getCachedScore(p.id);
    if (cached) {
      cachedResults.push({ id: p.id, ...cached });
    } else {
      toScore.push(p);
    }
  }

  if (toScore.length === 0) {
    return cachedResults.sort((a, b) => b.score - a.score);
  }

  // Process in batches
  const allScored: ScoredPaper[] = [...cachedResults];
  const totalBatches = Math.ceil(toScore.length / SCORE_BATCH_SIZE);

  for (let i = 0; i < toScore.length; i += SCORE_BATCH_SIZE) {
    const batch = toScore.slice(i, i + SCORE_BATCH_SIZE);
    const batchNum = Math.floor(i / SCORE_BATCH_SIZE) + 1;

    onProgress?.({
      step: "score",
      message: `评分中... 第 ${batchNum}/${totalBatches} 批 (${Math.min(i + SCORE_BATCH_SIZE, toScore.length)}/${toScore.length} 篇)`,
      percent: Math.round((i / toScore.length) * 80) + 10, // 10-90% range
    });

    const batchResults = await scorePaperBatch(apiKey, model, batch, language);
    for (const r of batchResults) {
      setCachedScore(r.id, r.score, r.reason);
    }
    allScored.push(...batchResults);
  }

  return allScored.sort((a, b) => b.score - a.score);
}

// ──── SummaryAgent ────

const SUMMARY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_paper_summaries",
    description: "Submit detailed paper summaries",
    parameters: {
      type: "object",
      properties: {
        summaries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Paper ID" },
              summary: { type: "string", description: "2-3 sentence summary" },
              keyPoints: {
                type: "array",
                items: { type: "string" },
                description: "3-5 key bullet points",
              },
            },
            required: ["id", "summary", "keyPoints"],
            additionalProperties: false,
          },
        },
      },
      required: ["summaries"],
      additionalProperties: false,
    },
  },
};

async function summarizePapers(
  apiKey: string,
  model: string,
  papers: ArxivPaper[],
  language: string,
  onProgress?: ProgressCallback,
): Promise<PaperSummary[]> {
  if (papers.length === 0) return [];

  const langHint = language === "zh-CN" ? "中文" : "English";
  const systemPrompt =
    "You are a research paper analyst. Generate concise summaries and key points " +
    `in ${langHint}. Summaries should be 2-3 sentences capturing the essence. ` +
    "Key points should be 3-5 specific technical bullet points. " +
    "Keep technical terms in English when commonly used.";

  const paperList = papers
    .map(
      (p, i) =>
        `[${i + 1}] ID: ${p.id}\nTitle: ${p.title}\nAuthors: ${p.authors.join(", ")}\nAbstract: ${p.summary}`
    )
    .join("\n---\n");

  const userMessage = `Summarize these ${papers.length} papers:\n\n${paperList}`;

  onProgress?.({ step: "summarize", message: "正在生成摘要...", percent: 90 });

  let content: string;
  try {
    content = await callDeepSeekWithTools(apiKey, model, systemPrompt, userMessage, [SUMMARY_TOOL]);
  } catch {
    const fallbackPrompt =
      systemPrompt +
      '\n\nReturn JSON: { "summaries": [{ "id": "...", "summary": "...", "keyPoints": ["..."] }] }';
    content = await callDeepSeekJson(apiKey, model, fallbackPrompt, userMessage);
  }

  const result = JSON.parse(content);
  if (!result.summaries || !Array.isArray(result.summaries)) {
    throw new Error("Summarization failed: missing 'summaries' array");
  }
  return result.summaries as PaperSummary[];
}

// ──── PaSaCrawlerAgent ────

const CRAWL_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_crawl_queries",
    description: "Submit expanded search queries based on discovered papers",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Additional Arxiv search queries with all: prefix",
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
};

async function crawlReferences(
  apiKey: string,
  model: string,
  topPapers: ArxivPaper[],
  maxResultsPerQuery: number,
  startDate?: Date,
  endDate?: Date,
  onProgress?: ProgressCallback,
): Promise<ArxivPaper[]> {
  onProgress?.({ step: "crawl", message: "PaSa Agent 正在分析论文并扩展搜索...", percent: 5 });

  // Step 1: Use QueryAgent to generate expanded queries from top papers' keywords
  const keywordHints = topPapers
    .slice(0, 5)
    .map((p) => p.title.replace(/[^a-zA-Z0-9\s]/g, "").slice(0, 80))
    .join("\n");

  const systemPrompt =
    "You are a paper search agent (PaSa Crawler). Given top papers found, " +
    "generate ADDITIONAL Arxiv search queries to find RELATED but DIFFERENT papers " +
    "that cite similar concepts. Generate 2-4 queries. " +
    "CRITICAL: Each query must start with all: prefix. Avoid duplicating existing searches.";

  const userMessage = `Top papers found:\n${keywordHints}\n\nGenerate additional search queries to find more relevant papers.`;

  let content: string;
  try {
    content = await callDeepSeekWithTools(apiKey, model, systemPrompt, userMessage, [CRAWL_TOOL]);
  } catch {
    const fallbackPrompt =
      systemPrompt +
      '\n\nReturn JSON: { "queries": ["all:...", "all:..."] }';
    content = await callDeepSeekJson(apiKey, model, fallbackPrompt, userMessage);
  }

  const result = JSON.parse(content);
  if (!result.queries || !Array.isArray(result.queries)) {
    return []; // No expansion possible
  }

  const queries: string[] = result.queries.map((q: string) => {
    const t = q.trim();
    return t.startsWith("all:") || t.startsWith("cat:") ? t : `all:${t}`;
  });

  onProgress?.({ step: "crawl", message: `PaSa Agent 正在搜索 ${queries.length} 个扩展查询...`, percent: 30 });

  const newPapers = await fetchPapersByQueries(queries, maxResultsPerQuery, startDate, endDate);

  onProgress?.({
    step: "crawl",
    message: `PaSa Agent 扩展找到 ${newPapers.length} 篇额外论文`,
    percent: 60,
  });

  return newPapers;
}

// ──── OrchestratorAgent ────

export interface OrchestratorOptions {
  apiKey: string;
  model: string;
  directions: string[];
  maxResultsPerDirection: number;
  topN: number;
  language: string;
  startDate?: Date;
  endDate?: Date;
  usePaSaCrawler?: boolean;
  crawlerDepth?: number;
  onProgress?: ProgressCallback;
}

export async function orchestrate(
  options: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const {
    apiKey,
    model,
    directions,
    maxResultsPerDirection,
    topN,
    language,
    startDate,
    endDate,
    usePaSaCrawler = false,
    onProgress,
  } = options;

  // Step 1: Generate search queries
  onProgress?.({ step: "query", message: "Agent 正在分析研究方向并生成搜索查询...", percent: 0 });

  let queries: string[];
  try {
    queries = await expandSearchQueries(apiKey, model, directions);
    onProgress?.({ step: "query", message: `已生成 ${queries.length} 条搜索查询`, percent: 5 });
  } catch (e) {
    console.warn("Query expansion failed, using raw directions:", e);
    queries = directions.map((d) => `all:${d}`);
    onProgress?.({ step: "query", message: `直接使用 ${queries.length} 个方向名称搜索`, percent: 5 });
  }

  // Step 2: Fetch papers from Arxiv
  onProgress?.({ step: "fetch", message: "正在从 arXiv 获取论文...", percent: 5 });

  let allPapers = await fetchPapersByQueries(queries, maxResultsPerDirection, startDate, endDate);

  if (allPapers.length === 0) {
    console.warn("Generated queries returned no papers, retrying with raw direction queries");
    const fallbackQueries = directions.map((d) => `all:${d}`);
    allPapers = await fetchPapersByQueries(fallbackQueries, maxResultsPerDirection, startDate, endDate);
  }

  if (allPapers.length === 0) {
    throw new Error("该日期暂无相关论文");
  }

  onProgress?.({ step: "fetch", message: `已获取 ${allPapers.length} 篇论文`, percent: 10 });

  // Step 3: Score papers (batched)
  const scoredPapers = await scorePapers(apiKey, model, allPapers, language, onProgress);

  if (scoredPapers.length === 0) {
    throw new Error("论文评分失败");
  }

  onProgress?.({ step: "score", message: `已评分 ${scoredPapers.length} 篇论文`, percent: 85 });

  // Step 4: PaSa Crawler - expand with reference-like search
  if (usePaSaCrawler) {
    const topForCrawl = scoredPapers.slice(0, Math.min(topN * 2, scoredPapers.length));
    const topPaperObjects = topForCrawl
      .map((sp) => allPapers.find((p) => p.id === sp.id))
      .filter((p): p is ArxivPaper => !!p);

    const crawledPapers = await crawlReferences(
      apiKey,
      model,
      topPaperObjects,
      maxResultsPerDirection,
      startDate,
      endDate,
      onProgress,
    );

    if (crawledPapers.length > 0) {
      // Score new papers from crawling
      const crawledScored = await scorePapers(apiKey, model, crawledPapers, language, onProgress);

      // Merge and re-sort
      allPapers.push(...crawledPapers);
      scoredPapers.push(...crawledScored);
      scoredPapers.sort((a, b) => b.score - a.score);

      onProgress?.({ step: "crawl", message: `扩展后共 ${allPapers.length} 篇论文`, percent: 90 });
    }
  }

  // Step 5: Select Top N
  const scoredMap = new Map<string, ScoredPaper>();
  const paperMap = new Map<string, ArxivPaper>();
  for (const sp of scoredPapers) scoredMap.set(sp.id, sp);
  for (const p of allPapers) paperMap.set(p.id, p);

  const topPapers: ArxivPaper[] = [];
  for (const sp of scoredPapers.slice(0, topN)) {
    const paper = paperMap.get(sp.id);
    if (paper) topPapers.push(paper);
  }

  // Step 6: Generate summaries
  const summaries = await summarizePapers(apiKey, model, topPapers, language, onProgress);

  // Merge scores into summaries
  const enrichedSummaries: PaperSummary[] = summaries.map((s) => {
    const scored = scoredMap.get(s.id);
    return {
      ...s,
      score: scored?.score ?? 0,
      reason: scored?.reason ?? "",
    };
  });

  onProgress?.({ step: "done", message: "✅ 完成！", percent: 100 });

  return {
    allPapers,
    topPapers,
    scoredPapers,
    summaries: enrichedSummaries,
  };
}
