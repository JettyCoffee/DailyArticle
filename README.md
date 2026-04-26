# DailyArticle

![Obsidian Min App Version](https://img.shields.io/badge/Obsidian-v0.15.0+-blue?style=flat-square&logo=obsidian)
![Version](https://img.shields.io/badge/version-1.0.0-success?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue?style=flat-square&logo=typescript)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**DailyArticle** 是一款为 Obsidian 设计的插件。它每日自动从 Arxiv 获取最新论文，并通过 DeepSeek API 对其进行评分和排序，为您生成高质量的精选论文日报。

## Features

- **自动抓取**: 自动从 Arxiv && PaSa 获取指定领域的最新论文。
- **AI 辅助筛选**: 集成 DeepSeek（未来适配其他 AI），对获取的论文进行自动打分和智能排序。
- **优选日报**: 将高分论文统一整理并生成 Markdown 格式的精选日报。

## Installation

### 选项 1：通过 Obsidian 社区插件市场安装（当前暂不可用）

1. 打开 Obsidian 设置 > 第三方插件 (Community Plugins)
2. 关闭 "安全模式" (Safe Mode)
3. 点击 "浏览" (Browse) 并在搜索框中输入 **DailyArticle**
4. 安装并启用插件

### 选项 2：手动安装

1. 前往本仓库的 [Releases](#) 页面下载最新版本的 `daily-article.zip`。
2. 解压后得到名为 `daily-article` 的文件夹。
3. 将这个文件夹放到 Obsidian 库的 `.obsidian/plugins/` 目录下。
4. 重新启动 Obsidian 或在设置中刷新插件列表。
5. 在第三方插件列表中启用 **DailyArticle**。

## Configuration & Usage

1. **启用插件** 后，进入 Obsidian 插件设置界面的 **DailyArticle** 选项卡。
2. **DeepSeek API 设置**: 输入您的 DeepSeek API Key 启用 AI 智能分析和评分功能。
3. **兴趣抓取设置**: 输入你感兴趣的关键词或分类体系。
4. **生成日报**: 配置好参数后，可以使用插件提供的命令 (Command Palette: `Ctrl/Cmd + P`) 搜索 `DailyArticle` 来手动触发日报生成，也可以设置每日自动定时生成。

## Development

如果希望自行编译或改进此插件，请确保已安装 Node.js 和 npm。

```bash
# 克隆仓库
git clone https://github.com/your-username/DailyArticle.git
cd DailyArticle

# 安装依赖
npm install

# 编译项目 (Development)
npm run dev

# 构建项目 (Production)
npm run build
```

## License

本项目基于 [MIT License](LICENSE) 授权，更多信息请参阅 LICENSE 文件。
