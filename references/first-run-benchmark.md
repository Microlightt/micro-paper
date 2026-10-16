# 新论文首轮运行与计时

`scripts/run_ledger.py` 只记录真实操作与证据，不调用或模拟模型，不读取旧论文缓存，不执行翻译，也不代替来源核查或科学审校。它使用 Python 标准库和同目录 `pipeline_common.work_lock`；不添加依赖。测试只使用临时目录内的合成文件。

## 先冻结工具，再从空目录开始

每个被测版本使用各自冻结的 Skill 源码和独立的新输出目录。先保存配置文件，再初始化账本；配置文件放在输出目录外。原始 PDF 可以位于输出目录外，也可以是目录内唯一文件。初始化拒绝已有译文、结构、图像、旧产物、账本或符号链接；允许空子目录。该检查只覆盖指定输出目录，不能证明 Agent 上下文或外部环境从未见过文章，执行者须如实记录此类限制。

```sh
python3 SKILL/scripts/run_ledger.py init RUN \
  --source INPUT.pdf --skill-root SKILL --config CONFIG.json \
  --requested-model REQUESTED_MODEL --requested-thinking REQUESTED_THINKING \
  --requested-service-tier REQUESTED_TIER --requested-max-workers 2
```

替换命令中的占位符，不复制为真实路径或模型名。`RUN` 可为独立 `outputs` 目录，实际提取写到其 `work` 子目录。`--config` 必须是 JSON 对象，应包含影响比较的实际计划：批次预算、来源核查、翻译/审校覆盖、浏览器验收范围等。这里的并发数是请求值；不因写入配置就证明实际使用了相同并发。默认范围如下，可用 `--scope SCOPE.json` 登记较小范围，但较小范围不能获得完整首轮比较资格。

```json
{
  "coverage": "full-article",
  "translation": "full-article",
  "scientificReview": "full-article",
  "browser": "desktop-and-mobile"
}
```

初始化记录实际输入字节数与 SHA-256、Skill 树文件清单与 SHA-256、主机和 Python/Node/相关包版本、UTC 与单调时钟、干净目录检查、请求配置及范围。Skill 树哈希排除 `.git`、`__pycache__`、`.pyc` 和 `.DS_Store`，拒绝符号链接。后续不得修改被冻结的 Skill；不同版本的源码目录应独立保存。

请求模型、推理等级、服务层与实际模型身份分开记录。该本地脚本没有可信的后端身份接口，`actualModel.status` 始终是 `unknown`，不会把请求参数、默认模型或子进程名称当作实际模型证据。未提供的请求字段保留空值，不能据此声称配置已验证。

## 七个阶段及重叠工作

阶段为 `extraction`、`structure`、`figures`、`translation`、`review`、`package`、`browser`。先记录 start，执行真实工作，再 finish；不要事后伪填时间。每个 start 返回独立 `spanId`。

```sh
python3 SKILL/scripts/run_ledger.py start RUN extraction --label "Extract the new source"
python3 SKILL/scripts/run_ledger.py finish RUN SPAN_ID \
  --status completed --evidence EXTRACTION_EVIDENCE.json
```

`--evidence` 可以重复，绑定实际非空文件的路径、字节数和 SHA-256。阶段证据应是独立且保持不变的检查记录、日志或快照。不要直接绑定随后还会被结构整理或翻译改写的 `paper.json`；历史证据改变会阻止完整比较。文件存在与哈希一致只是机械核对，不证明内容忠实、审校真实或浏览器操作已经执行。

独立翻译批次可分别启动 span，记录实际重叠。`--kind active` 是默认工作；`--kind waiting` 记录调度、用户输入或其他真实等待；`--kind rework` 记录返工。等待 span 不充当阶段完成证据。总耗时包含等待、返工、阶段重叠和未单独标记的间隙。

失败或受阻的操作用 `--status failed` 或 `blocked` 结束并说明 `--note`。成功返工后，可以在 finish 使用 `--resolves FAILED_SPAN_ID`，明确解除同阶段失败；可重复指定。仅仅再次成功，不会自动抹去之前的失败。所有失败、返工和原始事件继续保留。

可选子进程模式在 start 后直接执行用户给出的命令，不使用 shell，完成后记录真实退出码：

```sh
python3 SKILL/scripts/run_ledger.py start RUN extraction --run \
  --evidence EXTRACTION_EVIDENCE.json -- python3 SKILL/scripts/reader.py extract INPUT.pdf --out WORK
```

证据文件须由真实操作产生或由执行者随后核实；上述形式不自动生成 `EXTRACTION_EVIDENCE.json`。命令输出流向 stderr，stdout 保持 JSON。零退出码只表示子进程成功，不证明阶段质量；非零退出码记录 failed。若外部进程被强制终止或证据缺失，span 可保持未结束，须检查真实状态后显式 finish，不能猜测它已完成。命令参数会被完整记录，不要放令牌或密码。

## 终止状态与质量证据

阶段未做完、完整审校未做、浏览器未实测等，使用 `partial` 或 `blocked`。先按事实结束所有 open spans，再终止：

```sh
python3 SKILL/scripts/run_ledger.py complete RUN --status partial --note "Actual remaining work"
```

只有七个阶段都有完成的工作 span、每个完成的工作 span 都有实际证据、没有未结束或未解决失败、来源/Skill/历史证据仍与初始化或结束时一致，且范围为默认完整范围时，才能尝试 `completed`。此外必须绑定质量证据文件：

```sh
python3 SKILL/scripts/run_ledger.py complete RUN \
  --status completed --quality-evidence QUALITY.json
```

`QUALITY.json` 必须含 `status: "passed"`、初始化返回的 `runId`、`sourceSha256`、`skillTreeSha256`、`comparisonConfigHash`、`scopeHash`，以及七个阶段各一条通过检查。每个 `evidenceFiles` 文件必须已绑定在本次对应阶段成功完成的非 waiting span 中，其他运行或其他阶段的证据不能替代；相对路径按此质量文件所在目录解析。示例只展示其中一条，实际必须包含全部七条：

```json
{
  "status": "passed",
  "runId": "本次 init 返回的运行 ID",
  "sourceSha256": "本次 init 返回的源文件哈希",
  "skillTreeSha256": "本次 init 返回的 Skill 树哈希",
  "comparisonConfigHash": "本次 init 返回的比较配置哈希",
  "scopeHash": "从该次 init 返回值复制的实际范围哈希",
  "checks": [
    {"stage": "extraction", "status": "passed", "evidenceFiles": ["extraction-evidence.json"]}
  ]
}
```

执行者只能从真实完成的检查生成此清单。尤其 `review` 必须对应实际逐段科学审校和被原流程接受的 QA 证据，`browser` 必须对应真实桌面及手机验收；不能从计时完成、退出码或空模板生成“通过”。账本检查声明、覆盖和证据哈希，不自动评判科学证据内容。若实际质量不满足，保持 partial/blocked，不为产生比值伪造质量清单。

## 报告与比较

```sh
python3 SKILL/scripts/run_ledger.py report RUN
python3 SKILL/scripts/run_ledger.py report CANDIDATE_RUN --compare BASELINE_RUN
```

`elapsedSeconds` 从 init 事件到终止事件，运行中则到当前观测时间。它使用同一可验证时钟域内的单调时钟差，包含调度等待和未标记间隙，不把重叠阶段相加。每个阶段分别输出 active/waiting/rework 的区间并集、区间时长和与最大同时存在 span 数；`workConcurrency` 合并 active 和 rework 计算。区间总和仅用于了解投入，不能拿来替代端到端时长。span 并发是执行者的记录，不等于后端模型实际工作者计数。

只有两个运行都满足完整完成资格、实际源字节哈希和大小相同、范围相同、请求配置相同、主机/运行时相同时，输出 `observedSpeedupRatio = baseline elapsed / candidate elapsed`。Skill 树哈希作为两个版本的明确差异保留，允许不同；不要把本应相同的比较条件隐藏到版本标签里。配置、范围或输入不同以及部分运行只给阻塞原因，不输出比例。同一运行不能与自身比较。

请求配置相同仍不证明实际后端模型一致，报告始终包含 `actualModelEqualityVerified: false` 和 unknown 限制。一对测量只反映该对实际运行；不能据此宣称可复现的稳定提速。旧版仅可使用相同外部计时工具，不得为了比较偷偷替换其来源或翻译算法。没有同时取得两个完整运行，就报告已测的实际阶段和缺失部分，不估算完整耗时。

## 单写者、时钟与不可变性

账本在 `RUN/run-ledger/events/` 逐个追加事件。所有写入共用 `RUN/.micro-paper-write.lock`；事件包含序号、前一事件哈希和自身哈希，先落盘再以独占方式发布，不覆盖已有事件。并行 worker 可调用 CLI，但追加会由锁串行完成。不要直接编辑历史事件。终止后不能再追加；新的尝试使用新的干净目录。

每个事件记录 UTC、单调时钟、主机、时钟实现和 UTC 减单调时钟的估计启动原点。换主机、单调时钟倒退或估计原点偏移超过 5 秒会保守阻塞，避免跨重启或时钟异常拼接假耗时；该校验不是系统签名的启动身份。系统时间大幅校正也可能触发阻塞。遇到不确定性保留账本，不通过修改时间、删除事件或回填时刻继续。

读取时检查事件链与序号，未完成发布文件、损坏事件和写入中的变化会要求重试或人工检查，不自动删除锁或修复历史。此设计防止合作工具无意覆盖并暴露意外损坏，不能抵御有权限重写整条历史的操作者，也不是外部签名审计。所有证据路径、版本和哈希均在本地记录，不自动上传。
