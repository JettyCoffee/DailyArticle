import { Plugin, Notice, TFile } from "obsidian";
import {
  DailyArticleSettings,
  DEFAULT_SETTINGS,
  DailyArticleSettingTab,
} from "./settings";
import { ScoredPaper, PaperSummary } from "./deepseek";
import { generateMarkdown, getOutputFilename } from "./output";
import { DailyArticleSidebarView, VIEW_TYPE } from "./view";
import { orchestrate, ProgressInfo } from "./agent";

const GITHUB_REPO = "JettyCoffee/DailyArticle";

export default class DailyArticlePlugin extends Plugin {
  settings: DailyArticleSettings;
  private lastFetchDate: string = "";
  private isFetching = false;
  /** Callback for UI to receive progress updates during fetch */
  onProgress: ((info: ProgressInfo) => void) | null = null;

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
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`❌ 网络错误: ${msg}`);
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
   * Fetch papers and generate a report using the OrchestratorAgent.
   * @param startDate - optional: start of date range for paper search
   * @param endDate - optional: end of date range for paper search
   * @param specificDirections - optional: only search these specific directions (default: all)
   * @returns true if the report was generated successfully
   */
  async fetchAndProcess(startDate?: Date, endDate?: Date, specificDirections?: string[]): Promise<boolean> {
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

    try {
      const result = await orchestrate({
        apiKey: this.settings.deepseekApiKey,
        model: this.settings.model,
        directions,
        maxResultsPerDirection: this.settings.maxResultsPerDirection,
        topN: this.settings.topN,
        language: this.settings.outputLanguage,
        startDate,
        endDate,
        usePaSaCrawler: this.settings.usePaSaCrawler,
        crawlerDepth: this.settings.crawlerDepth,
        onProgress: (info) => {
          // Forward progress to UI
          this.onProgress?.(info);
        },
      });

      // Merge scores and reasons into summaries
      const scoredMap = new Map<string, ScoredPaper>();
      for (const sp of result.scoredPapers) {
        scoredMap.set(sp.id, sp);
      }
      const enrichedSummaries: PaperSummary[] = result.summaries.map((s) => {
        const scored = scoredMap.get(s.id);
        return {
          ...s,
          score: scored?.score ?? 0,
          reason: scored?.reason ?? "",
        };
      });

      // Generate and write the markdown file
      const markdown = generateMarkdown(
        result.topPapers,
        enrichedSummaries,
        result.allPapers.length,
        this.settings.outputLanguage,
        startDate
      );

      await this.writeOutputFile(markdown, startDate);

      new Notice(
        `✅ 日报已生成！共 ${result.allPapers.length} 篇，精选 Top ${result.topPapers.length}`
      );

      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("DailyArticle fetch error:", e);
      new Notice(`❌ 处理失败: ${msg}`);
      return false;
    } finally {
      this.isFetching = false;
      this.onProgress?.({
        step: "done",
        message: this.isFetching ? "已取消" : "就绪",
        percent: 100,
      });
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
