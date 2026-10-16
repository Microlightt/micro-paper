# 实际验收 v1.6.0

技术 QA、来源与译文审校必须分别报告。新版流程、界面与技术验收不自动证明完成了全文科学审校。机器或浏览器 pass、局部段落修复 pass、能正常 build，都不能替代 `fullScientificReview` 的实际人工工作与证据。未做完整科学审校时，必须明确保留 `not-performed`。

## 内容与范围

数据门槛：所有来源页和字形被分配，所有需译块有中文，图注归属确定，显式图号均有图，格式区间不越界，哈希正确，无未解决 issues，review 绑定当前内容。components 缺失须标 absent 并写依据。查看原 PDF 不能替代正文和图注翻译。

自然段门槛：按原页核对正文/Methods 的跨栏、物理页、跳过纯图页后的逻辑连接及多页 block 内部连接，记录 same/different/heading/figure-interruption、块 ID、中文同步与原页依据。覆盖或译文块齐全不是自然段证明；未核查边界保持 blocked。显式人工合并的单元测试只证明字符、格式、UTF-16 映射保全，不证明科学译文正确。更正后单独验收笔记迁移，不沿用旧全文 pass。

在生成 review-template 前填写 `paper.reviewScopes`。确实复核过的局部修复可记 `paragraphRepair.status=pass` 并提供非空证据；未做完整科学审校时必须记 `fullScientificReview.status=not-performed`。scope 状态变化纳入 reviewFingerprint，需重新绑定来源复核。机器检查在 `qa.content`，浏览器检查在 `qa.browser`。`overall` 只有在两者及全部已声明人工范围均有证据通过、且包含完整科学审校时才为 pass；其余保守报告 partial，任一 fail 则为 fail。旧文档缺 scope 不能推断审校已完成。

自 v1.5.0 起，阅读界面不显示 `#reader-status`、`#check-report-open` 或检查报告 dialog，也不加载旧 `reader-status.js`。工具栏“阅读笔记”保持固定文字，无动态数量徽标；隐藏的兼容计数不是可见状态。诊断仍完整保留在 HTML 的 `paper-data` 中，包括 `qa`、`reviewScopes`、`issues` 与来源身份；独立 `WORK/qa-report.json` 继续可用。去掉可见状态不能删除诊断、改变状态，或把未做的科学审校写成通过。

## 真实浏览器证据

桌面与手机实际操作 EN／中文／双语、层级双语目录、搜索、图号点击、滚动跟图、多图候选、固定、放大和“原pdf”。元信息使用窄标签、宽内容两列，规范双语题名在字段上方；核对作者、单位自然完整展开、无截断、无空字段或额外说明小字，并核对每个规范块的文字、稳定 ID、格式、来源按钮及选择和笔记。图注仅在右侧浅绿区域保留规范块，字号和字体与对应语言正文一致。

普通图打开、切换及重置时必须完整 contain fit，整图不裁切、不拉伸。图框占满图栏可用宽度，高度按源图比例计算并受可用视口上限约束，不固定成竖框或纸张比例，图注紧接图片区域。逐张检查全部图，并覆盖宽图、长图、列宽变化、短窗口和手机；默认与重置后图的所有边缘须在框内。当前缩放输入及输出是相对适应倍率，范围 0.5–8，不是源像素比例；切换或重开不得沿用旧初始偏好，当前值不持久化。普通图和弹窗“适应”及键 `0` 都恢复各自 contain fit。真实滚轮只在可见图片上缩放，空白、图注与正文保持正常滚动；另验拖动、指针锚定及边界。详见[图片交互契约](image-interactions.md)。

“原pdf”优先打开嵌入的完整原 PDF；核对原始字节哈希和全部来源页。`source-button-native-pdf-page-jumps` 须从正文实际“原页”按钮验证首次直达非首页、已打开后的跨页、回首页和重复跳转，目标由 `sourceSpans` 与 `pages.number` 决定。读取原生 PDF 查看器自己的真实页码计数器，并以可读截图核对；只比较 iframe 属性、URL 的 `#page`、数据集或 load 事件不能记 pass。

禁用浏览器 PDF 查看器、解码/Blob 异常或 iframe error 时，可回退为按源页顺序排列的全部连续栅格页图，目标仍保留。原生 PDF 与页图回退分开验收，能力模拟通过不能冒充原生跳页通过。当前实现没有对原生查看器静默失败的超时检测；无法访问真实原生页码时，该项保留 blocked。

用真实鼠标或键盘跨斜体、上下标、引用按钮和已有高亮选择，检查 textContent 与 quote 一致。浅黄、浅绿、浅蓝、浅粉、浅橘高亮均须保存、刷新和编辑；下载 HTML 后在全新本地存储上下文打开，核对独立嵌入快照、颜色与笔记，且已有本地删改不被旧快照复活。JSON 下载上传、Markdown 下载、冲突预览、存储失败仍须执行。跨版本修订、段落拆合、图注搬到右栏或不同来源导入均不得丢笔记或猜定位；外来来源身份必须保留，不能仅因相同文字就自动定位。

浮条须在真实选区附近显示深绿圆角底、五个浅色圆块与“添加笔记”。逐色实际点击，确认无需再次选择即可立即高亮；添加笔记仍引用原选区。检查边缘夹紧与不抢选区。手机使用触摸选区和触摸点击，并如实注明 Chrome 触摸模拟或物理设备；直接注入 Range、修改 storage 或合成 DOM selection 不能替代真实选区证据。旧三色兼容须导入真实旧版导出的记录并验证定位、编辑和重导出。

A−/A+ 实际点击验证默认 18px、1px 步进、14–26px 上下限和边界状态。读取正文 EN/ZH 与右侧 Legend 的真实 computed font-size，三者数值相同；规范标题、两列元数据及控件不随字号变化。检查独立文章偏好、刷新和下载 HTML 的新环境恢复、无页面 zoom/transform、最大字号无横向溢出及目录定位。

搜索须实际输入中文和英文查询、切换上/下一个、验证逐处计数和清空。包含同块多次命中、科学格式/引用跨节点、隐藏语言、元数据和图注，确认每个当前匹配可见且手机控件不互相遮挡。CSS Highlight 临时紫色与永久笔记高亮区分；搜索前后及清空后比较规范 textContent、UTF-16 引文、annotationId、笔记内容和颜色，不能插入搜索 mark 或移动永久锚点。检查 CSS Highlight 缺失时的独立覆盖层回退；清空恢复临时显示状态，断网搜索可用且不向外部发送内容。

断网用 file:// 打开当前构建 HTML，检查全部原页和图、笔记、无必需网络请求及未处理异常。逐张视检图片与关键截图，截图前等待文字、字体、原图 decode 和布局稳定；空白截图记录视觉 fail，保留原证据，另行复测替换，不能用 DOM 断言代替目视。

`record-browser WORK evidence.json` 读取 `{"checks":[{"name":"检查名","status":"pass|fail|blocked","evidence":"实际日志、截图路径和说明"}]}`。检查名不能重复，证据必须属于当前内容和 renderer 指纹。缺必需检查保持 blocked；未执行不得占位 pass。

## v1.6.0 必需检查清单

`reader.py.REQUIRED_BROWSER` 当前要求以下 22 项。沿用五色浮条、独立导航与本地搜索、字号及手机触摸选区门槛；v1.6.0 新增两项文献引用门槛，既有来源、图像、元数据、布局和三项笔记门槛继续保留。历史检查名和旧 renderer 的通过记录不能替代本版要求。

|检查名|必须实际验证的行为|
|---|---|
|`clean-reading-ui-and-qa-boundary`|无可见 QA 状态/报告 UI；“阅读笔记”无动态数量；完整诊断及实际科学审校范围保持不变；未做的审校仍为 not-performed。|
|`continuous-offline-original-pdf`|完整原 PDF 离线查看与全部来源页连续阅读；原始字节一致；原生与连续页图回退分别取证。|
|`five-color-floating-highlights-and-portable-notes`|选区旁深绿浮条、五色即时高亮、添加笔记与边缘夹紧；五色编辑/刷新、旧三色导入、HTML 独立快照及新环境恢复；本地后续删改不被旧快照复活。|
|`legacy-v1-note-idmap-migration`|旧 schema v1 笔记经明确 UTF-16 idMap 迁移，跨页合并后的双语定位、编辑和重导出保全。|
|`hierarchical-bilingual-toc`|目录层级与折叠有效；三种正文语言模式下目录始终双语；来源 heading 和导航分组角色明确。|
|`metadata-two-column-source-preservation`|窄标签、宽值两列；canonical 双语题名在上方；作者与单位自然完整展开；无空字段或解释性小字，全部文字、格式、ID、来源、选择与笔记保留。|
|`all-figures-contain-complete-responsive`|每张图默认、切换及重置完整适应，不裁切或拉伸；框满右栏宽、按源图比例算高度并受可用上限约束，图注紧接；桌面、列宽变化、短窗口与手机均验证。|
|`contain-zoom-pan-reset`|普通图和 modal 以各自 contain fit 为基准；真实滚轮/平移、锚点、0.5–8 限制及适应重置；当前数字倍数不持久，忽略旧比例偏好，图外正常滚动。|
|`canonical-bilingual-source-integrity`|规范双语文字、ID、来源、科学格式、图像与 PDF 字节一致；技术一致性不冒充科学审校。|
|`canonical-headings-and-green-legends`|只省略与章节首个可见来源 heading 双语均相同的生成标题；规范 heading 和右侧浅绿图注唯一、保留格式与正文字体。|
|`navigation-and-mobile`|目录避开真实工具栏；手机目录和图栏真实开关、关闭及图注跳转可用。|
|`draggable-three-columns`|两分隔线实际拖动、键盘、极值、双击重置；取消后恢复文本选择；窄桌面、手机和视图切换不溢出。|
|`follow-pin-modal-and-export-names`|明确图号跟随、固定与恢复；放大窗口内外点击及阅读位置恢复；导出预览、重名处理与实际文件名一致。|
|`source-button-native-pdf-page-jumps`|真实点击正文来源按钮，首次非首页、跨页、回首页、重复跳转；以原生 PDF 查看器真实计数器及截图确认，不能仅看外层属性。|
|`reading-font-size-controls-and-persistence`|A−/A+ 默认18、每次1px、14–26边界；EN/ZH正文与Legend同字号、元数据和标题排除；文章偏好刷新/导出/新环境恢复，无整页缩放或溢出且目录定位正确。|
|`local-bilingual-search-and-note-anchors`|中英逐处搜索、计数、前后项、可见定位与清空；隐藏语言和图注显示；临时CSS Highlight及无该API回退不改文本和笔记锚点，纯本地执行。|
|`mobile-touch-selection-and-toolbar`|真实触摸选区与点按浮条，新建高亮和笔记保持原选区；视口边缘可用；搜索、字号及原工具入口不遮挡，注明模拟/物理设备范围。|
|`storage-failure`|读取拒绝、配额拒绝、损坏 JSON 与局部坏记录均有真实故障注入；内存笔记可下载，损坏原始存储不被覆盖。|
|`json-markdown-download-upload`|真实下载 JSON/Markdown、刷新和 fresh-context 上传；quote、笔记、颜色、定位与冲突信息保全，重复导入不增加记录。|
|`conflict-migration`|原记录与冲突副本保全；未知位置和外来来源保持 unresolved；非法导入不修改当前笔记。|
|`source-bound-bibliography-citation-targets`|从独立原 PDF 清单逐页核查所有候选、遗漏与排除依据；实际编号、唯一文献目标、全部 EN/ZH 引用及来源字形完全对应；不能从 paper 自复制期望值。|
|`bibliography-citation-keyboard-mobile-search-notes`|实际点击单条、组合、范围与上标引文，所有编号可达；键盘、焦点返回、工具栏避让和手机图注跳转可见；搜索、永久高亮和笔记锚点不受损。|

## 通用首次制作验收入口

新论文使用 [reader-generic-v160.cjs](../tests/reader-generic-v160.cjs) 和 [reference-links-browser.cjs](../tests/reference-links-browser.cjs)。所有预期页数、字形、图与文献来自实际原 PDF 的独立清单和明确语义审查，不硬编码测试论文的块数、页数、标题或图号。独立清单必须从实际 PDF 重新提取，不得以 paper 或其 coverage 字段自证。图与引用台账覆盖全部原页，候选须逐条批准或有据排除，未解决时阻塞完整验收。

```sh
node SKILL/tests/reader-generic-v160.cjs --fixture NEW.html --paper WORK/paper.json --source WORK/source.pdf --manifest WORK/source-manifest.json --inventory INDEPENDENT_INVENTORY.json --figure-ledger FIGURE_LEDGER.json --reference-audit REFERENCE_AUDIT.json --out EVIDENCE_DIR --chrome CHROME_EXECUTABLE --playwright PLAYWRIGHT_MODULE
node SKILL/tests/reference-links-browser.cjs --fixture NEW.html --paper WORK/paper.json --source WORK/source.pdf --manifest WORK/source-manifest.json --inventory INDEPENDENT_INVENTORY.json --figure-ledger FIGURE_LEDGER.json --reference-audit REFERENCE_AUDIT.json --reference-candidates SOURCE_CANDIDATES.json --reference-ledger REFERENCE_LEDGER.json --out CITATION_EVIDENCE_DIR --chrome CHROME_EXECUTABLE --playwright PLAYWRIGHT_MODULE
```

`--preflight-only true` 只做来源与输入核验，不能当作浏览器通过。`--only` 限定本次实际检查，其他门槛不补 pass。真实 Chrome 使用全新离线上下文，不连接用户已有标签页。PDF 原生页码、触摸输入、鼠标选区、下载与重新打开均以真实操作取证。确认原生页码 total 已加载再判定，不能把等待事件本身当成功。

某篇新论文若没有旧版 `idMap` 或元数据，不伪造该文内容来过门槛；相关通用行为另用有来源的自制样本或旧版真实迁移样本验收，绑定当次 renderer、输入及证据，明确为独立回归证据。`--legacy-evidence` 用于已有实际执行的单独迁移报告，不能仅因文献没有相应结构而记通过。所有 22 项的最终汇总区分本篇来源验收与通用兼容性回归，未测仍为 blocked。

自制引用开发样本由 [make_reference_sample.py](../tests/make_reference_sample.py) 生成，含真实自写 PDF 与独立提取字形。`--development-fixture true` 明确标记其用途，不能计入真实论文冷启动质量或速度证据。机器纯数据测试、真实开发样本浏览器、实际论文全文审校三类证据分别报告。

## 当前回归入口

`python3 -m unittest discover -s SKILL/tests -v` 执行提取、扫描阻塞、来源覆盖、身份、显式段落重组及范围状态等逻辑检查。`node --test SKILL/tests/*.unit.cjs SKILL/tests/test_export_names.cjs SKILL/tests/test_article_search.cjs` 执行模块与打包检查。这些入口只使用包内自制或合成样本，不需要历史真实论文或私人笔记。二者均不是真实浏览器证据。[status-packaging.unit.cjs](../tests/status-packaging.unit.cjs) 使用真实打包器、模板与全部实际脚本，核对本版 UI/诊断边界、完整 PDF 接线、JSON 安全序列化与脚本语法；旧 [reader-status.unit.cjs](../tests/reader-status.unit.cjs) 仅保留兼容性测试，不表示该模块仍在阅读器中加载。

旧真实论文定向入口 [reader-v150.cjs](../tests/reader-v150.cjs) 声明 17 项历史阅读检查；与下述三项笔记检查合计最多对应 20 项，不覆盖 v1.6.0 新增的两项文献引用门槛。原页跳转另有 [pdf-native-navigation.cjs](../tests/pdf-native-navigation.cjs) 从真实原生计数器取证，但该补充脚本也固定依赖同一份 42 页旧测试论文及指定规范块，不能用于任意新论文。所需历史 HTML、论文 PDF 和旧版导出笔记不随源码发布包提供。主入口未覆盖的来源页场景须由补充入口实际完成，并将同一候选的对应证据合并到 `source-button-native-pdf-page-jumps`；不能仅因入口列有检查名便记为已执行：

```sh
node SKILL/tests/reader-v150.cjs --fixture NEW.html --paper WORK/paper.json --baseline OLD.html --legacy-three OLD_THREE_COLOR_NOTES.json --out EVIDENCE_DIR --chrome CHROME_EXECUTABLE --playwright PLAYWRIGHT_MODULE
```

`--only check-name` 可单独复测，也接受逗号分隔的多个名称；单项结果不代表其余项执行。五色门槛需要 `--legacy-three` 指向实际旧版导出的三色笔记 JSON，不能临时伪造旧版通过证据；需要更早版本迁移证据时沿用 `--legacy`。该脚本含真实测试论文的页数、字形、规范块及图号基线，不能对另一篇论文直接宣称通用验收。其他文献必须用其实际来源和对应明确内容建立检查，不得删除完整性要求或伪造预期值。

补充入口 [notes-v130.cjs](../tests/notes-v130.cjs) 执行三项笔记检查 `storage-failure`、`json-markdown-download-upload`、`conflict-migration`：

```sh
node SKILL/tests/notes-v130.cjs --html NEW.html --out NOTES_EVIDENCE_DIR --chrome CHROME_EXECUTABLE --playwright PLAYWRIGHT_MODULE
```

这些入口使用全新隔离的离线 Chrome 上下文，不读取用户浏览器配置。故障注入和自制笔记只作用于测试上下文及当前资料的存储键。报告须绑定同一候选 HTML SHA 和当前内容/renderer 指纹；实际执行并逐张视检截图后，才可合并为完整浏览器证据。文档列出入口不代表已执行或通过。原生 PDF 无法验证时不能用栅格回退结果补成 native pass。

包内 `make_samples.py`、`make_layout_sample.py`、[make_generic_v120_sample.py](../tests/make_generic_v120_sample.py)、[make_generic_v130_sample.py](../tests/make_generic_v130_sample.py)、[make_generic_v140_sample.py](../tests/make_generic_v140_sample.py) 与 `migration_fixtures.py` 产生自制资料或故意修改的迁移样例。它们不是科研结果或真实论文审校。[generic-v140.cjs](../tests/generic-v140.cjs) 保留元数据、完整适应等自制资料场景；当前五色浮条、字号、搜索与文献引用仍须由当前入口实际取证。`generic-v120.cjs`、`generic-v130.cjs`、`reader-v120.cjs`、`reader-v130.cjs`、`reader-v140.cjs`、`browser.cjs`、`interactions.cjs`、`layout.cjs` 及 legacy 入口保留历史场景，运行前须核对当前 DOM、笔记快照与 contain-fit 语义；旧状态 UI、固定竖框、源像素默认、持久初始比例或旧笔记计数断言不可直接作为当前 v1.6.0 通过证据。文件名纯逻辑/打包回归可单独运行 `node SKILL/tests/test_export_names.cjs`。

缺真实浏览器或独立试用能力时如实记录 blocked。兼容性只声称实际验证的平台；不承诺自动处理任意扫描、损坏字体或复杂公式。交付报告必须同时给出技术结果、视觉证据、科学审校范围与剩余限制。
