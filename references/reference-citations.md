# 参考文献引用与来源审计（v1.6.0）

参考文献引用只增加定位注解，不改 `blocks[].en/zh`，不剥除编号，不凭渲染结果重写正文。发现数字候选、确认来源引用、建立阅读器链接是三个不同步骤。年份、幂次、P 值、图表号、单位或作者单位编号即使外观相似，也不能因正则匹配或上标几何自动成为文献链接。

实现入口为 `scripts/reference_citations.py`，仅使用 Python 标准库。既有文章未提供这三个字段时保持兼容；不能据此声称已完成文献引用审计。

## 规范数据

`paper.referenceTargets` 每项包含：

```json
{
  "number": 7,
  "blockId": "reference-entry-id",
  "sourceEvidence": {
    "sourceSha256": "原始 PDF 的 SHA256",
    "role": "bibliography-prefix",
    "verification": "glyph-map",
    "glyphRanges": [{"pageId":"p9","glyphStart":20,"glyphEnd":23}],
    "exactText": "7. "
  }
}
```

编号必须为正整数，来自该条参考文献在原始 PDF 中的实际编号前缀；不能用数组次序补造。`blockId` 必须唯一存在且 `kind=reference`。编号和目标块各自唯一；重复时全部保留为未确认问题，不能任取第一条。证据必须标记目标块自有字形中真正的开头编号。规范前缀若与原编号矛盾则失败；规范文本不含编号时，必须使用 `reviewed-source` 并说明已核实的原页前缀。相关文本修改仍由原有 `sourceEdits` 契约管理。

`paper.referenceCitations` 每项包含：

```json
{
  "id": "refcite-由模块生成",
  "blockId": "body-block-id",
  "language": "en",
  "start": 37,
  "end": 42,
  "exactText": "1–4,7",
  "numbers": [1,2,3,4,7],
  "style": "superscript",
  "sourceEvidence": {
    "sourceSha256": "原始 PDF 的 SHA256",
    "role": "inline-citation",
    "verification": "glyph-map",
    "glyphRanges": [{"pageId":"p1","glyphStart":50,"glyphEnd":55}],
    "exactText": "1–4,7",
    "classification": "bibliographic-citation",
    "reviewNote": "记录实际对照原页上下文确认该处为文献引用的依据。"
  }
}
```

示例中的位置仅解释字段，不是可直接复用的论文证据。`id` 可省略；若填写，必须等于 `citation_id(blockId, language, start, end)`。坐标是 JavaScript UTF-16 半开区间，须与规范文本逐字符相同，不能切断代理对。`numbers` 是精确可展开标签按原文出现顺序去重后的编号；`5,3` 保留 `[5,3]`，`1–4,7` 为 `[1,2,3,4,7]`，不排序，不修补降序范围。每个编号都必须已有合格目标。

允许来源已确认的 `body`、`methods`、`caption` 块；标题、参考文献条目自身、公式、表格、图内标签、页眉页脚以及 `articleInfo` 映射的元数据块不作为正文引用。任何两个文献引用范围不得重叠，也不能与 `inlineReferences` 图表链接范围重叠。同一个英文来源字形位置不能批准多处规范英文引用。`style` 可省略；若提供，取 `superscript`、`bracket` 或 `parenthetical`，不改变字符。

## 来源证据

`glyphRanges` 使用 `source-manifest.json` 原始字形数组的零起点半开下标。允许多个不连续范围，但顺序必须是该标签的真实阅读顺序，不能重复字形；也兼容证据对象上的单段 `pageId/glyphStart/glyphEnd`。`exactText` 必须逐字等于这些字形的连接，所有字形都须属于该规范块的 `sourceSpans`。论文和 manifest 的 `sourceSha256/documentId` 必须一致。

`glyph-map` 将整块英文和按 `sourceSpans` 次序读取的字形一一比对，只忽略空白差异。自动映射不猜测去连字符、连字替换、读取次序或原文修复。数字相同但来自另一处的字形证据会失败。

如果已有来源修复使整块自动映射不可用，可经真实原页检查使用 `reviewed-source`。除字形、分类和具体 `reviewNote` 外，英文引用证据必须填写当前完整规范英文的 `canonicalTextHash`（UTF-8 SHA256）及 `canonicalStart/canonicalEnd`。这将人工/Agent 的实际对位决定绑定到精确文本和位置；它不会自动证明该检查已经发生，不能由脚本填造确认。

上标尺寸较小、基线抬高，只用于发现候选，不能独立证明其为引用。方括号、多编号、范围和圆括号同样必须对照原页上下文确认。不能将“字体看起来像上标”或“编号存在”当作语义审查证据。

## 中文配对

中文记录保持本地真实的 `start/end/exactText/numbers`，并增加 `sourceEnCitationId`。来源英文必须已通过上述核验，位于相同规范块，而且编号顺序完全相同。一次英文来源位置最多对应一次中文引用位置。中文不能凭数字在段内搜索后任意配对，也不能靠重新生成/剥除渲染文字推算范围。

中文证据为：

```json
{
  "sourceSha256":"原始 PDF 的 SHA256",
  "role":"translation-citation",
  "verification":"paired-source",
  "reviewNote":"记录该实际中文位置与已核实英文来源位置的对应检查。"
}
```

可在证据内再次记录 `sourceEnCitationId`；若有，必须与外层相同。中文没有独立 PDF 字形，不能伪造一套中文 glyph provenance。缺少中文对应或确切英文证据时，保留原文和待确认项；不补写引用。

## 使用 API

```python
from reference_citations import (
    build_reference_targets, discover_candidates, citation_id,
    build_reference_citations, audit_reference_citations,
)

targets = build_reference_targets(paper, manifest)
paper["referenceTargets"] = targets["targets"]
# targets["unresolved"] 另行记录并查原页；不能静默丢弃。
candidates = discover_candidates(paper, manifest)
# 全部 candidates 均 status=unresolved；不是可直接交给 UI 的链接。

# 只有实际检查过来源后才填写 reviewed_spans。
reviewed_spans = [{
    "blockId": bid, "language": "en", "start": start, "end": end,
    "style": "superscript", "reviewNote": actual_source_review_note,
}]
result = build_reference_citations(paper, manifest, reviewed_spans)
# 有任一来源审计错误，result['citations'] 为空；未批准建议在
# proposedCitations 中保留供修复，不能直接用于 UI。
paper["referenceCitations"] = result["citations"]
report = audit_reference_citations(paper, manifest)
```

中文 decision 为 `{blockId,language:'zh',start,end,sourceEnCitationId,reviewNote}`。英文 decision 可直接提供已完整核验的 `sourceEvidence`，用于 `reviewed-source` 等情况。所有 API 都不改传入对象。

`audit_reference_citations` 返回 `{status,errors,warnings,counts}`，`counts` 含 `targets/enCitations/zhCitations/unresolvedCandidates`。错误使 `status=fail`；没有错误但有未确认候选为 `partial`；无错误或未确认项为本模块范围内 `pass`。`validate_reference_citations` 仅返回错误列表，供主验证器集成。未确认候选不会阻止其他已核实引用保持有效，也不会被当作已链接记录。

`paper.referenceCitationCandidates` 保留未确认项目，`status='unresolved'` 和具体原因。数字语法本身不能说明科学含义；显然为年份、单位、数学或图表引用的候选应通过来源台账记为排除，而非进入已批准数组。

## 独立的全量核对

```sh
python3 scripts/reference_citations.py inventory --manifest WORK/source-manifest.json --out WORK/source-reference-candidates.json
python3 scripts/reference_citations.py discover WORK/paper.json --manifest WORK/source-manifest.json --out WORK/canonical-reference-candidates.json
python3 scripts/reference_citations.py audit WORK/paper.json --manifest WORK/source-manifest.json --out WORK/reference-audit.json
```

`source_candidate_inventory(manifest)` 只读原始 PDF 字形，不读 `paper.json`。输出逐页 `glyphCount/glyphFingerprint` 和 `candidates`；每项含稳定的 `sourceCandidateId`、`pageId`、`role`、`style`、`glyphRanges`、`exactText`、`numbers`、`bbox` 与未确认状态。它从字形和排版发现编号前缀、上标、方括号、圆括号候选，能发现只检查 paper 已有记录时可能漏掉的位置。`glyphFingerprint` 是完整该页 glyphs 按 JSON sort_keys/UTF-8/紧凑分隔符序列化后的 SHA256。

这份语法/几何清单并不自动保证所有期刊排版都被识别。独立验收需要从原始 PDF 或独立提取的 manifest 建立逐页台账：每个候选明确记为已批准、非文献引用而排除、或仍待确认，并把人工补发现的位置加入台账。图页、扫描页、公式和不存在候选的页面也需明确记录检查范围。然后比较全部目标、全部原文引用及中文对应，检查遗漏、错误加入、编号和字形范围。不得用 `paper.referenceCitations` 复制出来的期望值证明自身完整。

组合标签的 UI 必须保留规范文字，提供每个真实编号的键盘可达目标；不得将范围只链接到首项。搜索、笔记锚点和引用 wrapper 必须保持 `textContent` 等于 canonical 字符串。浏览器验证属于单独验收；本模块测试通过不等于全文科学审校或所有引用完整通过。

合成测试：`python3 -m unittest discover -s tests -p test_reference_citations.py -v`。
