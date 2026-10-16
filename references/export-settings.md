# HTML 导出与阅读设置 v1.6.0

旧论文无需添加设置。正常 `build WORK` 首次构建 `WORK/reader.html`；已有同名文件时添加序号并报告实际路径。浏览器“下载 HTML”默认预览 `reader.html`。`paper.json` 的可选字段如下：

```json
{
  "metadata": {"year": 2026, "titleEn": "Article title", "titleZh": "文章标题", "authors": []},
  "readerSettings": {
    "exportFilenameTemplate": "{year}_{title}_{date}.html",
    "figureScaleSchema": 3
  }
}
```

`metadata.year` 与兼容字段 `metadata.publicationYear` 接受明确的四位发表年份（1000–2999），不从正文或标题猜测年份。模板支持 `{year}`、`{title}`、`{titleEn}`、`{titleZh}`、`{date}`、`{documentId}`；`{title}` 优先英文标题，其次中文标题。`{date}` 是本次构建的 UTC 日期，内联到 `readerSettings.generatedDate`，该 HTML 后续每次下载都使用同一个日期。未知占位符或不完整括号会阻止确认并提示修正。

`figureScaleSchema: 3` 表示完整适应默认。普通图打开、切换和重置时使用当前可用视口的 contain fit，倍率为 1；不使用旧版初始比例或已保存显示偏好。保留的数字输入只修改当前图相对适应大小的倍率，不写入下载 HTML。导出可保留运行时的 schema 3 与兼容初值 1，但不会把当前放大、平移或数字输入值变成下一次打开的默认。放大对话框继续独立计算 contain fit。

点击“下载 HTML”后可修改模板，也可直接编辑最终文件名；预览显示真正请求下载的名称。缺失年份回退为 `unknown-year`，缺失标题回退为 `untitled-paper`，缺失 documentId 回退为 `paper`。清理路径分隔符、非法文件名字符、控制与方向字符、末尾点号和空格；保留中文和 `.html` 扩展名。Windows 设备保留名添加前导 `_`；UTF-8 文件名最多 240 字节。本次会话内重复名称会添加 ` (2)`、` (3)`，并在预览中说明。

浏览器下载 API 无法读取磁盘现有文件。保存位置、磁盘重名处理和覆盖确认由浏览器管理；预览明确提示用户在已有同名文件时改名或通过浏览器保存提示明确确认。文件名模板写入下载 HTML，当前图片缩放与平移不持久化。导出使用原始 HTML 模板，更新 `paper-data` 和独立 `embedded-notes` 数据槽，不序列化当前正文 DOM；原始 PDF、全部原页图、原图、译文和阅读器代码保持离线内联。

## 笔记与颜色快照

浏览器“下载 HTML”会把当前阅读笔记和黄、绿、蓝、粉、橘五色高亮一并保存，包括选区、原引文、上下文、来源身份、颜色、笔记正文和时间信息。下载文件因此包含导出时的阅读笔记。命令行构建只使用工作目录数据，不读取浏览器笔记。

重新打开下载 HTML 时，先核验笔记来源与定位，再与当前浏览器记录合并。本地记录优先；同 ID 的不同记录保留冲突副本，无法核实的位置保留为待定位。快照有独立标记，已应用标记与当前本地记录一起持久化；在保有该标记的同一浏览器存储中，再次打开相同快照不会自动恢复已删除笔记或改色前的旧记录。新浏览器或分离的文件存储首次打开时，从 HTML 所含的快照恢复。修改后再次下载，会生成包含当前状态的新快照。

JSON 备份继续使用 `micro-paper-notes`、schemaVersion 1 和 `micro-paper-notes.json`，保留颜色与来源定位，并携带已应用快照标记。JSON 用于导入、跨版本迁移和备份；手动导入仍预览重复、冲突和待定位记录。Markdown 文件名仍为 `micro-paper-notes.md`，用于查阅引文和笔记文字，不作为可恢复颜色与定位的备份。

本地存储不可用时，页面保留当前会话中的笔记并提示导出 JSON；不承诺刷新后能恢复未成功保存的本地标记。HTML 导出与 JSON 备份仍应保留本次会话当前记录。详细来源、范围映射和校验规则见 [数据契约](data-contract.md)。

## 构建文件名

命令行可使用以下参数（`SKILL`、`WORK` 替换为实际路径）：

```sh
python3 SKILL/scripts/reader.py build WORK --filename-template '{year}_{title}_{date}.html' --date 2026-10-14 --preview
python3 SKILL/scripts/reader.py build WORK --filename-template '{year}_{title}_{date}.html' --date 2026-10-14
```

`--preview` 仅输出当前可用的命名结果，不写入 HTML 或修改 paper.json；并发构建可能在实际保存时占用该名称，此时继续添加序号。`--date` 必须是实际存在的 YYYY-MM-DD 日期。所有构建输出均在完整写入后原子发布并拒绝覆盖；已有名称会增加序号，结果 JSON 报告实际 `output` 与 `filename`。无 `--filename-template` 时使用兼容旧版的默认名称 `reader.html`，但已存在时同样保留旧文件。仅在 paper.json 配置模板会改变浏览器下载默认模板，不改变默认构建名称。

正文及图注的当前字号写入下载 HTML 的阅读设置；新环境以该字号开始，同一文章已有的本地字号偏好优先。搜索词与临时匹配标识不进入导出笔记或永久正文。
