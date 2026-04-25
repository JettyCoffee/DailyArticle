import { ItemView, WorkspaceLeaf, Setting, Notice } from "obsidian";
import DailyArticlePlugin from "./main";
import { MODEL_OPTIONS } from "./settings";

export const VIEW_TYPE = "daily-article-sidebar";

/** Preset time range options */
const TIME_PRESETS = [
  { label: "最近 24 小时", days: 1 },
  { label: "最近 3 天", days: 3 },
  { label: "最近 7 天", days: 7 },
  { label: "最近 30 天", days: 30 },
  { label: "自定义范围", days: -1 },
] as const;

export class DailyArticleSidebarView extends ItemView {
  plugin: DailyArticlePlugin;

  private statusEl: HTMLDivElement;
  private directionDropdown: HTMLSelectElement;
  private timePresetDropdown: HTMLSelectElement;
  private dateStartInput: HTMLInputElement;
  private dateEndInput: HTMLInputElement;
  private dateRangeContainer: HTMLDivElement;

  constructor(leaf: WorkspaceLeaf, plugin: DailyArticlePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "DailyArticle";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen() {
    this.render();
  }

  private getDirections(): string[] {
    return this.plugin.settings.researchDirections
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
  }

  private render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("daily-article-sidebar");

    // ===== Header =====
    const header = containerEl.createDiv("daily-article-header");
    header.createEl("h2", { text: "DailyArticle" });

    // ===== Date Range Card =====
    const dateCard = containerEl.createDiv("daily-article-card");
    dateCard.createEl("h3", { text: "📅 搜索时间范围" });

    // Preset dropdown
    new Setting(dateCard)
      .setName("选择范围")
      .addDropdown((dropdown) => {
        for (const preset of TIME_PRESETS) {
          dropdown.addOption(String(preset.days), preset.label);
        }
        dropdown.setValue("1");
        this.timePresetDropdown = dropdown.selectEl;
        dropdown.onChange(() => this.onTimePresetChange());
      });

    // Custom date range (hidden by default)
    this.dateRangeContainer = dateCard.createDiv("daily-article-date-range");
    this.dateRangeContainer.style.display = "none";

    new Setting(this.dateRangeContainer)
      .setName("起始日期")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.getDefaultDateStr(-7));
        this.dateStartInput = text.inputEl;
      });

    new Setting(this.dateRangeContainer)
      .setName("结束日期")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.getDefaultDateStr(0));
        this.dateEndInput = text.inputEl;
      });

    // ===== Direction Card =====
    const dirCard = containerEl.createDiv("daily-article-card");
    dirCard.createEl("h3", { text: "🔍 研究方向" });

    const directions = this.getDirections();
    if (directions.length > 0) {
      new Setting(dirCard)
        .setName("过滤方向")
        .addDropdown((dropdown) => {
          dropdown.addOption("all", "所有方向");
          for (const dir of directions) {
            dropdown.addOption(dir, dir);
          }
          dropdown.setValue("all");
          this.directionDropdown = dropdown.selectEl;
        });
    }

    // ===== Settings Card =====
    const settingsCard = containerEl.createDiv("daily-article-card");
    settingsCard.createEl("h3", { text: "⚙️ 搜索参数" });

    new Setting(settingsCard)
      .setName("DeepSeek 模型")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(MODEL_OPTIONS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.model);
        dropdown.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    // Max results per direction + Top N side by side
    const rowDiv = settingsCard.createDiv("daily-article-setting-row");
    new Setting(rowDiv)
      .setName("每方向获取数")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.maxResultsPerDirection))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxResultsPerDirection = num;
              await this.plugin.saveSettings();
            }
          });
      });
    new Setting(rowDiv)
      .setName("精选数量")
      .addText((text) => {
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.topN))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.topN = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(settingsCard)
      .setName("输出语言")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("zh-CN", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (value) => {
            this.plugin.settings.outputLanguage = value;
            await this.plugin.saveSettings();
          });
      });

    // ===== Action Card =====
    const actionCard = containerEl.createDiv("daily-article-card");
    actionCard.createEl("h3", { text: "▶️ 操作" });

    new Setting(actionCard).addButton((button) => {
      button
        .setButtonText("搜索并生成报告")
        .setCta()
        .onClick(() => this.handleSearch());
    });

    // Status
    this.statusEl = actionCard.createDiv("daily-article-status");
    this.statusEl.setText("就绪");
  }

  /** Get date string for an offset from today (0 = today, -7 = 7 days ago) */
  private getDefaultDateStr(daysOffset: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString().slice(0, 10);
  }

  /** Show/hide custom date inputs based on preset selection */
  private onTimePresetChange() {
    const val = this.timePresetDropdown?.value;
    const isCustom = val === "-1";
    if (this.dateRangeContainer) {
      this.dateRangeContainer.style.display = isCustom ? "block" : "none";
    }
  }

  /** Compute start and end dates based on the selected preset */
  private getDateRange(): { start?: Date; end?: Date } {
    const presetDays = parseInt(this.timePresetDropdown?.value || "1");

    if (presetDays === -1) {
      // Custom range
      const startVal = this.dateStartInput?.value;
      const endVal = this.dateEndInput?.value;
      if (!startVal || !endVal) {
        new Notice("❌ 请选择起止日期");
        return {};
      }
      const [sy, sm, sd] = startVal.split("-").map(Number);
      const [ey, em, ed] = endVal.split("-").map(Number);
      const start = new Date(sy, sm - 1, sd, 0, 0);
      const end = new Date(ey, em - 1, ed + 1, 0, 0); // midnight of next day
      return { start, end };
    }

    // Preset: from N days ago to now
    const end = new Date();
    const start = new Date(end.getTime() - presetDays * 24 * 60 * 60 * 1000);
    return { start, end };
  }

  private async handleSearch() {
    const selectedDirection = this.directionDropdown?.value;
    const { start, end } = this.getDateRange();

    if (!start || !end) {
      return; // error notice already shown
    }

    let directions: string[] | undefined;
    if (selectedDirection && selectedDirection !== "all") {
      directions = [selectedDirection];
    }

    this.setStatus("🔄 正在搜索论文...");
    const success = await this.plugin.fetchAndProcess(start, end, directions);
    this.setStatus(success ? "✅ 完成" : "❌ 操作失败");
  }

  private setStatus(text: string) {
    if (this.statusEl) {
      this.statusEl.setText(text);
    }
  }
}
