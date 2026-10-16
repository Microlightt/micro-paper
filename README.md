# micro-paper v1.6.0

把你提供的英文论文 PDF 制成中英逐段对照的离线 HTML 阅读器。正文在左、原图与完整双语图注在右；保留来源页、科学排版和完整原始 PDF，方便对照阅读、划线和做笔记。

适合全文制作和已有阅读器的忠实修订。它不负责论文总结、自动下载论文或公开托管。翻译与科学审校由调用 Skill 的 Agent 完成，脚本负责提取、校验和打包。

## 能得到什么

- 单文件 `reader.html`：资源内联，可断网打开，支持中英文切换、层级双语目录、逐处全文搜索、同步字号与三栏调宽。
- 原图阅读：完整适应、缩放、平移、放大、正文跟图和固定；图内英文保持原样。来源核实后的参考文献引文可跳到实际条目。
- 阅读笔记：五色选区高亮、笔记编辑、JSON 备份与迁移、Markdown 导出；下载 HTML 可携带当前笔记和显示偏好。
- 可重建资料：`paper.json`、`source-manifest.json`、来源清单及独立 `qa-report.json`，保存内容、来源证据和实际验收范围。

每篇论文使用单独的工作目录。完整 PDF 和原页图会使 HTML 体积较大。详细界面约定见[阅读设置](references/reader-settings.md)、[图片交互](references/image-interactions.md)和[导出设置](references/export-settings.md)。

## 安装

计划发布地址：`https://github.com/Microlightt/micro-paper`。以下远程安装方式在该仓库公开后可用；如采用其他仓库地址，请对应替换。本地目录的 Skill 发现已验证，远程安装尚未执行。

**交给 Agent 安装**：

```text
请帮我安装这个 Skill：https://github.com/Microlightt/micro-paper。先核对来源和内容，再安装到当前宿主的 skills 目录；如已有同名 micro-paper，先比较，避免覆盖已有修改。
```

**命令安装**（可选，需要能运行 `npx`；命令说明见 [skills CLI](https://github.com/vercel-labs/skills)）：

```sh
npx skills add Microlightt/micro-paper --skill micro-paper
```

**手动安装**：下载仓库，将包含 `SKILL.md` 的整个目录复制到宿主的 skills 安装位置，目录名保留为 `micro-paper`。不同宿主的安装位置和加载方式不同，请按其说明操作。同名目录先比较后更新。

无需额外初始化，也无需为 micro-paper 配置 API Key。调用宿主本身的模型账户、权限和费用仍按该宿主的配置处理。

## 环境与兼容范围

|用途|要求|
|---|---|
|PDF 提取、裁图与校验|Python 3.10+；`pdfplumber`、`pypdfium2`、`Pillow`|
|HTML 打包与 JavaScript 回归|Node.js 18+；打包器无额外 npm 依赖|
|Python 自制资料与回归测试|额外安装 `reportlab`|
|浏览器自动化回归|额外安装 Node 包 `playwright`，并提供可用的 Chrome/Chromium；普通离线阅读不需要 Playwright|
|完整制作与验收|能读取本地 PDF、查看原页图、运行脚本、写入工作目录，并操作真实浏览器的 Agent 宿主|

优先复用符合要求的运行时。缺依赖时使用隔离环境，不修改系统 Python。macOS/Linux 示例：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install pdfplumber pypdfium2 Pillow
```

Windows 可用 `py -3 -m venv .venv`，再以 `.venv\Scripts\python.exe` 运行后续 Python 命令。先确认所选解释器版本符合要求。

宿主支持子 Agent 时，可并行处理互不重叠的来源核查与不可变翻译批次，由协调者统一提交；没有子 Agent 时可按同一契约顺序执行。脚本不会自行调用翻译服务。

已有 macOS 本机运行经验；本仓库不据此承诺全部 Agent 宿主或浏览器均已验证，Windows/Linux 尚未实机验证。扫描件、损坏字体、复杂公式和特殊排版需要逐页人工核对，无法辨认的内容保留为阻塞项。

## 使用

向已安装本 Skill 的 Agent 提供本地 PDF，并说明工作目录，例如：

```text
用 $micro-paper 把这份英文论文 PDF 制作成完整忠实的中英双语离线 HTML。
保留原图、完整图注和原 PDF，先核对来源结构，再翻译、审校并完成真实浏览器验收。
所有产物放进新的独立论文工作目录，报告实际审校范围和未完成项。
```

修订已有阅读器时，一并提供其 `paper.json`、来源资料和现有笔记 JSON 备份。让 Agent 保留原始身份与明确的字符映射，先备份笔记再修改；不要只提供截图要求重建已有笔记定位。

Agent 的执行入口在 [SKILL.md](SKILL.md)，详细流程见[来源核查](references/source-pipeline.md)、[自然段边界](references/paragraph-boundaries.md)、[翻译任务](references/translation-pipeline.md)及[引用证据](references/reference-citations.md)。

## 数据与分享边界

阅读器生成后，可在浏览器中离线阅读；搜索和笔记在本地处理，不依赖 CDN、外部字体或在线翻译。笔记首先保存在当前浏览器中，请定期下载 JSON 备份，以便跨浏览器或版本迁移。存储不可用时仅保留内存状态，应及时导出。

制作阶段需要 Agent 读取论文与中间资料。论文内容可能被发送给所调用的宿主及模型服务，具体取决于你的宿主配置和工具；“离线阅读”不表示“制作过程完全离线”。本 Skill 不内置外部翻译 API 或自行上传逻辑。

HTML 内嵌完整原 PDF、正文、译文、图和必要诊断。浏览器“下载 HTML”还会嵌入当时的笔记与高亮快照。分享前检查论文版权、笔记内容及文件中的诊断资料；制作阅读器本身不代表获得公开转载许可。

公开源码仅包含通用脚本、模板、契约和自制测试生成器。真实论文、阅读器成品、笔记、截图、来源与翻译中间文件、模型响应、运行记录都应留在仓库外，例如同级的 `../micro-paper-work/`。计时和运行记录可能包含本机路径、主机名及环境信息，不要直接提交。`.gitignore` 只拦截常见产物名；任意改名的成品或已被 Git 跟踪的文件仍需在发布前检查文件列表。

## 验证与测试

本版有 **22 项技术验收要求**，覆盖离线 PDF、来源跳转、图像、目录、搜索、字号、选区、笔记与导出等行为，详见[验收规范](references/qa.md)。每篇成品仍须在真实浏览器中逐项操作并目视核对截图；没有执行的项目记录为 `blocked`。

机器检查、浏览器通过和局部修复不能替代全文科学审校。来源与译文需要逐页、逐段对照；未做完整科学审校时，报告中的 `fullScientificReview.status` 必须保持 `not-performed`。README 列出入口也不表示这些检查已在你的环境中通过。

以下 macOS/Linux shell 命令从本目录运行，使用自制资料，不需要真实论文或外部翻译服务。将 `python3` 替换为上面隔离环境中的解释器；Windows 需使用对应解释器，并将 Node 测试通配符展开为文件列表，尚未实机验证。

```sh
python3 -m pip install reportlab
python3 -B -m unittest discover -s tests -v
node --test tests/*.unit.cjs tests/test_export_names.cjs tests/test_article_search.cjs
```

部分 Python 测试和样例构建也会调用 Node；完整执行要求 `node` 在命令搜索路径中。`MICRO_PAPER_TEST_NODE` 仅供部分专项测试使用，不能替代完整环境中的 Node。以上为逻辑与打包回归，不等于浏览器验收。

可生成一份带独立来源清单的自写 PDF 和草稿阅读器，输出目录须不存在或为空：

```sh
python3 tests/make_reference_sample.py --out ../micro-paper-test-work/reference
```

生成结果包括 `work/reference-dev-reader.html`、`source-inventory.json`、`figure-ledger.json` 及引用台账。该资料明确标记为开发样例，不是科研结果、真实论文审校或首次制作速度证据。浏览器回归使用 [reader-generic-v160.cjs](tests/reader-generic-v160.cjs) 与 [reference-links-browser.cjs](tests/reference-links-browser.cjs)；测试该样例时加 `--development-fixture true`，完整参数见[验收规范](references/qa.md)。需要 Playwright 时，将它安装在仓库外的专用测试环境，并通过 `--playwright` 指定模块位置、`--chrome` 指定实际浏览器；不要把测试环境、浏览器或生成资料提交到仓库。

## 常见问题

|问题|处理方式|
|---|---|
|提示缺少 Python 包或找不到 Node|确认 Agent 使用的是同一个隔离环境和符合版本要求的运行时；不要向系统 Python 安装依赖。|
|构建或验收显示 `blocked`|先读独立 `qa-report.json`；解决缺译、来源疑点或缺失浏览器证据，不要手动把状态改为通过。未完成内容可构建草稿供复核。|
|原 PDF 查看器无法打开或不能证明跳页|使用连续原页图回退阅读；原生 PDF 页码验收仍须单独保留 `blocked`，不能以回退通过替代。|
|重建后笔记无法定位|先保留原 JSON。仅接受来源核实的文本匹配与明确字符映射；歧义记录保留待定位，避免猜配。|
|测试输出目录已有内容|换一个新的仓库外目录；自制样例生成器拒绝覆盖已有证据。|

## 许可证

本项目采用 [MIT License](LICENSE)，署名使用公开账号 `Microlightt`。论文、原图及读者笔记的权利归属分别由其原权利人决定，源码许可证不授予这些内容的再发布权。
