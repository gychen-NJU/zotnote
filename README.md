# zotnote 📚 — Zotero 精读笔记生成器

English: [README.en.md](README.en.md)

**zotnote** 是一个面向科研文献管理的 **Agent Skill**（DeepSeek Harness / Claude Code 等兼容 `SKILL.md` 的智能体通用）：从你的 **Zotero 文库**中挑选指定文章，自动提取 PDF 的章节结构与**全部图表（含题注）**，生成**图文并茂、逐节精读、带 YAML frontmatter** 的 Markdown 笔记，并按 **Zotero 文库目录结构镜像**写入 **Obsidian Vault**，直接接入知识图谱与文献关系网络。

```
Zotero 条目 ──▶ PDF（本地 storage 优先）──▶ 章节/图表提取 ──▶ Obsidian 精读笔记
              zotero.mjs                extract_pdf.py          vault.mjs / run.mjs
```

## ✨ 特性

- **选择即读**：按文章标题/作者/关键词搜索 Zotero 条目，一条命令完成全流程
- **批量增量（新！）**：`batch.mjs --collection <目录>` 处理整个 Zotero 文库目录下的所有文章，**自动跳过已经建过笔记的**（按 Vault 笔记 frontmatter `item-key` 判定，改名/移动笔记不误判），幂等可断点续跑，配 `--recursive` 递归子目录、`--limit` 分批
- **图文并茂**：自动定位并裁剪每张图/表（题注感知），位图走嵌入图、矢量图走绘图包围盒，含 300dpi 高清导出与 `crop` 手工补图子命令
- **逐节精读模板**：每个 § 预留「主要内容 / 科学问题 / 方法 / 特征性质结论 / 研究价值」；每张图预留「图表内容 / 图内解说 / 科学内涵」三段解说，原题注自动引用
- **知识图谱就绪**：YAML frontmatter（title/authors/year/journal/doi/zotero 双链接/collections/tags/status）+ `[[wikilink]]` 关联区
- **目录镜像**：`<Vault>/Zotero Notes/<collection 逐级路径>/<短标题 年份>/`，与 Zotero 分类树一一对应；图片进 `assets/<itemKey>/`
- **安全写入**：永不覆盖已有笔记（同名自动加日期后缀）；本地 PDF 离线可用

## 🚀 快速开始

### 1. 安装依赖

```bash
pip install pymupdf        # 图/文提取 (必要)
# Node.js >= 22 (脚本运行时, 无需 npm install)
```

### 2. 配置

编辑 `~/.config/zotnote/config.json`（Windows: `C:\Users\<你>\.config\zotnote\config.json`）：

```json
{
  "installDir": "<本仓库绝对路径>",
  "zotero": {
    "apiKey": "你的ZoteroAPIkey",
    "userID": 123456,
    "storagePath": "E:/software/Zotero/Zotero/storage"
  },
  "obsidian": {
    "vaultRoot": "C:/Users/你/Documents/Obsidian Vault",
    "notesRoot": "Zotero Notes"
  },
  "pythonCmd": "python"
}
```

- API key：<https://www.zotero.org/settings/keys> 创建（阅读权限即可）
- `storagePath`：Zotero「设置→高级→数据目录」下的 `storage` 子目录；
  留空则走 Zotero Web API 下载 PDF
- 验证：`node scripts/zotero.mjs --mode verify`

### 3. 使用

```bash
# ① 找条目
node scripts/zotero.mjs --mode search --query "white-light flare"
# ② 一键生成笔记骨架（--dry-run 先预览）
node scripts/run.mjs --key MYBFJAXP
# ③ 批量增量：处理某个文库目录的全部文章, 自动跳过已有笔记的
node scripts/batch.mjs --collection "works" --recursive --dry-run   # 先预览
node scripts/batch.mjs --collection "works" --recursive --limit 5   # 每次处理5篇
```

随后打开笔记，把 `<!-- … -->` 占位符替换为你的精读内容即可。

## 🧩 设计

| 文件 | 职责 |
|---|---|
| `SKILL.md` | Agent 技能指令（触发词：Zotero 精读/论文阅读笔记/图文笔记/Obsidian 知识图谱） |
| `scripts/zotero.mjs` | Zotero Web API 客户端：搜索 / info / tree / pdf（本地优先下载兜底） |
| `scripts/extract_pdf.py` | PyMuPDF 提取器：章节标题识别（字号+编号+词表，去伪标题）、图/表题注定位、位图/矢量图裁剪、`crop` 手工子命令 |
| `scripts/vault.mjs` | Obsidian 写入器：目录镜像、图片拷贝、YAML frontmatter + 精读模板骨架、防覆盖 |
| `scripts/run.mjs` | 一键流水线编排 |
| `scripts/batch.mjs` | 批量增量：整库目录处理，自动跳过已有笔记（按 frontmatter item-key），产出 manifest |

### 提取原理

1. **章节**：按文本块字号聚类 + `^\d+(\.\d+)*` 编号模式 + 标准章节词表
   （Abstract/Introduction/Methods/Results/…）三重判定；`1.` 与标题分离排版
   自动合并；过滤时间戳、坐标刻度、机构地址、图内 `(a)/(b)` 标注等伪标题。
2. **图/表**：正则匹配 `Figure/Table/图/表 N` 题注块 → ① 同栏上方嵌入图
   （横向并排/纵向堆叠 panel 自动合并）→ ② 矢量图用页内 `get_drawings()`
   包围盒 → ③ 兜底取题注上方文本间隙。200dpi 默认导出，`--dpi` 可调。
3. **笔记**：frontmatter 携带 zotero://select + zotero.org 双链接，
   `collections` 镜像 Zotero 分类链；正文按用户五问模板组织
   （解决了什么问题 / 方法 / 特征性质 / 研究价值 / 未来方向与前沿关联）。

## 📂 输出示例

```
Obsidian Vault/
└── Zotero Notes/
    └── works/
        └── 2025_Spectropolarimetry/
            └── Stokes Inversion ...
                ├── Stokes Inversion ....md      ← 精读笔记
                └── assets/
                    └── ABCD1234/
                        ├── figure-1-p3.png
                        ├── figure-2-p5.png
                        └── table-1-p7.png
```

## ❓ 常见问题

- **题注位置特殊/图裁坏了** → `python scripts/extract_pdf.py crop <pdf> --out x.png --page 21 --rect "x0,y0,x1,y1" --dpi 300`
- **没有 Zotero 本地安装** → `storagePath` 留空，走网络下载
- **笔记页面布局不同** → `--notes-relative-root` / `--assets` 参数可改
- **与 arxiv-checkup 的关系** → complementary：arxiv-checkup 入库，zotnote 精读

## 📄 许可证

MIT © 2026 gychen-NJU

## Star History

如果这个 skill 对你有帮助，欢迎 ⭐ 收藏与 PR！
