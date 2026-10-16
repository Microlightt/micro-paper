# 原始 PDF 提取与译前结构门禁

`scripts/source_pipeline.py` 从实际 PDF 独立建立来源证据，再接受 Agent 逐页、逐边界作出的结构决定。它不自动判定自然段、图题归属或翻译质量。先读本页，再按主流程进行翻译、全文审查和浏览器验收。

## 顺序与可并行范围

1. `extract`：从新 PDF 生成独立库存、原页 PNG、候选行和原始 manifest。此时正文尚未成为经过审查的自然段，ZH 为空。
2. Agent 查看全部原页，确定页内栏序、标题、正文类型、自然段边界、跨页与跨图续接。图及图注任务可分别审查并写入各自 JSON；所有任务读取同一 `paperSha256` 快照。
3. 单一写入者执行一次 `batch-crop` 合并已审查的图任务；同一页、同一 scale 在本次调用内只栅格化一次。它保留全部裁图像素，不缩小分辨率、不重绘图。
4. `structure-packets` 输出完整审查包和默认 blocked 的答复模板。Agent 填写所有页面、图形区域、相邻块及块内部跨页/跨栏边界，并给出完整顺序、分组及章节。
5. `accept-structure` 重新从实际 PDF 提取字形审计，校验显式决定、完整来源覆盖和图注来源后，一次提交规范段落与 `structure-approval.json`。只有通过后才能进入翻译任务准备。
6. 翻译及其审查、引用/格式审查、最终全文审查和浏览器门禁仍按主流程执行。结构批准不代表科学内容或翻译审校已完成。

独立逐页提取/栅格化使用 1–8 个有界进程（默认 2）。每个进程打开原文件并按真实 PDF 页号读取，归并结果固定按原页顺序。图/图注审查可以并行，但它们只产出任务文件；规范 `paper.json` 只有一个合并写入者。结构批准依赖所有页面和边界完成，不能提前让翻译使用尚未冻结的段落。

## 命令

在 skill 根目录运行，Python 需 3.10+，使用已验证的环境和原有 pdfplumber、pypdfium2、Pillow 依赖；不自动安装依赖。

```sh
python3 scripts/source_pipeline.py extract /path/to/new-source.pdf --out /path/to/work --workers 2 --scale 2
python3 scripts/source_pipeline.py audit /path/to/work --workers 2
python3 scripts/source_pipeline.py batch-crop /path/to/work /path/to/figure-task-a.json /path/to/figure-task-b.json
python3 scripts/source_pipeline.py structure-packets /path/to/work --order /path/to/reviewed-order.json
python3 scripts/source_pipeline.py accept-structure /path/to/work /path/to/structure-response.json --workers 2
```

`--order` 可省略，此时使用当前规范块顺序；提供时内容为包含每个 blockId 恰好一次的 JSON 数组。顺序仍须逐页审查，省略参数不等于批准当前顺序。`structure-packets` 返回 `packet`、`packetSha256`、`responseTemplate` 路径。复制模板到新的答复文件填写，不修改只读模板。

如只需从实际 PDF 新建独立来源库存：

```sh
python3 scripts/source_pipeline.py inventory /path/to/source.pdf --out /path/to/work/source-inventory --workers 2 --raster-scale 2
```

`inventory` 不读 `paper.json`；`--out` 必须不存在。`--raster-scale` 可省略而只生成原生字形/对象证据。`extract` 固定生成页面栅格，scale 不低于 2；裁图 scale 默认 4，不低于 2。新提取拒绝覆盖已有 `paper.json` 或不同的 `source.pdf`。`audit` 的 fail/blocked 与命令错误返回非零退出码；`needs-source-review` 等是已生成候选材料的状态，不是质量通过。

## 独立库存与审计

`source-inventory/inventory.json` 的 schemaVersion 为 1，包含 `sourceSha256`、`independentOfPaper:true`、`provenance:{input:"source.pdf",tool:"pdfplumber",version,method}`、`pageCount`、`pages`。

每页包括：

- `pageId`、原始 `number`、`width`、`height`、`rotation`；`glyphCount` 和完整 `glyphs:[{text,font,size,bbox}]`。
- `nativeOrder` 为 PDF 原生字形下标；`spatialOrder` 为按 top/x 排序的辅助证据。它们都不是自动批准的阅读顺序。
- `glyphSha256` 为 `[[text,font,size,bbox],...]` 紧凑 UTF-8 JSON 的 SHA-256。字形下标、字号和 bbox 的三位小数精度与既有提取语义一致。
- `images` 为原嵌入图片元数据，含可取得的原始编码流哈希与大小；`drawings` 为 line/rect/curve 元数据。每个对象都有稳定 `regionId`；不将对象自动等同于论文 Figure。
- `inventoryFile`、`inventoryFileSha256` 指向只读的逐页 JSON。可选 `raster` 记录路径、scale、像素尺寸与 SHA-256。

库存 JSON 和 PNG 以只读权限发布，拒绝覆盖；权限不是防篡改机制，审计仍检查哈希。`audit` 每次重新遍历实际 `source.pdf`，验证 PDF SHA、全部页号/顺序/几何、原生字形和图片/绘图对象与库存一致，同时核对 `source-manifest.json` 的 documentId、sourceSha256、逐页 glyphs，核对原页 PNG。所有规范 `sourceSpans` 必须覆盖每个源字形恰好一次，bbox 必须等于该范围字形的 union（0.01 point 容差）。普通 EN 与所指字形按顺序拼接后去空白相等；文字修复须有精确 `sourceEdits.before/after` 和来源证据。排除的页眉页脚/图中文字仍保留来源，并必须写 `exclusionReason`。

没有原生字符的页面，或使用人工视觉转录的混合页，必须先有下述独立转录账本及完整页图核查。缺少证据时保持 blocked/fail；空字形数组本身不能证明完整。没有自动 OCR 或自动扫描页批准通道，不要用空记录、改状态或重复来源绕过。

## 扫描页与局部视觉转录

先查看实际 PDF 生成的独立原页图，逐区域记录英文，再将已审查的记录映射到规范文本。不可先从 `paper.json` 反推转录账本。固定路径为 `WORK/source-transcription-ledger.json`，schemaVersion 为 1：

```text
sourceSha256: 实际 PDF 哈希
inventorySha256: source-inventory/inventory.json 的原始文件字节哈希
independentOfPaper: true
provenance: {input: "source.pdf", method: "manual-page-raster-review"}
pages: [{
  pageId, rasterSha256,
  regions: [{regionId, bbox, en, enHash, sourceEvidence,
             nativeGlyphRanges: [{glyphStart, glyphEnd}]}],
  review: {status: "reviewed", reviewer, evidence,
           coverageBbox: [0, 0, 原页宽, 原页高],
           regionIds: [按记录顺序列出本页全部转录区域],
           nativeGlyphRanges: [覆盖本页全部原生字形的范围]}
}]
```

每个 region 的 bbox 使用 PDF point，en/enHash 是对原页图核对过的精确英文及其 SHA-256，sourceEvidence 具体描述核查的位置和内容。page.review 必须有实际审查者、完整页 bbox、全部区域 ID 及完整页图检查的具体证据；不能只写 pass/true。机器验证账本完整、身份和映射一致，整页是否遗漏可见内容仍由审查者对原页负责。

region.nativeGlyphRanges 只列处于该视觉区域的真实原生字形；review.nativeGlyphRanges 则列全页真实原生字形，每个恰好一次。无原生字形时用空数组，不能制造 glyph。所有原生字形及其 bbox 仍保留在 inventory/manifest，并由规范 native sourceSpans 覆盖一次。混合页面中属于视觉 region 的 native 字形必须保留在该 region 对应的同一规范块，且 bbox 在 region 内；它们用于来源覆盖，不再重复拼进已经包含这些可见文字的视觉转录 EN。

局部转录允许 `regions` 只含需要视觉补正的日期、覆层等区域；其余正文继续使用 native 字形审计，无需抄写整页。整页 review 仍须确认全部可见内容已检查，明确列全页 native 字形。规范 span 的源顺序须与文本对应。

规范转录 span 为 `{pageId,bbox,transcription:true,sourceEvidence,regionId,textStart,textEnd}`，不带 glyphStart/glyphEnd。textStart/textEnd 为规范块内精确英文的 UTF-16 范围，每个独立 region 只能映射一次，不能与其他视觉范围重叠。bbox 和 sourceEvidence 与独立 region 完全相同，映射文本与 region.en 完全相同。兼容旧 `{pageId,bbox,transcription:true,sourceEvidence}`：只有页号+bbox 唯一定位一个 region，且其全文在规范块内只出现一次时，才解析缺失映射；歧义必须由审查者明确填写，不能猜测。

`audit` 还从实际 PDF 重新渲染涉及的页面，比较独立 raster 的 scale、尺寸和 SHA-256，防止只修改库存中的图片和哈希。它分别验证 native 全覆盖与视觉映射，然后核对完整块 EN；未被两类证据证明的附加英文不能通过，不能用仅存在于 canonical 的 sourceEdits 为它开例外。视觉文字修正须先重新核查独立 region/en/hash，再重新结构审查。

`accept-structure` 将旧式转录 span 规范化，跨块合并时移动 textStart/textEnd，保留原 regionId、bbox 及证据；内部跨页/跨栏边界仍须明确审查。sourceEdits 组合能处理转录 span，不会访问虚构的 glyph 索引，也不能扩大已证明的视觉文本。当前批量裁图和图注门禁明确拒绝转录图注，需要另行完成受审查的图注映射流程；普通 reporting/正文扫描页不受此限制。

账本文件字节 SHA-256 同时写入 `paper.sourceTranscriptionLedgerSha256` 和 structure-approval 的同名字段，并纳入结构指纹、最终审查身份及提交前漂移检查。翻译准备和最终验证必须核对现有账本身份，删除或篡改后不能沿用旧批准。账本本身不含规范 block ID 或从 canonical 拷贝出来的文本证明。

## 图任务输入和图注来源

各图任务 JSON 的顶层为 `sourceSha256`、当前文件字节的 `paperSha256`、非空 `figures` 数组。每图示例字段：

```json
{
  "figureId": "main:1",
  "sourcePageNumber": 3,
  "crop": [20, 35, 580, 610],
  "scale": 4,
  "reviewed": true,
  "sourceEvidence": "原页 3，明确列出已检查的图边缘、面板和图号",
  "captionBlockIds": ["p3-g150"],
  "captionEvidence": [
    {
      "blockId": "p3-g150",
      "enHash": "该候选图注完整 EN 的 SHA-256",
      "sourceSpans": [],
      "sourceEvidence": "填写原页及实际图注来源范围的审查依据"
    }
  ]
}
```

示例中的空 sourceSpans 和说明字符串不能直接执行，必须填入该候选图注的完整真实范围和哈希。crop 使用 PDF point `[x0,top,x1,bottom]`；scope 可为 main、extended、supplement。captionEvidence 必须逐一覆盖 captionBlockIds，精确匹配当前 EN 哈希和来源范围。遇到重复图号、已有资产、过时任务、越界裁图或已知标题/内容类型冲突即停止。

输出 `source-figure-ledger.json` 独立记录来源 PDF/库存哈希、审查过的 crop、sourcePageNumber、scale、pixelBox、assetSha256、原图注 evidence 和 glyphRanges、任务输入文件哈希。裁图 pixelBox 用左/上 floor、右/下 ceil，PNG 无损保存，不 resize。

每份 captionEvidence 保留原始 `blockId`、`enHash`、`sourceSpans`、`sourceEvidence`，另有 `canonicalBlockId`。`captionGlyphRanges` 为 evidence 中 spans 的平铺，记录原 blockId 与 canonicalBlockId。`captionBlockMappings:[{originalBlockId,canonicalBlockId,start,end}]` 将原图注定位到现规范 EN，偏移为 UTF-16。起初 start=0/end=原文长度；结构合并后仅根据实际偏移更新 canonical 定位，原证据不改。原 EN 哈希必须等于现 EN 对应 slice 的哈希；同一图最终 caption 的全部 sourceSpans 必须被原证据按序覆盖一次。不同 Figure 的图注不能合并成同一段。

批量裁图后 `figureLedgerComplete:false`。只有全部页面的图形区域都被明确归类、所有登记 Figure 都得到其原页的 graphic review 覆盖并通过结构门禁，才标记 true。不要手改此标志代替审核。

## 结构答复

保留模板里的 packet/source/paper 哈希及边界身份，填写：

- `pages`：所有原页恰好一次；`status:"pass"`、具体 `evidence`、精确的 `orderedBlockIds`。`graphics` 把该页所有 `graphicRegionIds` 完整且不重复地分组；每组 `decision` 为 figure/table/equation/decoration/source-only，并写 evidence。figure 组还须 `figureIds`，每个图须来自该页且在 ledger 登记。
- `boundaries`：每个相邻块都要 `decision`（same/different/heading/figure-interruption）和 evidence。保留 `leftBlockId`、`rightBlockId`、`requiredAspects`；figure-interruption 必须注明 `continuation:"same"` 或 `"different"`。跨页或跳过图页不能省略。
- `internalBoundaries`：已有块内部的跨页/跨栏来源转换也须审查。此版只接受 same，或 figure-interruption 且 continuation=same；若判断需要拆分，先由单一写入者按真实来源拆块、维护 idMap，再重建审查包。
- `groups`：按审查顺序覆盖全部块一次。每组 `blockIds`、`kind`、`evidence`，可选 `joiner`（默认一个空格，最长两个空白字符，可为空）；排除类型须 exclusionReason。已知 heading/caption 等类型屏障不能跨越，原 heading 不能与别块合并。输出沿用组首 blockId。
- `sections`：显式 sectionId、titleEn、titleZh、合并后 blockIds，完整保持规范段落顺序；顶层 `evidence` 为非空说明数组。

代码核验决定是否完整、是否互相矛盾，不代替 Agent 判断科学阅读顺序。跨栏是几何提示而非语义判定；每个相邻块均要人工决定，避免漏掉同栏特殊边界。若候选行内部混合了不同内容类型，应先按原字形拆开再生成新包。

`accept-structure` 在译前保留 EN、sourceSpans、格式及引用偏移，并为合并建立精确 idMap。已有且通过实际 PDF 审计的 sourceEdits 会组合成新段落的完整 before/after，原条目完整保存在 `originalSourceEdits`，不推测新修复。任何非空 ZH 会阻止此门禁，已发布双语文档使用既有审查迁移流程。

批准文件为 `WORK/structure-approval.json`，包括 `status:"approved"`、sourceSha256、`pipeline_common.structure_fingerprint`、packetSha256、审查计数及真实来源审计结果；有独立转录账本时还绑定 sourceTranscriptionLedgerSha256。后续翻译准备须再次校验其指纹和账本文件哈希。改 EN、分组、来源、图/图注映射等会使批准失效；仅有 approved 字样不够。新裁图必须在批准前完成，或之后重新结构审查。

## 并发、失败和恢复边界

所有写入口使用统一 `WORK/.micro-paper-write.lock`，owner.json 记录 PID、hostname、token、operation、createdAt；同线程嵌套可重入。不能手动忽略活跃锁。已有 `.translation-transaction` 或 `.source-transaction` 阻止新的普通写入及打包。

结构接受和批量裁图在 `source-transactions/source-*/` 保存 before/after/journal，并在首个规范写入前写 `.source-transaction`。提交前复查 paper、PDF、manifest、inventory、figure ledger 和 transcription ledger 的文件哈希（包括原本不存在的 ledger）；每个目标采用临时文件+fsync+replace。正常失败只撤回仍与本次写入内容相同的文件，保留其他写入者的改动。全部提交或回退核验完成才移除 marker。

此版没有自动 source 崩溃恢复命令。SIGKILL、未知锁所有者或回退冲突会留下 marker/journal 并保持 blocked。恢复必须先确认原写入进程已退出，保存全部现场，对比 journal 记录的 before/after 哈希及每个现文件，明确选择完整提交或完整回退；任一文件既非 before 也非 after 时保留冲突并继续阻断。只有由维护者完成文件级核验、实际 source audit 与结构/翻译状态重校验，才可清除 marker 和死亡锁。不能只删锁/marker后继续，也不能声称已实现自动崩溃恢复。

提取失败保留库存 staging 以便诊断，不发布部分库存；新工作目录未完成时没有结构批准，不能进入翻译。首次真实论文的总耗时、审查耗时及速度收益必须从冷运行记录取得，合成测试和 worker 数不能代替性能证据。

## 测试

`tests/test_source_pipeline.py` 只生成自编的 reportlab PDF，覆盖原生两栏/多页、字形和页面栅格语义与旧提取一致、并行归并确定性、fresh-PDF 审计篡改拒绝、无证据无字符页阻断、真实 image-only 和带少量 α/碎片 native 字形的混合栅格页、旧式转录 span 到跨页合并及 translation.prepare 的完整路径、账本及附加 EN 篡改拒绝、最终 reader.validate 的账本身份检查、所有来源范围覆盖、sourceEdits/idMap 保真、图注映射和单页一次裁图、过时任务/并发 hash guard、正常失败回退，以及 source/translation pending 对写入及打包的阻断。

```sh
python3 -B -m unittest discover -s tests -p test_source_pipeline.py -v
```

测试需要 reportlab；运行环境已有时使用，不自动增装。Node 打包阻断测试使用 PATH 的 node，或通过 `MICRO_PAPER_TEST_NODE` 指定已验证的 Node 路径。没有真实 PDF/浏览器执行记录时，不报告实际论文、扫描页、科学全文或浏览器门禁已通过。
