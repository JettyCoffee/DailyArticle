import { Plugin, Notice, TFile } from "obsidian";
import {
  DailyArticleSettings,
  DEFAULT_SETTINGS,
  DailyArticleSettingTab,
} from "./settings";
import { fetchPapersByQueries, ArxivPaper } from "./arxiv";
import { scorePapers, summarizePapers, expandSearchQueries, ScoredPaper, PaperSummary } from "./deepseek";
import { generateMarkdown, getOutputFilename } from "./output";

export default class DailyArticlePlugin extends Plugin {
  settings: DailyArticleSettings;
  private lastFetchDate: string = "";

  async onload() {
    try {
      await this.loadSettings();

      this.addSettingTab(new DailyArticleSettingTab(this.app, this));

      this.addCommand({
        id: "fetch-today-papers",
        name: "立即获取今日论文",
        callback: () => {
          this.fetchAndProcess();
        },
      });

      this.addCommand({
        id: "test-deepseek-connection",
        name: "测试 DeepSeek API 连接",
        callback: () => {
          this.testConnection();
        },
      });

      // Schedule: check every 60 seconds if it's time to fetch
      const intervalId = window.setInterval(() => {
        this.checkScheduledFetch();
      }, 60_000);
      this.registerInterval(intervalId);

      console.log("DailyArticle plugin loaded");
    } catch (e) {
      console.error("DailyArticle plugin failed to load:", e);
    }
  }

  onunload() {
    console.log("DailyArticle plugin unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private parseResearchDirections(): string[] {
    return this.settings.researchDirections
      .split("\n")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
  }

  private async testConnection() {
    if (!this.settings.deepseekApiKey) {
      new Notice("❌ 请先填写 DeepSeek API Key");
      return;
    }

    new Notice("🔄 正在测试 DeepSeek API 连接...");
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.model,
          messages: [
            { role: "user", content: "Hello" },
          ],
          max_tokens: 10,
        }),
      });

      if (response.ok) {
        new Notice("✅ DeepSeek API 连接成功！");
      } else {
        const text = await response.text();
        new Notice(`❌ API 连接失败: ${response.status} ${text.slice(0, 100)}`);
      }
    } catch (e) {
      new Notice(`❌ 网络错误: ${e.message}`);
    }
  }

  private checkScheduledFetch() {
    if (!this.settings.fetchTime) return;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Only run once per day
    if (this.lastFetchDate === todayStr) return;

    const [targetHour, targetMin] = this.settings.fetchTime
      .split(":")
      .map(Number);

    if (
      now.getHours() === targetHour &&
      now.getMinutes() === targetMin
    ) {
      this.lastFetchDate = todayStr;
      this.fetchAndProcess();
    }
  }

  async fetchAndProcess() {
    if (!this.settings.deepseekApiKey) {
      new Notice("❌ 请先在设置中填写 DeepSeek API Key");
      return;
    }

    const directions = this.parseResearchDirections();
    if (directions.length === 0) {
      new Notice("❌ 请先在设置中填写研究方向（如 Agent、RL、GraphRAG）");
      return;
    }

    new Notice("🤖 Agent 正在分析研究方向并生成搜索查询...");

    try {
      // Step 1: Agent expands research directions into search queries
      let queries: string[];
      try {
        queries = await expandSearchQueries(
          this.settings.deepseekApiKey,
          this.settings.model,
          directions
        );
        new Notice(`🔍 Agent 已生成 ${queries.length} 条搜索查询，正在获取论文...`);
      } catch (e) {
        // Fallback: use direction names directly as search queries
        console.warn("Query expansion failed, using raw directions:", e);
        queries = directions.map((d) => `all:${d}`);
        new Notice(`🔍 直接搜索 ${queries.length} 个方向，正在获取论文...`);
      }

      // Step 2: Fetch papers from Arxiv using the generated queries
      const allPapers = await fetchPapersByQueries(
        queries,
        this.settings.maxResultsPerDirection
      );

      if (allPapers.length === 0) {
        new Notice("⚠️ 今日 Arxiv 暂无相关论文");
        return;
      }

      new Notice(`📚 已获取 ${allPapers.length} 篇论文，正在评分...`);

      // Step 3: Score papers via DeepSeek
      const scoredPapers = await scorePapers(
        this.settings.deepseekApiKey,
        this.settings.model,
        allPapers,
        this.settings.outputLanguage
      );

      // Step 4: Select Top N
      const topN = this.settings.topN;

      // Map scored papers by id for quick lookup
      const scoredMap = new Map<string, ScoredPaper>();
      for (const sp of scoredPapers) {
        scoredMap.set(sp.id, sp);
      }

      // Get top N papers in order
      const topPapers: ArxivPaper[] = [];
      for (const sp of scoredPapers.slice(0, topN)) {
        const paper = allPapers.find((p) => p.id === sp.id);
        if (paper) {
          topPapers.push(paper);
        }
      }

      new Notice(`📝 正在生成 Top ${topPapers.length} 论文摘要...`);

      // Step 5: Generate detailed summaries for top papers
      const summaries = await summarizePapers(
        this.settings.deepseekApiKey,
        this.settings.model,
        topPapers,
        this.settings.outputLanguage
      );

      // Merge scores and reasons into summaries
      const enrichedSummaries: PaperSummary[] = summaries.map((s) => {
        const scored = scoredMap.get(s.id);
        return {
          ...s,
          score: scored?.score ?? 0,
          reason: scored?.reason ?? "",
        };
      });

      // Step 6: Generate and write the markdown file
      const markdown = generateMarkdown(
        topPapers,
        enrichedSummaries,
        allPapers.length,
        this.settings.outputLanguage
      );

      await this.writeOutputFile(markdown);

      new Notice(
        `✅ 日报已生成！共 ${allPapers.length} 篇，精选 Top ${topPapers.length}`
      );
    } catch (e) {
      console.error("DailyArticle fetch error:", e);
      new Notice(`❌ 处理失败: ${e.message}`);
    }
  }

  private async writeOutputFile(content: string) {
    const folderPath = this.settings.outputFolder;
    const fileName = getOutputFilename();
    const filePath = `${folderPath}/${fileName}`;

    // Ensure the folder exists
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }
}
