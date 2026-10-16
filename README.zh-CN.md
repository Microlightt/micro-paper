# micro-paper

[English](README.md) | **简体中文**

把英文论文 PDF 做成中英对照的离线 HTML 阅读器。**左边读正文，右边看 Figure，图随阅读自动联动。**

## 五个特点

### 1. 正文与 Figure 分开，阅读时自动联动

桌面上，正文在左，Figure 在右，图栏会根据正文中的图号引用自动切换到对应图片。边读文字，边看原图，不必来回翻页找图。

### 2. 原文、译文、图注一起核对

正文中英逐段对照，图片配完整的双语图注，方便理解原文、逐图核查。图内的英文标签保留原样。

### 3. 按论文结构展开精读

目录沿用原论文的章节层级，例如摘要、引言、方法、结果和讨论。支持折叠和跳转，方便集中阅读某一部分。

### 4. 边看边留下自己的思考

支持五色高亮、阅读笔记和导出，也能调整字号、搜索中英文内容。笔记可备份为 JSON、导出为 Markdown，或随下载的 HTML 一起保存。

### 5. 随时追溯原始信息

查看完整原 PDF，定位正文对应的原页；点击经过来源核实的参考文献编号，跳转核对出处。

## 安装

把仓库地址交给 Agent：

```text
请帮我安装这个 Skill：https://github.com/Microlightt/micro-paper
```

也可以通过 [skills CLI](https://github.com/vercel-labs/skills) 安装：

```sh
npx skills add Microlightt/micro-paper --skill micro-paper
```

无需额外初始化，也无需为本 Skill 配置 API Key。

## 使用

提供英文论文 PDF，并告诉 Agent：

```text
用 $micro-paper 把这份论文做成完整忠实的中英对照离线 HTML 阅读器。
保留原图、双语图注和完整原 PDF，核对来源、译文和阅读交互。
所有产物放在新的独立工作目录，报告实际审校范围和未完成项。
```

你会得到可离线打开的 `reader.html`，以及用于重建和核查的 `paper.json`、来源清单和独立验收报告。也支持修订已有阅读器，修订前请备份笔记。

## 环境与使用边界

- 制作需要 Python 3.10+（`pdfplumber`、`pypdfium2`、`Pillow`）、Node.js 18+，以及能查看原页和操作真实浏览器的 Agent。已有 macOS 运行经验；Windows/Linux 未实机验证。
- 阅读器可离线使用；制作时，论文内容可能由所调用的 Agent 和模型服务处理。下载的 HTML 包含完整 PDF，也可能携带笔记，分享前请核对。
- 翻译和科学审校由 Agent 执行，技术检查不能替代全文审校。测试入口、22 项技术验收和排查方法见[验收规范](references/qa.md)，详细流程见 [SKILL.md](SKILL.md)。
- 真实论文、笔记和运行记录请留在仓库外。本 Skill 不负责自动下载论文或公开托管。

当前版本 **v1.6.0** · [MIT License](LICENSE)
