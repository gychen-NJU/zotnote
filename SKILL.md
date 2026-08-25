---
name: zotnote
description: >-
  Zotero 精读笔记生成器：从 Zotero 文库中挑选指定文章，逐节精读 PDF，
  自动提取章节结构与全部图/表（含题注），生成图文并茂、带 YAML frontmatter
  的 Markdown 精读笔记，并按 Zotero 文库目录结构镜像存入 Obsidian Vault，
  供 Obsidian 知识图谱与文献关系网络使用。笔记撰写遵循自然语言与学术论文
  规范，关键数学/物理公式以 LaTeX 行内/行间格式写入并确保 Markdown 正确
  渲染。当用户提到"精读我在 Zotero 里的文章 / 给某篇论文写阅读笔记 / 论文
  阅读笔记 / 图文笔记 / 把文章笔记放进 Obsidian / 按照 Zotero 目录建笔记 /
  公式整理 / LaTeX 公式 / 语言润色 / zotnote"等需求时使用本 skill。
---

# zotnote — Zotero 精读笔记 → Obsidian 知识图谱

## 0. 这是什么

一条**四步流水线**：**选文 → 取 PDF → 结构/图表提取 → Obsidian 笔记骨架**，
最后一步精读与撰写由你（agent）完成，产出高质量、图文并茂、可入知识图谱的
Markdown 笔记。

```
Zotero 条目 --zotero.mjs--> PDF (本地 storage 优先, 否则 web API 下载)
       --extract_pdf.py--> fulltext.md + sections.json + figures/*.png + figures.json
       --vault.mjs-------> <Vault>/Zotero Notes/<collection...>/<短标题 年份>/*.md + assets/<itemKey>/
```

## 1. 配置（安装后第一次使用必做）

配置文件：`~/.config/zotnote/config.json`，结构：

```json
{
  "installDir": "E:/GalaxyC/scholar/zotnote",
  "zotero": {
    "apiKey": "…",                    // https://www.zotero.org/settings/keys 创建（需读写）
    "userID": 15651072,               // zotero.mjs --mode verify 可自动探测
    "storagePath": "E:/software/Zotero/Zotero/storage"   // 本地数据目录; 可留空走网络
  },
  "obsidian": {
    "vaultRoot": "C:/Users/.../Obsidian Vault",
    "notesRoot": "Zotero Notes",      // vault 内相对目录
    "preferredCollection": null       // 条目多 collection 时优先镜像哪个 (null=最深)
  },
  "pythonCmd": "python"               // 需已安装 PyMuPDF (pip install pymupdf)
}
```

验证：`node <installDir>/scripts/zotero.mjs --mode verify`（显示 API 用户、
collection 数、storagePath/vaultRoot 是否可读）。

## 2. 常规执行流程（用户指定文章后）

1. **找到条目** —— 用户说标题/作者/关键词时：
   ```bash
   node <installDir>/scripts/zotero.mjs --mode search --query "<标题关键词>" [--limit 10]
   ```
   返回每个条目的 `key / title / year / authors / collections`。与用户确认后
   用其 `key` 进入下一步。用户直接给了 key 则跳过。
2. **一键流水线**：
   ```bash
   node <installDir>/scripts/run.mjs --key <ITEM_KEY> [--dry-run]
   ```
   自动完成：info → PDF（本地优先）→ extract（章节+图/表+题注）→
   vault 写入口径（不变更已有同名笔记，会加日期后缀另存）。
   打印：`note`（笔记路径）、`assets`（图片目录）、`extractDir`（提取产物）。
3. **精读并撰写**（核心，agent 负责）：
   - 读 `<extractDir>/fulltext.md`：全文按 `<!-- page N -->` 分段，逐段精读；
     同时参考 `sections.json` 的章节标题列表确认结构。
   - 按笔记文件中预留的 **§ 章节占位**逐节填写：
     主要内容 / 科学问题 / 方法 / 特征性质结论 / 研究价值
     （模板已在笔记里，替换 `<!-- … -->` 注释即可）。
   - **图随章节（v0.6.0 起）**：模板已按"图/表的 PDF 页码 → 所属章节"自动映射，
     每张图的题注+三个解说段**直接嵌在对应 § 下**（该节底部还有"涉及图表"索引行）。
     阅读时可图文对照，不必翻到末尾。个别图落在未识别章节的区间时会集中到文末
     "未归属章节的图表"区，此时手动移入正确 § 即可。
   - **语言规范（强制）**：撰写时按 §7.1 的自然语言与学术论文规范整理文字，
     不得保留占位注释、碎片化要点或口语化表述；完成后整篇通读一遍做语言审查
     （术语一致、句子完整、有逻辑连接词、图表引用与正文对应）。
   - **公式整理（强制）**：按 §7.2 把关键数学/物理公式写入笔记（行内 `$…$` /
     行间 `$$…$$`），按 §7.3 逐条自查渲染正确性。
   - 对 `assets` 里的**每张图/表**逐图详细解说：图表内容、图内元素、科学内涵
     （模板已预留"图表内容/图内解说/科学内涵"三段，含原题注引用；
     解说写在**图所在章节下方**，与正文直接对照；文末仅保留"未归属"兜底区）。
   - 无法用 vision 看图时，用 `extract_pdf.py crop` 重新裁剪或说明原因。
4. **知识图谱接线**：
   - 在笔记末尾【关联笔记】用 `[[wikilink]]` 链接 Vault 中其他相关笔记
     （先快速扫描 vault 内已有笔记标题判断相关性）；
   - frontmatter 的 `status` 填 `精读完成`；`aliases` 可加文章常用简称。
5. **汇报**：给用户 3-6 行要点——解决了什么科学/技术问题、方法、关键
   特征/性质、研究价值、未来方向，并给出笔记在 Obsidian 中的路径。

## 3. 常见子命令速查（手动场景）

```bash
# 查看条目完整信息（含 PDF 附件位置）
node scripts/zotero.mjs --mode info --key <KEY>
# 只取 PDF 到指定目录
node scripts/zotero.mjs --mode pdf --key <KEY> --out <dir>
# 列出 Zotero collection 树（确定目录镜像结构）
node scripts/zotero.mjs --mode tree
# 单独提取
python scripts/extract_pdf.py extract <pdf> --out <dir>
# 题注识别失败/图被裁坏时, 手工裁剪: 页面坐标可从 PDF 阅读器/全页渲染获取
python scripts/extract_pdf.py crop <pdf> --out <png> --page 21 --rect "85,218,545,583" --dpi 300
# 重新生成笔记骨架（覆盖已有会另存日期副本）
node scripts/vault.mjs --meta item.json --extract <extractDir> --vault <vaultRoot> --zotero-uid 15651072
```

## 4. 目录镜像规则

- 笔记路径 = `<vault>/<notesRoot>/<Zotero collection 逐级路径>/<短标题 年份>/`
- 图片 = 同目录下 `assets/<itemKey>/`，笔记内用相对路径 `![](assets/<itemKey>/xxx.png)` 引用
- 条目无 collection → 直接挂在 `<notesRoot>/` 下；
  多 collection → 取最深路径（`preferredCollection` 可指定）。

## 5. 批量增量模式（重要！）

用户要求"处理某个文库目录下所有文章"时，**不要逐篇手动跑 run.mjs**，用
`batch.mjs` 一键批量+自动跳过：

```bash
# 预览: 将处理哪些 / 跳过哪些
node <installDir>/scripts/batch.mjs --collection <key|名称> --dry-run [--recursive]
# 真跑: 每个新条目自动 取PDF→提取→生成笔记骨架, 已建笔记的自动跳过
node <installDir>/scripts/batch.mjs --collection <key|名称> [--recursive]
# 控制节奏: 本次最多处理 N 篇 (适合分批+每篇精读)
node <installDir>/scripts/batch.mjs --collection <key|名称> --limit 10
```

**增量机制（核心设计）**：

- `collection` 可传 key 或名称，默认**只处理该目录直属条目**；
  加 `--recursive` 递归所有子 collection（如 `works/` 下一整棵树）。
- **"已有笔记"判定**：扫描 `<vault>/<notesRoot>/` 下所有 .md 的 YAML
  frontmatter `item-key`，命中即跳过。用户改名/移动笔记文件也不会误判；
  `assets/<itemKey>/` 目录作为第二重参考。
- **幂等**：跑过一遍后再跑，已处理条目全部进 skipped，天然断点续跑；
  配合 `--limit` 可一篇文章一篇文章地补齐，每批跑完向用户汇报进度。
- 每次处理输出 `manifest.json`（工作目录下），记录
  processed/failed/pending 清单，供逐篇精读安排。

**批量后的精读顺序**：批量只生成骨架（自动部分），内容精读仍由你完成——
按 manifest 逐篇读 `extractDir/fulltext.md` → 填空 → wikilink。建议每批
3-5 篇精读后再处理下一批，避免上下文过长。

## 7. 语言与公式规范（撰写时必须遵守）

### 7.1 自然语言与学术论文规范

- **成段叙述**：每个 § 下各字段写成连续、通顺的段落（3-8 句），
  **禁止**：半句、关键词罗列、只写"略"、口语化口头禅（"然后""其实""反正"）、
  主观性评价无依据（"这很厉害"）。
- **学术用词**：用书面语（"结果表明""由图可见""我们推断""值得注意的是"），
  谓语完整，时态统一（描述论文内容用一般现在时/过去时混用保持与原文一致）；
  缩写第一次出现给全称，如"辐射磁流体力学（RMHD）"。
- **术语一致**：全文统一同一概念的译名/缩写（NLTE↔非局部热动平衡，只选其一并
  首次标注原文）；人名、仪器名（SDO/HMI）、专有名词保留英文。
- **逻辑衔接**：段落间用连接词（因此/然而/此外/另一方面）体现因果与转折；
  图表引用必须带编号并与正文对应（"如图 1 所示"→ 文中确有此图）。
- **忠实原文**：陈述科学内容不得添加原文没有的结论；转述要标明"原文认为/
  作者指出"。数值、单位、量级与原文严格一致，不得改写。
- **前后对照**：完成最后通读一遍，检查【速览】【章节】【图表】【价值】各部分
  之间口径一致（同一结论在不同章节表述不冲突）。

### 7.2 公式整理（放入哪些、如何提取）

- **放哪些**：①定义式（物理量如何定义、数学量记号约定）；②控制方程/关键
  方程组（RMHD 方程、辐射转移方程、谱线形成方程等）；③推导中的关键中间步
  或最终结果（如反演目标函数、拟合公式）；④与图和表直接相关的数值关系
  （如 $\lambda$ 采样点计算式）。**公式服务于理解正文，不要整段抄推导**，
  每个公式在笔记中必须有 1-2 句"它说明什么"的解释。
- **如何提取**：
  1. 首选 `fulltext.md`：同一页内连续的数学式子通常已经成行；
  2. 公式被打散/乱码或缺失时（常见于复杂 LaTeX 显示公式、分数上下标），
     用 `extract_pdf.py crop` 渲染该区域为图片，配合 vision 工具读图转写为
     LaTeX；或调用 `pdf-converter` skill（MinerU）把 PDF 转 md 后从中取
     公式（MinerU 还原 LaTeX/MathML 更准确，见 §9）；
  3. 转写时对照原图核对：符号对应（希腊字母、上下标）、量纲、编号。
- **必核验**：公式转写后逐字符对照来源，禁止凭印象补全（如凭空加 $10^{5}$）。

### 7.3 LaTeX 格式与渲染正确性（重点）

- **行内公式**：`$…$`（单美元），用于符号、短式、文内引用，
  如 $V_{\mathrm{LOS}}$、$T = 10^{6}\,\mathrm{K}$；
- **行间公式**：`$$…$$`（双美元），独占一段，居中显示，用于定义式/方程组：
  ```markdown
  $$
  \frac{\partial \rho}{\partial t} + \nabla\cdot(\rho\mathbf{u}) = 0
  $$
  ```
- **数学渲染命令**（Obsidian 内置 MathJax，无需插件）：分数 `\frac{}{}`，
  下标 `_{}`、上标 `^{}`、希腊字母 `\alpha \beta \gamma \delta \Delta`
  （大写 `\Delta` 不是 `δ` 变大写，用 `\Delta`）、向量 `\mathbf{u}` 或
  `\vec{u}`、点乘 `\cdot`、nabla `\nabla`、积分 `\int`、求和 `\sum`、
  部分导数 `\partial`、上横线 `\bar{}`、单位 `\mathrm{K}`。
- **转义与常见错误**（自查清单）：
  - 注释中不要写 `$`（会破坏渲染）；Markdown 其他符号（`*` `_`）在
    `$…$` 内按 LaTeX 语义解析而非加粗/斜体；
  - 数字与单位间用 `\,`（如 `10^{6}\,\mathrm{cm\,s^{-1}}`）；
  - LaTeX 命令用反斜杠，**不要**写成全角或中文字符（`Δ` 用 `\Delta`；
    `×` 用 `\times`；`≈` 用 `\approx`）；
  - `$` 必须成对且左右无空格（`$ x $` 不渲染，应写 `$x$`）；
  - 一个 `$` 前后跟数字容易歧义（如"成本 $5"，笔记中避免这类文本）；
  - 公式内文本用 `\text{}`（如 `$T\mathrm{dS}=\text{d}U+…$`）。
- **渲染验证**：写完后在笔记最后的 markdown 源码中肉眼核对：
  每一处 `$` 成对、行间公式 `$$` 独占行且空行前后分隔；确认无"公式源码
  原样显示、花括号不闭合"等（可用 `node -e` 快速扫一遍 `$` 计数，
  奇数即有问题）。

## 8. 边界与陷阱

- **Zotero API key**：只读需求足够；extract/搜索不需要写权限。
- **PDF 优先本地**：`storagePath` 命中可离线工作；miss 时走 `/files` 下载，
  下载失败提示用户开 Zotero 同步或手动放 PDF。
- **提取不是 100%**：遇到位图/矢量混合、跨栏图、题注在图上方的排版，
  `figures.json` 里 `source` 会标注 `raster/vector/vector-gap`；
  【缺失或异常的图】用 crop 子命令手工补，并在笔记中注明。
- **不要覆盖用户笔记**：vault.mjs 对同名笔记自动加日期后缀，绝不覆盖。
- **章节列表仅供参考**：sections.json 由启发式识别，个别论文（特别是
  扫描版/无字体信息 PDF）可能不准确；以 fulltext.md 实际内容为准，
  可在笔记中自行增删 §。
- **长文分步**：>40 页论文建议先写摘要+前三章，再分段补完，避免一次吃掉
  全部上下文。

## 9. 与 arxiv-checkup 的关系

`arxiv-checkup` 负责"检索→筛选→入库 Zotero"，`zotnote` 负责"Zotero 条目→
精读→Obsidian 笔记"。二者共享同一份 Zotero 文库：用户说"把 arXiv 巡检收的
文章拿来精读"时，先用 arxiv-checkup 确认条目已入库，再用 zotnote 精读。

## 10. 参考

- 安装与更新：见仓库 README.md / README.en.md
- Obsidian 侧建议开启：属性(core plugins)→Frontmatter；图谱视图观察
  `Zotero Notes/` 下的知识网络；可安装 Zotero 集成类社区插件实现
  zotero:// 链接互跳。
