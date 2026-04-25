import { Plugin, Notice, TFile } from "obsidian";
import {
  DailyArticleSettings,
  DEFAULT_SETTINGS,
  DailyArticleSettingTab,
} from "./settings";
import { fetchPapersByQueries, ArxivPaper } from "./arxiv";
import { scorePapers, summarizePapers, expandSearchQueries, ScoredPaper, PaperSummary } from "./deepseek";
import { generateMarkdown, getOutputFilename } from "./output";
import { DailyArticleSidebarView, VIEW_TYPE } from "./view";

const GITHUB_REPO = "JettyCoffee/DailyArticle";

export default class DailyArticlePlugin extends Plugin {
  settings: DailyArticleSettings;
  private lastFetchDate: string = "";
  private isFetching = false;

  async onload() {
    try {
      await this.loadSettings();

      this.addSettingTab(new DailyArticleSettingTab(this.app, this));

      // Register sidebar view
      this.registerView(VIEW_TYPE, (leaf) => {
        return new DailyArticleSidebarView(leaf, this);
      });

      // Ribbon icon to open sidebar
      this.addRibbonIcon("search", "DailyArticle 控制面板", () => {
        this.activateView();
      });

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

      this.addCommand({
        id: "open-daily-article-sidebar",
        name: "打开 DailyArticle 控制面板",
        callback: () => {
          this.activateView();
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

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
    });
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

  /**
   * Fetch papers and generate a report.
   * @param fetchDate - optional: search papers from this specific date (default: last 24h)
   * @param specificDirections - optional: only search these specific directions (default: all)
   * @returns true if the report was generated successfully
   */
  async fetchAndProcess(fetchDate?: Date, specificDirections?: string[]): Promise<boolean> {
    if (this.isFetching) {
      new Notice("⏳ 正在处理中，请稍候...");
      return false;
    }

    if (!this.settings.deepseekApiKey) {
      new Notice("❌ 请先在设置中填写 DeepSeek API Key");
      return false;
    }

    const directions = specificDirections ?? this.parseResearchDirections();
    if (directions.length === 0) {
      new Notice("❌ 请先在设置中填写研究方向（如 Agent、RL、GraphRAG）");
      return false;
    }

    this.isFetching = true;

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
      let allPapers = await fetchPapersByQueries(
        queries,
        this.settings.maxResultsPerDirection,
        fetchDate
      );

      // If DeepSeek-generated queries are too specific for the date range,
      // fall back to broader direction-name queries
      if (allPapers.length === 0) {
        console.warn("Generated queries returned no papers, retrying with raw direction queries");
        const fallbackQueries = directions.map((d) => `all:${d}`);
        allPapers = await fetchPapersByQueries(
          fallbackQueries,
          this.settings.maxResultsPerDirection,
          fetchDate
        );
        if (allPapers.length > 0) {
          new Notice(`🔍 使用研究方向名直接搜索，已获取 ${allPapers.length} 篇论文`);
        }
      }

      if (allPapers.length === 0) {
        new Notice("⚠️ 该日期暂无相关论文");
        return false;
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

      // Map papers by id for quick lookup
      const scoredMap = new Map<string, ScoredPaper>();
      const paperMap = new Map<string, ArxivPaper>();
      for (const sp of scoredPapers) {
        scoredMap.set(sp.id, sp);
      }
      for (const p of allPapers) {
        paperMap.set(p.id, p);
      }

      // Get top N papers in order
      const topPapers: ArxivPaper[] = [];
      for (const sp of scoredPapers.slice(0, topN)) {
        const paper = paperMap.get(sp.id);
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
        this.settings.outputLanguage,
        fetchDate
      );

      await this.writeOutputFile(markdown, fetchDate);

      new Notice(
        `✅ 日报已生成！共 ${allPapers.length} 篇，精选 Top ${topPapers.length}`
      );

      return true;
    } catch (e) {
      console.error("DailyArticle fetch error:", e);
      new Notice(`❌ 处理失败: ${e.message}`);
      return false;
    } finally {
      this.isFetching = false;
    }
  }

  private async writeOutputFile(content: string, date?: Date) {
    const folderPath = this.settings.outputFolder;
    const fileName = getOutputFilename(date);
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

  // ---- GitHub Update ----

  private compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  /**
   * Check GitHub releases for a newer version.
   * @returns update info, or null on network/API error
   */
  async checkForUpdates(): Promise<{
    hasUpdate: boolean;
    latestVersion: string;
    latestTag: string;
  } | null> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
      );
      if (!response.ok) {
        console.error("GitHub API error:", response.status, response.statusText);
        return null;
      }
      const data = await response.json();
      const latestTag: string = data.tag_name || "";
      const latestVersion = latestTag.replace(/^v/, "");

      const currentVersion = this.manifest.version || "0.0.0";
      const hasUpdate = this.compareVersions(latestVersion, currentVersion) > 0;

      return { hasUpdate, latestVersion, latestTag };
    } catch (e) {
      console.error("Failed to check for updates:", e);
      return null;
    }
  }

  /**
   * Download updated plugin files from GitHub and write them to the plugin directory.
   * @returns true if update was applied successfully
   */
  async performUpdate(tag: string): Promise<boolean> {
    try {
      const pluginDir = `${this.app.vault.configDir}/plugins/daily-article`;
      const adapter = this.app.vault.adapter;

      // Ensure plugin directory exists
      if (!(await adapter.exists(pluginDir))) {
        await adapter.mkdir(pluginDir);
      }

      // Files to download (styles.css is optional)
      const files = ["manifest.json", "main.js", "styles.css"];

      for (const file of files) {
        const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/${file}`;
        const response = await fetch(url);

        if (!response.ok) {
          // Skip styles.css if it doesn't exist in the release
          if (file === "styles.css") continue;
          throw new Error(
            `Failed to download ${file}: ${response.status} ${response.statusText}`
          );
        }

        const content = await response.text();
        await adapter.write(`${pluginDir}/${file}`, content);
      }

      new Notice("✅ 更新文件已下载，请重启 Obsidian 生效");
      return true;
    } catch (e) {
      console.error("Update failed:", e);
      new Notice(`❌ 更新失败: ${e.message}`);
      return false;
    }
  }
}
