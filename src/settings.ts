import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import DailyArticlePlugin from "./main";

export const MODEL_OPTIONS: Record<string, string> = {
  "deepseek-v4-flash": "DeepSeek V4 Flash (默认，快速经济)",
  "deepseek-v4-pro": "DeepSeek V4 Pro（最强，更贵）",
  "deepseek-chat": "deepseek-chat（旧版，2026-07-24 停用）",
  "deepseek-reasoner": "deepseek-reasoner（旧版，2026-07-24 停用）",
};

export interface DailyArticleSettings {
  deepseekApiKey: string;
  model: string;
  researchDirections: string;
  fetchTime: string;
  maxResultsPerDirection: number;
  topN: number;
  outputFolder: string;
  outputLanguage: string;
  usePaSaCrawler: boolean;
  crawlerDepth: number;
}

export const DEFAULT_SETTINGS: DailyArticleSettings = {
  deepseekApiKey: "",
  model: "deepseek-v4-flash",
  researchDirections: "Agent\nReinforcement Learning\n",
  fetchTime: "08:00",
  maxResultsPerDirection: 30,
  topN: 10,
  outputFolder: "DailyArticle",
  outputLanguage: "zh-CN",
  usePaSaCrawler: false,
  crawlerDepth: 1,
};

export class DailyArticleSettingTab extends PluginSettingTab {
  plugin: DailyArticlePlugin;

  constructor(app: App, plugin: DailyArticlePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("DeepSeek API Key")
      .setDesc("DeepSeek API 密钥，用于论文打分和摘要生成")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("DeepSeek 模型")
      .setDesc("用于论文打分和摘要生成的模型。V4 Flash 性价比最高")
      .addDropdown((dropdown) => {
        for (const value of Object.keys(MODEL_OPTIONS)) {
          dropdown.addOption(value, MODEL_OPTIONS[value]);
        }
        dropdown
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("研究方向")
      .setDesc("每行一个研究方向，Agent 将自动生成搜索查询。例如：Agent、Reinforcement Learning、GraphRAG")
      .addTextArea((text) =>
        text
          .setPlaceholder("Agent\nReinforcement Learning\nGraphRAG\nLLM")
          .setValue(this.plugin.settings.researchDirections)
          .onChange(async (value) => {
            this.plugin.settings.researchDirections = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("定时获取时间")
      .setDesc("每日自动获取论文的时间（24 小时制）")
      .addText((text) =>
        text
          .setPlaceholder("08:00")
          .setValue(this.plugin.settings.fetchTime)
          .onChange(async (value) => {
            this.plugin.settings.fetchTime = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("每方向最大获取数")
      .setDesc("每个研究方向最多获取的论文数量")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.maxResultsPerDirection))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxResultsPerDirection = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("精选数量")
      .setDesc("每日精选论文数量")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.topN))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.topN = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("输出文件夹")
      .setDesc("生成的 Markdown 文件存放路径（相对于 vault 根目录）")
      .addText((text) =>
        text
          .setPlaceholder("DailyArticle")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("输出语言")
      .setDesc("生成报告的摘要和解析语言")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh-CN", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (value) => {
            this.plugin.settings.outputLanguage = value;
            await this.plugin.saveSettings();
          })
      );

    // Update section
    containerEl.createEl("h3", { text: "💾 更新" });

    new Setting(containerEl)
      .setName("检查更新")
      .setDesc(`当前版本: v${this.plugin.manifest.version || "0.0.0"}`)
      .addButton((button) => {
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
}
