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

interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Low-level DeepSeek chat completion call.
 * Used by agent.ts via tools/json-mode, and by main.ts for connection testing.
 */
export async function callDeepSeek(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userMessage },
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
