# 数据契约 v1 · 阅读器 v1.6.0

JSON Schema 位于 `schemas/`；`reader.py validate` 执行内容关系与来源检查。修改 paper 后执行 freeze，再准备翻译和复核。所有文本是纯文本；样式和图号是区间，禁止把正文作为 HTML。

## Paper

`schemaVersion=1`；`documentId` 首次随机分配后冻结；`sourceSha256` 是输入 PDF 原字节；`rendererVersion` 是构建版本。DOI 只是元数据。`contentFingerprint` 是有序 blockId/en/zh 的 JSON 哈希，改样式不改变它。

pages 保存 pageId、number、width、height、rotation、assetRef。sections 保存 sectionId、titleEn、titleZh、blockIds。blocks 保存 blockId、order、kind、en、zh、enHash、zhHash、translationStatus、sourceSpans。kind 为 heading/body/methods/reference/caption/reporting/figure-label/header-footer/table/equation。figure-label 和有理由的 header-footer 保留在原页，其他均需翻译。

translationStatus 为 pending/translated/needs-review/reviewed；保留原文的 figure-label/header-footer 也可标 original-only。original-only 不能用于正文、方法、参考文献或图注，不能替代需译块的 reviewed。

sourceSpans 为 pageId、glyphStart、glyphEnd（字形数组下标，左闭右开）、bbox（PDF point，[x0,top,x1,bottom]，已按渲染后的页坐标规范化）。扫描转录用 bbox 和 `transcription=true`，并保存 sourceEvidence。不要切开字形来源或将同字形重复放入多个 block。

figures 保存 figureId（如 main:1、extended:2、supplement:1）、scope、number、sourcePageId、crop、assetRef、captionBlockIds、panelLabels、representation。图形资源默认高分辨率原页裁切；原 PDF 内联供矢量核对。若降采样不能分辨细节，增大 scale 或保留独立原始图对象，并核查。

formatting 保存 blockId、language、start、end、kind（italic/sup/sub）、sourceEvidence。inlineReferences 同样保存 start/end、exactText、figureIds、panelLabels，作用域明确。所有文本偏移是 JavaScript UTF-16 code unit，禁止切开代理对；Python 辅助 `u16len` 转换。DOM textContent 必须精确一致。

idMap 用于拆合：`{oldBlockId,newBlockId,language,oldStart,oldEnd,newStart,newEnd,oldText,newText}`；区间等长且 oldText/newText 完全相等才可自动迁移。无映射时保留 unresolved。sourceEdits 保存 blockId、before、after、reason、sourceEvidence；记录断词和换行重建，不能隐瞒英文改写。

validate核验idMap目标字符及UTF-16边界，拒绝重复或重叠导致的歧义；图引用内部targets也必须在父范围内、逐字相同且作用域属于父引用。可选paragraphMerges记录明确人工same决定、oldBlockIds、mergedBlockId、joiners、utf16Offsets、oldTextHashes与sourceEvidence，纳入reviewFingerprint。它是历史重组记录，不是自动分段判断。详见自然段边界规范。

## Manifest 与复核

source-manifest 保存原文件哈希、页数、提取工具版本、原始字形与字体坐标、逐页区域覆盖、图像/矢量/扫描候选和未分类问题。每个字形只归属一个 block 或有依据的排除。页级复核不能替代每段翻译。components 的 body/methods/references/captions/mainFigures/extendedData/reportingSummary 按来源填写 present 或 absent 并说明原页依据。

review 绑定 sourceSha256、contentFingerprint 和 reviewFingerprint（来源范围、图、格式与索引的独立哈希）。pages 每页记录 status 和 evidence；blocks 每个需译段记录 status 和 evidence；figures 每图记录 status 和 evidence；components 按上述范围记录。只有实际复核可标 pass。改英文、中文、图或科学格式会使旧 review 失效；改模板代码会使旧浏览器验收失效，但不移动笔记。build 不会把未执行的浏览器测试写成通过。

可选 `reviewScopes` 按实际执行范围保存状态：例如 `paragraphRepair` 是已核对的局部段落修复，`fullScientificReview` 是整篇科学内容与译文的人工审校。每项为对象，`status` 取 `pass/fail/blocked/pending/not-performed/unknown`，可含 `label/labelEn/labelZh`；`evidence` 是非空文字或非空文字数组，`pass` 必须有证据。没有完整审校时明确记 `not-performed`，缺失则保持未知，不能由技术结果推断为 pass。

`qa-report.json` 保留 `content`、`browser`、哈希、范围状态和 `overall.status`；原始结构化 `issues` 也保留在内联数据与检查 JSON 中。任一检查或范围 fail，overall 为 fail；只有机器与浏览器均 pass，完整科学审校有证据且所有已声明范围均 pass 时，overall 才为 pass；其余为 partial。正常 build 仍只受内容门槛控制，不能据此声称科学审校完成。`reviewScopes` 纳入 `reviewFingerprint`；先定范围再生成并接受 review，不能改 scope 后沿用旧指纹。v1.5.0 的 UI 与技术迭代记录未重新执行完整科学审校；当前版本仍须根据每次实际执行范围填写审校状态，不能继承历史技术记录为全文通过。

## 完整原 PDF 与来源跳页

HTML 内联完整原始 PDF 与全部来源页图，原文件字节须与 `sourceSha256` 一致。“原页”按钮依据 block 的 `sourceSpans.pageId` 与 `pages.number` 选择对应页，不把正文显示序号当 PDF 页码。原生查看器与连续栅格页图回退都是完整来源；页数由数据决定，不固定为某个测试文献的页数。

有效原生跳页使用新的 Blob URL，复用同一个已解码的原 PDF Blob；首次直接跳往非首页时只请求该目标。旧 URL 在适当生命周期释放。查看器不可用或加载报错时，保留目标页并回退到完整连续原页图。`iframe.src` 的页码片段或外层 `dataset` 仅供诊断；`source-button-native-pdf-page-jumps` 必须实际点击正文原页按钮，并在原生 PDF 查看器真实页码计数器中验证目标，配合截图核对。DOM、单元测试或 iframe load 不能替代这项真实验收。

## Notes

format=micro-paper-notes、schemaVersion=1、documentId、sourceSha256、contentFingerprint、exportedAt、annotations。每条保存 annotationId、blockId、language、start/end、quote、prefix/suffix、textHash、color、note、createdAt、updatedAt，以及定位状态。JSON 始终导出冲突和未定位记录。

`color` 支持 `yellow/green/blue/pink/orange`，分别显示浅黄、浅绿、浅蓝、浅粉、浅橘。旧黄、蓝、绿记录无需重写身份或升级 schema。五色从选区浮条、笔记编辑和列表显示到本地保存、JSON 与 HTML 快照均使用同一枚举；不能仅让按钮显示新颜色而在序列化时丢失。浮条缓存经验证的单语言选区范围，点击或触摸操作后仍针对原选区。

笔记 v1 必填字段不变，继续兼容自 v1.3.0 引入的可选 `snapshotId`（单次内嵌快照标记）及 `embeddedSnapshots`（本地已合并的快照标记数组）。下载的 HTML 在独立 `embedded-notes` JSON 槽携带当前高亮、五种颜色和笔记，不写入规范 paper 数据。空本地存储可以恢复快照；已有本地记录优先，同 ID 的真实差异保留为冲突副本。已应用的快照标记防止重开时恢复用户随后删除或改色的旧记录，重复标记在运行时去重。旧 v1 JSON 不含这些字段仍可读取。每条可选 `sourceDocumentId` 与 `sourceSha256` 保留笔记自己的来源；跨论文、跨源或无法核实的位置继续保留 unresolved，不因导出/重开而冒充当前论文。损坏记录和未核实位置不能用快照标记掩盖；JSON 与 Markdown 备份继续可用。

迁移依次验证同来源精确区间、稳定 blockId 中唯一引文与前后上下文、显式 idMap。不同 sourceSha256、多个匹配或格式不支持不能自动定位。导入先预览数量，确认后合并；同 ID 不同内容保留冲突副本。存储失败保留内存数据并提示备份。file:// 改名移动或不同浏览器的存储不保证共享，使用 JSON 迁移。

## 文章信息区

可选 `articleInfo` 指定经过来源复核的元数据章节 `sectionIds` 及字段 `fields`。字段含唯一 `key`、`labelEn`、`labelZh`、来自这些章节的 `blockIds`，例如作者、标题、DOI、发表日期、收稿/接收日期、期刊和授权字段。旧 `collapsed` 字段仍可读取，但本版信息区完整自然展开，不据它折叠作者或单位。只把原页学术元数据映射到信息区；不把摘要、Methods、正文、图注或参考文献映射为元数据。

显示结构不改变原 blockId/en/zh/sourceSpans。规范题名块位于字段上方，双语文字、原格式、来源及批注坐标保留；其余字段使用固定窄标签、宽值两列，不排为多列字段卡片。作者和单位完整换行显示，不截断，不添加空字段或解释性小字。对照模式下，同一来源块的完全相同双语值可共享显示；DOI 字段中可核验的相同中英文标识符避免双写。不同 canonical 来源块不合并去重，完整规范字符串仍保存在数据与 DOM。所有 canonical 元数据块仍可搜索、选择和批注。

无来源块映射时，可从明确的 `metadata.authors/doi/journal/year/publicationYear` 显示结构化回退值；空值不生成空行，不伪造 blockId 或注释坐标。只有 metadata-only 的期刊与年份可合并为一行；有 canonical 来源映射时不为合并显示而重写、拼接或删除源块。不从 DOI、标题、日期或正文猜期刊与年份。旧文档未配置 `articleInfo` 时，仅按明确的文章信息章节处理；无法确认的内容保持普通正文，不按关键词折叠科学段落。`validate` 拒绝未知章节、重复字段/块引用或将非元数据内容类型作为字段；复核指纹包含这项显示映射。

## v1.5.0 显示索引与设置

`caption` 块在右侧图注池保留唯一规范 DOM，优先依 `figures.captionBlockIds` 显示所属图。未声明归属时，显示回退只接受图注开头且范围、exactText 已核实的明确图号标题，并要求后接 `|`、冒号或句点；若 EN/ZH 都提供标题却指向不同图，保持未关联。正文中的后续交叉引用不能认作图注归属，不按主题猜图，也不回写来源归属。未关联的图注保留并提示。移动显示位置不改 blockId、文本、UTF-16 区间、来源、格式或 notes schema，不新增 `idMap`；旧图注笔记仍定位同一来源块。

生成的章节标题仅在章节内首个可见 heading 是来源标题，且其 EN/ZH 与章节标题分别同时匹配时省略；比较只归一空白，区分大小写和标点。原文 heading 的身份、文本和格式保留。目录恒显中英两行，排除纯图注章节和图目录；旧纯图注章节目标仍可路由到首个规范图注块。这些是显示索引，不是来源文本编辑。

可选 `readerSettings.columnLayout` 是 `{sidebarWidth:number|null,articleFraction:number}`，比例为 0–1；字段可省略使用默认。宽度按当前视口夹紧，不设固定屏幕宽度。拖动偏好目前只在本次页面会话内，不自动写回数据或存储。旧图片设置仍可读但不决定本版初始显示；导出设置、schemaVersion=1 及笔记 v1 兼容。详见 [显示设置](reader-settings.md)。

## v1.5.0 层级目录与图片比例

可选 `paper.toc` 为 `{version:1,items:[...]}`。每个节点必须有全树唯一的非空 `id`、`titleEn`、`titleZh` 和 `role`；`role` 仅取 `source` 或 `navigation-group`。节点可含 `children`、`open`、`sourceBlockIds` 和文字 `evidence`。`source` 必须指向真实存在的 `targetId`；导航分组可以省略 target，但必须有子节点。任何已声明的 target 都必须是真实的 sectionId 或规范 blockId，且不能是 caption、figure-label、header-footer，也不能是仅含这类内容的章节。导航分组与子节点可以指向同一有效位置；它们的节点 ID 仍须不同。层级最多嵌套 16 层，不接受循环、无效孩子、缺少任一语言标签或伪造目标。可选 `sourceBlockIds` 必须是该论文真实存在的非图注源块，且在单个节点内不重复；它提供复核线索，不会把导航标签插入正文。

`source` 表示导航目的地来自规范来源，不自行宣称目录标签就是 PDF 印刷标题。逻辑分组、跨章节归纳与发表信息标签需按来源说明依据；目录不会生成或重排正文、修改标题原文或增加迁移映射。旧论文不含 toc 时仍按章节与独立 heading 生成回退目录。兼容旧位置 `readerSettings.toc`，仅在 `paper.toc` 缺失时使用；活动配置接受同样校验。目录始终保留双语，图注仍在图栏通过规范 blockId 定位。

可选 `metadata.journal` 是经过来源核实的期刊名纯文本，不从文章主题猜测。`paper.toc`、兼容目录配置与 `metadata.journal` 纳入 `reviewFingerprint`；修改会使来源复核身份失效，但不改变规范文本 `contentFingerprint`，也不直接迁移笔记。

可选 `readerSettings.figureScaleSchema` 接受 `1/2/3` 以兼容历史数据。缺失或 `1` 是旧适配框偏好，`2` 是旧源像素偏好；本版均忽略这些初始比例及旧存储偏好，以 `3` 表示完整适应默认。运行时使用 schema 3 与兼容 `figureInitialScale=1`，数字输入仅是当前图相对 contain fit 的 0.5–8 倍，不回写为持久偏好或 HTML 默认。即使旧数据带自定义初值，也不能据此覆盖本版完整适应。只改变显示设置，不重写论文、图片或旧笔记。

普通图打开、切换及重置时显示完整原图，保持比例且不裁切或拉伸。图框宽度占满右栏，高度按来源图比例计算并受可用视口上限约束，不使用固定 3:4、A4 或 Letter 比例；图注紧接图像区域。普通图与放大对话框均以各自可用区域做 contain fit，当前倍率和像素缩放值是不同概念。用户主动放大后的视图不作为下次选图默认。

## 阅读字号与本地搜索状态

可选 `readerSettings.readingFontSize` 是 14–26px 的阅读字号，默认 18px，控件步长 1px；正文 EN/ZH 与右侧 Legend 使用同一数值。规范标题、紧凑元数据与 UI 控件排除。偏好按 `documentId` 与 `sourceSha256` 共同隔离，独立本地设置优先于内嵌值；当前值随下载 HTML 的 paper 数据保存。该字段只控制显示，不改变 `contentFingerprint`、文本、来源或笔记 v1。

搜索只索引当前 paper 中的规范 EN/ZH 字符串，逐处命中记录 blockId、language 与原始 UTF-16 start/end。CSS Highlight API 或独立矩形覆盖层负责临时显示；不得在规范 DOM 中插入搜索 mark、改变 textContent、覆盖永久高亮或修改 annotations。查询、匹配集合、当前结果和临时语言显示是页面运行状态，不进入笔记快照。隐藏语言与图注定位复用已有规范 block 路由；清空移除临时状态。搜索不调用外部服务。

当前 `rendererFingerprint` 覆盖实际载入的模板、CSS、阅读器脚本、文章信息 CSS、笔记状态、目录、原 PDF 模块、选区浮条/字号/搜索模块、文献引用脚本与样式以及打包脚本；已不载入的状态展示模块不参与。`REQUIRED_BROWSER` 为 22 项：五色浮条门槛为 `five-color-floating-highlights-and-portable-notes`，导航门槛为 `navigation-and-mobile`，保留 v1.5.0 引入的 `reading-font-size-controls-and-persistence`、`local-bilingual-search-and-note-anchors`、`mobile-touch-selection-and-toolbar` 三项门槛，v1.6.0 另有 `source-bound-bibliography-citation-targets` 与 `bibliography-citation-keyboard-mobile-search-notes` 两项文献引用门槛，其余既有来源、图像、元数据及三项笔记门槛保留。完整名称、入口和实际证据要求见 [验收规范](qa.md)。缺少任一当前检查证据时不能沿用旧 browser pass，未执行的项目保留 blocked。技术与交互通过仍不等于整篇科学全文及译文完成审校；未执行完整科学审校时必须保持 `fullScientificReview.status=not-performed`。

## v1.6.0 参考文献定位注解

`referenceTargets` 保存来源核实的实际编号到唯一 `kind=reference` 规范块的映射；`referenceCitations` 保存正文 EN/ZH 的 UTF-16 原字符范围、精确标签、按出现顺序展开的编号和字形/译文配对证据。`referenceCitationCandidates` 仅保留未解决候选，不渲染为链接。详见 [引用证据契约](reference-citations.md)。这些字段绑定 reviewFingerprint，但不改变内容 fingerprint、规范字符或笔记坐标。旧数据缺这些字段仍可读取，不能据缺省空数组声称全部引用已核查。

新建论文的 `structure-approval.json` 绑定英文来源、章节、格式、图与图注语境，翻译响应分开存放，由共享写入锁统一提交。来源独立 inventory、完整边界台账和引用候选审查属于外部证据，不允许从 paper 自复制生成期望值。入口见 [来源流程](source-pipeline.md) 与 [翻译事务](translation-pipeline.md)。

独立转录来源：保留既有 `transcription:true`/`bbox`/`sourceEvidence`，增加 `regionId` 及该区域 EN 在规范块中的 UTF-16 `textStart`、`textEnd`。转录不制造原生 glyph 下标；同块可保留实际存在的原生片段。规范 `sourceTranscriptionLedgerSha256` 绑定实际 PDF 页图先行建立并审核的独立账本，段落合并需同步映射，译前审批及翻译提交核验账本身份。
