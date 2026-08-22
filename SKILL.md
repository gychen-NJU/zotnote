---
name: zotnote
description: >-
  Zotero 精读笔记生成器：从 Zotero 文库中挑选指定文章，逐节精读 PDF，
  自动提取章节结构与全部图/表（含题注），生成图文并茂、带 YAML frontmatter
  的 Markdown 精读笔记，并按 Zotero 文库目录结构镜像存入 Obsidian Vault，
  供 Obsidian 知识图谱与文献关系网络使用。当用户提到"精读我在 Zotero 里的
  文章 / 给某篇论文写阅读笔记 / 论文阅读笔记 / 图文笔记 / 把文章笔记放进
  Obsidian / 按照 Zotero 目录建笔记 / zotnote"等需求时使用本 skill。
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
   - 对 `assets` 里的**每张图/表**逐图详细解说：图表内容、图内元素、科学内涵
     （模板已预留"图表内容/图内解说/科学内涵"三段，含原题注引用）。
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

## 5. 边界与陷阱

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

## 6. 与 arxiv-checkup 的关系

`arxiv-checkup` 负责"检索→筛选→入库 Zotero"，`zotnote` 负责"Zotero 条目→
精读→Obsidian 笔记"。二者共享同一份 Zotero 文库：用户说"把 arXiv 巡检收的
文章拿来精读"时，先用 arxiv-checkup 确认条目已入库，再用 zotnote 精读。

## 7. 参考

- 安装与更新：见仓库 README.md / README.en.md
- Obsidian 侧建议开启：属性(core plugins)→Frontmatter；图谱视图观察
  `Zotero Notes/` 下的知识网络；可安装 Zotero 集成类社区插件实现
  zotero:// 链接互跳。
