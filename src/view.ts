import { ItemView, WorkspaceLeaf, Setting, Notice } from "obsidian";
import DailyArticlePlugin from "./main";
import { MODEL_OPTIONS } from "./settings";

export const VIEW_TYPE = "daily-article-sidebar";

export class DailyArticleSidebarView extends ItemView {
  plugin: DailyArticlePlugin;
  private statusEl: HTMLDivElement;
  private dateInput: HTMLInputElement;
  private directionDropdown: HTMLSelectElement;

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

    // Header
    containerEl.createEl("h2", { text: "DailyArticle" });

    // === Search Section ===
    containerEl.createEl("h3", { text: "🔍 搜索论文" });

    // Date picker
    new Setting(containerEl)
      .setName("日期")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(new Date().toISOString().slice(0, 10));
        this.dateInput = text.inputEl;
      });

    // Direction dropdown
    const directions = this.getDirections();
    if (directions.length > 0) {
      new Setting(containerEl)
        .setName("研究方向")
        .addDropdown((dropdown) => {
          dropdown.addOption("all", "所有方向");
          for (const dir of directions) {
            dropdown.addOption(dir, dir);
          }
          dropdown.setValue("all");
          this.directionDropdown = dropdown.selectEl;
        });
    }

    // Search button
    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText("搜索并生成报告")
        .setCta()
        .onClick(() => this.handleSearch());
    });

    // Status
    this.statusEl = containerEl.createDiv();
    this.statusEl.setText("就绪");

    // Divider
    containerEl.createEl("hr");

    // === Quick Settings ===
    containerEl.createEl("h3", { text: "⚙️ 快速设置" });

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("每方向最大获取数")
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    // Divider
    containerEl.createEl("hr");

    // === Update Section ===
    containerEl.createEl("h3", { text: "💾 更新" });
    const versionEl = containerEl.createEl("p");
    const currentVersion = this.plugin.manifest.version || "0.0.0";
    versionEl.setText(`当前版本: v${currentVersion}`);

    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText("检查更新")
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("检查中...");
          try {
            const result = await this.plugin.checkForUpdates();
            if (result === null) {
              new Notice("❌ 检查更新失败，请检查网络连接");
            } else if (result.hasUpdate) {
              new Notice(`✅ 发现新版本 v${result.latestVersion}，正在下载...`);
              const success = await this.plugin.performUpdate(result.latestTag);
              if (success) {
                new Notice("✅ 更新完成！请重启 Obsidian 以应用更新");
                versionEl.setText(
                  `当前版本: v${currentVersion} → v${result.latestVersion}（已下载，重启生效）`
                );
              } else {
                new Notice("❌ 更新失败，请稍后重试");
              }
            } else {
              new Notice(`✅ 已是最新版本 v${result.latestVersion}`);
            }
          } finally {
            button.setDisabled(false);
            button.setButtonText("检查更新");
          }
        });
    });
  }

  private async handleSearch() {
    const dateStr = this.dateInput?.value;
    const selectedDirection = this.directionDropdown?.value;

    if (!dateStr) {
      new Notice("❌ 请选择日期");
      return;
    }

    const [year, month, day] = dateStr.split("-").map(Number);
    const targetDate = new Date(year, month - 1, day);

    let directions: string[] | undefined;
    if (selectedDirection && selectedDirection !== "all") {
      directions = [selectedDirection];
    }

    this.statusEl.setText("🔄 正在搜索论文...");
    const success = await this.plugin.fetchAndProcess(targetDate, directions);
    this.statusEl.setText(success ? "✅ 完成" : "❌ 操作失败");
  }
}
