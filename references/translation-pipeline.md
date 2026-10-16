# 新论文的不可变翻译任务

`scripts/translation_pipeline.py` 使用本 Skill 同目录的 `reader.py` 校验工具及 `pipeline_common.py` 来源结构指纹。需要 Python 3.10+，不增加第三方依赖。脚本只生成本地任务清单、验证响应和合并文件；它不启动模型、不调用翻译 API，也不声称能选择或证明模型配置。实际翻译由宿主中的原生 Agent 执行，遵守用户已选择的模型与推理参数。

## 开始条件与队列

先完成来源分类、图与图注归属、自然段和跨页边界核查，由来源流程生成 `WORK/structure-approval.json`。文件必须是 `status="approved"`，包含当前 `sourceSha256`、`pipeline_common.structure_fingerprint(paper)` 和非空 `evidence` 数组。翻译准备会核对 PDF 原字节、paper/manifest 来源身份及相同 documentId、规范块 ID/顺序及英文哈希。没有批准结构时停止；不得把未核查的物理行直接作为完整自然段批量翻译，也不得为了提速补造批准证据。

```sh
python3 SKILL/scripts/translation_pipeline.py prepare WORK --max-bytes 24000
```

`SKILL`、`WORK` 是需要替换的实际目录。也可显式使用 `--approval FILE`。默认只分配 `pending`，返回值同时列出 `pending/translated/needs-review/reviewed` 的 blockId 队列。已有中文不会被静默重译：为 `translated` 或 `needs-review` 生成修订任务必须同时给出对应 `--queue` 和 `--retranslate`；`reviewed` 不进入翻译任务。修订后的译文仍需真实审校，不能继承旧通过状态。

不一致状态会停止准备与接收：正文等需译块不能标 `original-only`；`translated/needs-review/reviewed` 必须有非空白中文；中文哈希须与规范文本一致。不能用错误状态跳过尚未完成的工作。

## 完整载荷预算与上下文

`--max-bytes` 约束实际批次 JSON 文件的 UTF-8 字节数，包括任务指令、来源/结构标识、术语表、英文、来源定位、格式证据、上下文和 JSON 封装。它不是 token 数，也不是单独的英文字符数，不包含未来的响应输出。一个规范 block 永不切分；若单个完整 block 加必需上下文已超过预算，准备停止并给出所需字节数。应提高该任务预算，不能任意截句、删图注或改变自然段来绕过。

每批 `payload.targets` 只列待译目标。`payload.textPool` 在批级保存去重的完整英文文本，包含目标、相邻上下文及明确引用关联图注；目标通过 blockId 指向池内文本，同一图注不会因多次引用而重复嵌入。章节、格式和图注关联预先索引，不在每个目标内嵌套扫描全文、全部图片和全部引用。术语表每批只有一份；开始分发后不得原地改术语、上下文或已批准结构。

`textPool.sourceLocations` 只提供每个来源页的定位范围，不宣称该范围内每个字形均属于该块。完整 `sourceSpans` 仍留在规范 paper/manifest，并由结构指纹绑定；不将逐字形来源数组反复塞入翻译任务。需要查看原页或精确来源时，依据 blockId 查该论文的规范来源，不重用其他论文或旧任务缓存。

原有不变量检查保留其实际边界：数字、部分混合字母数字标识、希腊字母及列举单位的 token 计数不等于完整科学语义检查。否定、比较、条件、统计关系、术语含义及未覆盖单位仍须按翻译契约逐段审校。

## 不可变任务与独立响应

准备结果保存在 `WORK/translation-jobs/JOB_ID/`：

- `manifest.json` 绑定来源、结构、批准文件、术语、队列与各批次。`jobId` 是不含自身字段的完整清单哈希。
- `batch-BATCH_ID.json` 包含 `payload`，其 SHA-256 同时作为 `batchId` 和 `payloadHash`，覆盖指令、术语、上下文、格式、目标及目标当前中文状态。文件不可修改；同名但内容不同会被拒绝。
- 每个目标含 `baseTranslationHash`。翻译期间其他编者改变其中文、状态、疑点或中文格式后，旧任务不能覆盖这些改动。

准备返回 `tasks`，每项有批次路径、独立响应文件名和 `responseEnvelope`。宿主可并行将不同批次交给原生 Agent；Agent 只读批次，分别保存响应，不能共享写入 `paper.json`、术语表、其他响应或收据。只翻译 `targets`，不要因为 `textPool` 中出现上下文就将其重复提交为译文。

响应形式如下；标识必须来自实际任务，不能照抄占位符：

```json
{
  "schemaVersion": 1,
  "jobId": "实际清单 ID",
  "batchId": "实际批次 ID",
  "payloadHash": "实际完整载荷哈希",
  "translations": [{
    "blockId": "目标块 ID",
    "enHash": "目标英文哈希",
    "zh": "完整忠实中文",
    "formatting": [],
    "issues": [],
    "invariantDecisions": {}
  }]
}
```

中文格式条目只能含 `start/end/kind/sourceEvidence`；坐标是 UTF-16，不能切开代理对。`kind` 为 italic/sup/sub，证据非空。数值 token 的差异须逐项给出具体理由；不能用理由豁免显式图号作用域、编号或面板改变。机器只核验理由存在，不判定其科学正确性。存在疑点时填写 `issues`，不要为了接收而删除真实疑点。

## 全组预检与单写者合并

提供同一 job 的全部独立响应，每个批次恰好一份。`--response` 可重复；重复文件、同批不同响应、缺项、多项、格式错误、过期来源/结构/上下文/术语/中文状态均阻止整组提交。

```sh
python3 SKILL/scripts/translation_pipeline.py validate-many WORK --job JOB_ID --response RESPONSE_1.json --response RESPONSE_2.json
python3 SKILL/scripts/translation_pipeline.py accept-many WORK --job JOB_ID --response RESPONSE_1.json --response RESPONSE_2.json
```

`validate-many` 不写任务、paper、manifest、收据或锁；若有写者、待恢复事务或读期间状态改变，则停止。`accept-many` 使用共享 `WORK/.micro-paper-write.lock`，获得锁后重新读取并验证全部响应。任何一份失败时，尚未提交其他响应。

整组验证通过后，在工作目录内独立暂存合并结果，保留批准的英文引用和未改动块的中文引用，重建本次目标的中文图引用，只执行一次 `reader.freeze`。随后将 paper、source-manifest 和 receipts 作为同一带日志事务提交。中文带 issues 的块进入 `needs-review`，其他块为 `translated`，都不会自动变成 `reviewed`。

若本次译文改变了某块中文正文，原 `referenceCitations` 中该块的中文参考文献坐标不能继续使用。旧记录完整保存到 `referenceCitationCandidates.previousCitation`，同时记录前后中文哈希、任务 ID 及失效原因；顶层不保留旧坐标作为当前链接。该块进入 `needs-review`，必须按英文来源重新配对并处理未决记录。英文链接及中文未变块的链接保留。

`translation-receipts.json` 保存每批响应哈希及合并后的逐块状态哈希。再次提交相同响应且当前块状态仍与收据一致时返回 `already-accepted`，不重写文件、不再次 freeze；同批不同响应或收据之后被修改的译文会被拒绝。想主动修订时应明确准备新的修订任务。

## 锁、事务与恢复

所有合作写入者使用 `pipeline_common.work_lock`。共享锁记录 pid、operation、createdAt、hostname、token，支持同线程同进程嵌套，跨进程只允许一名写者。合并可设置 `--lock-timeout`；超时不会删除锁。不能同时用不遵守共享锁的外部编辑器或脚本修改同一论文。预检前记录 paper、manifest、收据、术语表、结构批准及源 PDF 的原字节哈希，正式提交前逐项复核；只读预检结束时也检查相同来源集合。但文件锁无法约束不合作的外部写入者。

提交使用独立临时文件、原子替换、落盘和 `.translation-transaction` 日志。可捕获的写入异常会验证备份及目标状态后回滚全部文件。进程中断则保留日志、前后哈希和备份，供显式恢复：

```sh
python3 SKILL/scripts/translation_pipeline.py recover WORK
```

恢复拒绝仍存活、异主机或无法核实的锁持有者；不能仅凭锁的时间判断失效。借用父锁的打包子进程另在 `lock/borrowers/PID.json` 登记 pid、parentPid、hostname、token；恢复在取得独占 claim 前后都检查这些记录，拒绝存活、损坏或来源不符的借用者，避免父进程退出后误释放仍在打包的子进程锁。确认已停止的借用者记录会随恢复结果返回。

若存在 `.source-transaction`，翻译恢复拒绝接管锁或改动任一事务，必须先核实并处理来源事务；不能用翻译恢复命令绕过来源事务状态。

确认原写者停止后，恢复过程独占旧锁：未提交完成的事务回滚，已记录 committed 且文件哈希相符的事务只清理日志。目标出现日志之外的新改动、备份损坏、未知事务状态、损坏锁或已有恢复 claim 时保持阻塞，保留证据，不自动覆盖；恢复进程自身中断留下的 claim 也需要显式检查，不能自动猜测删除。进程中断可能留下 `.translation-stage-*` 暂存目录；它们不属于正式 paper 或收据，恢复不会猜测删除未知目录。

真正科学审校和最终 review 指纹仍由原有流程负责。批次接收、事务通过、并发测试通过都不能代替来源与逐段译文审校。

扫描及混合来源沿用原有 `transcription:true` 标记。经实际原页独立审查的转录账本须由来源结构审批绑定：`paper.sourceTranscriptionLedgerSha256`、审批同名字段与 `source-transcription-ledger.json` 实际 SHA-256 一致。任务准备、预检与最终提交均核对该身份；并发新增、删除或改动账本会拒绝提交，不能只修改规范文字后沿用旧批准。转录文字与原生字形证据分别核查，详情见来源流程。
