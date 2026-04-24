import { App, PluginSettingTab, Setting } from "obsidian";
import DailyArticlePlugin from "./main";

export interface DailyArticleSettings {
  deepseekApiKey: string;
  arxivCategories: string;
  fetchTime: string;
  maxResultsPerCategory: number;
  topN: number;
  outputFolder: string;
  outputLanguage: string;
}

export const DEFAULT_SETTINGS: DailyArticleSettings = {
  deepseekApiKey: "",
  arxivCategories: "cs.AI\ncs.CL\ncs.CV\ncs.LG",
  fetchTime: "08:00",
  maxResultsPerCategory: 50,
  topN: 10,
  outputFolder: "DailyArticle",
  outputLanguage: "zh-CN",
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
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Arxiv 分类")
      .setDesc("每行一个 Arxiv 分类标签，例如 cs.AI、cs.CL、cs.CV、cs.LG")
      .addTextArea((text) =>
        text
          .setPlaceholder("cs.AI\ncs.CL\ncs.CV\ncs.LG")
          .setValue(this.plugin.settings.arxivCategories)
          .onChange(async (value) => {
            this.plugin.settings.arxivCategories = value;
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
      .setName("每类最大获取数")
      .setDesc("每个分类最多获取的论文数量")
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.maxResultsPerCategory))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxResultsPerCategory = num;
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
  }
}
