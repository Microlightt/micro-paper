# 翻译批次

prepare-translation 为每个待译块生成 blockId、enHash、en、section、相邻上下文、相关图注、格式证据、术语表；一个完整 block 不拆成任意字数片段。每批有 batchId。术语表在 work/glossary.json 中维护，审校时核对一致性。

Agent 创建 response.json：

```json
{"batchId":"返回批次中的 ID","translations":[{"blockId":"原 ID","enHash":"原哈希","zh":"完整忠实中文","formatting":[],"issues":[],"invariantDecisions":{}}]}
```

formatting 为 start/end/kind/sourceEvidence（UTF-16），只标译文内可核对的对应范围。数字、拉丁符号、单位、图号与引用号差异默认报错；检查器列出 token，确有翻译原因时在 invariantDecisions 中以 token 为键写具体理由，不能批量忽略。有 issues 的段落保留 needs-review。

逐段审校否定、比较、实验条件、计量、结论、统计关系和所有原文内容，不能删减参考文献或 Methods。Abstract 按原文翻译，但不新增总结、解读或研究评价。中文标题属于原文翻译。审校结果绑定最终字符哈希；脚本结构检查不等同于准确性审校。
