import { ArxivPaper, preparePaperForScoring } from "./arxiv";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface ScoredPaper {
  id: string;
  score: number;
  reason: string;
}

export interface PaperSummary {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  score: number;
  reason: string;
}

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

async function callDeepSeek(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const messages: DeepSeekMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `DeepSeek API error: ${response.status} ${response.statusText}\n${errorBody}`
    );
  }

  const data: DeepSeekResponse = await response.json();
  return data.choices[0].message.content;
}

/**
 * Use DeepSeek as an Agent to expand user's research directions into
 * optimized Arxiv search queries (searching title + abstract).
 *
 * Each direction produces a query string like: `ti:Agent OR abs:"large language model agent"`
 */
export async function expandSearchQueries(
  apiKey: string,
  model: string,
  directions: string[]
): Promise<string[]> {
  const systemPrompt = `You are an AI research assistant that helps search academic papers on Arxiv.
Given a list of research directions from a user, generate optimized search queries for the Arxiv API.

Rules:
- EVERY query MUST start with \`all:\` prefix (this searches title + abstract)
- For each direction, generate 1-2 alternative search terms/phrases
- Use OR between alternatives for the same direction (broader = better)
- Use quotes for multi-word phrases, like \`all:"multi-agent systems"\`
- Keep queries short and broad — avoid stacking multiple AND conditions
- Focus on recent AI/ML research terminology

CRITICAL: Each query must begin with "all:". Examples of GOOD queries:
  - all:Agent
  - all:"reinforcement learning"
  - all:"large language model"
  - all:"graph RAG" OR all:"knowledge graph"

Return a JSON object:
{ "queries": ["query1", "query2", ...] }`;

  const userMessage = `Generate Arxiv search queries for these research directions:\n${directions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`;

  const content = await callDeepSeek(apiKey, model, systemPrompt, userMessage);
  const result = JSON.parse(content);

  if (!result.queries || !Array.isArray(result.queries)) {
    throw new Error("Query expansion failed: missing 'queries' array");
  }

  // Safety: ensure every query has the all: prefix
  return result.queries.map((q: string) => {
    const trimmed = q.trim();
    if (trimmed.startsWith("all:") || trimmed.startsWith("cat:")) return trimmed;
    return `all:${trimmed}`;
  });
}

/**
 * Score all papers by sending them to DeepSeek for relevance evaluation.
 * Returns scored paper list sorted by score (descending).
 */
export async function scorePapers(
  apiKey: string,
  model: string,
  papers: ArxivPaper[],
  language: string
): Promise<ScoredPaper[]> {
  const prepared = preparePaperForScoring(papers);
  const langHint = language === "zh-CN" ? "中文" : "English";

  const systemPrompt = `You are an AI research assistant that evaluates Arxiv papers. Score each paper on a scale of 1-10 based on:
- Novelty and significance of the contribution
- Potential impact on the field
- Quality of the research
- Relevance to current AI/ML trends

Return a JSON object with a "papers" array: [{ "id": "paper_id", "score": number, "reason": "brief explanation in ${langHint}" }]

Score guidelines:
- 9-10: Breakthrough, highly novel work
- 7-8: Strong contribution, solid results
- 5-6: Incremental but solid work
- 1-4: Marginal relevance or minor contribution

Be critical and discerning. Not every paper deserves a high score.`;

  const paperList = prepared
    .map(
      (p, i) =>
        `[${i + 1}] ID: ${p.id}\nTitle: ${p.title}\nAbstract: ${p.summary}`
    )
    .join("\n---\n");

  const userMessage = `Please score the following ${prepared.length} papers:\n\n${paperList}`;

  const content = await callDeepSeek(apiKey, model, systemPrompt, userMessage);
  const result = JSON.parse(content);

  if (!result.papers || !Array.isArray(result.papers)) {
    throw new Error("Unexpected DeepSeek response format: missing 'papers' array");
  }

  // Sort by score descending
  const scored = result.papers as ScoredPaper[];
  scored.sort((a, b) => b.score - a.score);

  return scored;
}

/**
 * Generate detailed summaries for the top papers.
 */
export async function summarizePapers(
  apiKey: string,
  model: string,
  papers: ArxivPaper[],
  language: string
): Promise<PaperSummary[]> {
  const langHint = language === "zh-CN" ? "中文" : "English";

  const systemPrompt = `You are an AI research assistant. Generate a detailed analysis for each paper in ${langHint}.
For each paper, provide:
1. A concise summary (2-3 sentences) of what the paper does
2. 3-5 key bullet points highlighting the main contributions, methods, or findings

Return a JSON object with a "summaries" array:
[{ "id": "paper_id", "summary": "concise summary in ${langHint}", "keyPoints": ["point 1", "point 2", ...] }]

The summary should be informative and capture the essence of the paper. Key points should be specific and technical.
While in zh-CN, some technical terms can be left in English if they are commonly used in the research community.`;

  const paperList = papers
    .map(
      (p, i) =>
        `[${i + 1}] ID: ${p.id}\nTitle: ${p.title}\nAuthors: ${p.authors.join(", ")}\nAbstract: ${p.summary}`
    )
    .join("\n---\n");

  const userMessage = `Generate detailed summaries for the following ${papers.length} papers:\n\n${paperList}`;

  const content = await callDeepSeek(apiKey, model, systemPrompt, userMessage);
  const result = JSON.parse(content);

  if (!result.summaries || !Array.isArray(result.summaries)) {
    throw new Error("Unexpected DeepSeek response format: missing 'summaries' array");
  }

  return result.summaries as PaperSummary[];
}
