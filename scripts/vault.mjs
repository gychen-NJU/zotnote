#!/usr/bin/env node
/**
 * vault.mjs — 把提取结果组装成 Obsidian 精读笔记（zotnote skill）
 *
 * 流程: 读取 extract 产物 (fulltext.md / sections.json / figures.json) +
 *       item metadata → 按 Zotero collection 结构镜像建目录 →
 *       拷贝 figures → 生成带 YAML frontmatter 的笔记骨架 → 输出组装报告。
 *
 * 用法:
 *   node scripts/vault.mjs --meta item.json --extract <extractDir> \
 *       --vault <obsidianVaultRoot> --notes-relative-root "Zotero Notes" \
 *       [--assets "attachments"] [--title-suffix ""] [--dry-run]
 *
 * item.json 结构 (zotero.mjs --mode info 的输出):
 *   { key, title, authors: [], year, journal, doi, collections: [c1,c2,...],
 *     abstract, attachments: { pdf: {...} }, fullData: {...} }
 *
 * 目录规则 (可配置):
 *   <vault>/<notesRoot>/<collection path...>/<Sanitized Title>.md
 *   图片: <vault>/<notesRoot>/<collection path...>/assets/<ItemKey>/<figure>.png
 *   （assets 子目录名取条目 key 防止重名冲突）
 */
import { mkdir, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function flag(argv, name) { return argv.includes(name); }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(1); }

function sanitize(s, max = 160) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || '(untitled)';
}

function slug(s) {
  const base = sanitize(s, 80);
  return base.replace(/[?!.,;:]+$/g, '').trim();
}

/** 目录名: 截短标题 + 年份, 避免超长路径 */
function folderName(meta) {
  const t = slug(meta.title);
  const yr = meta.year ? ` ${meta.year}` : '';
  return `${t.slice(0, 60)}${yr}`.trim();
}

function frontmatter(meta, zoteroUid) {
  const authors = (meta.authors ?? []).map((a) => `"${a.replace(/"/g, '\\"')}"`).join(', ');
  const zoteroUrl = `https://www.zotero.org/users/${zoteroUid ?? '?'}/items/${meta.key}`;
  const today = new Date().toISOString().slice(0, 10);
  const tags = [...(meta.collections ?? []).map((c) => `"${sanitize(c, 40)}"`), 'reading-notes'].join(', ');
  return [
    '---',
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `authors: [${authors}]`,
    `year: "${meta.year || ''}"`,
    `journal: "${sanitize(meta.journal || '', 200)}"`,
    `doi: "${meta.doi || ''}"`,
    `zotero: "zotero://select/items/${meta.key}"`,
    `zotero-web: "${zoteroUrl}"`,
    `item-key: ${meta.key}`,
    `item-type: ${meta.itemType || 'journalArticle'}`,
    `collections: [${tags}]`,
    `created: ${today}`,
    'aliases: []',
    'tags: [reading-notes]',
    'status: 精读中',
    '---',
  ].join('\n');
}

function noteBodyAssembly(meta, sections, figures, zoteroUid) {
  const lines = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  lines.push('> [!info] 元信息');
  lines.push(`> **作者**: ${(meta.authors ?? []).join(', ') || '—'}`);
  lines.push(`> **年份**: ${meta.year || '—'}  **期刊**: ${sanitize(meta.journal || '', 200) || '—'}  **DOI**: ${meta.doi || '—'}`);
  lines.push(`> **Zotero**: [条目链接](zotero://select/items/${meta.key})`);
  lines.push('');
  lines.push('## 📌 速览（TL;DR）');
  lines.push('');
  lines.push('<!-- 一句话说明本文解决了什么核心问题；3-5 个要点。 -->');
  lines.push('');
  lines.push('## 🎯 解决了什么问题（科学/技术问题）');
  lines.push('');
  lines.push('<!-- 1. 领域背景与痛点；2. 本文要解决的具体问题；3. 为何重要。 -->');
  lines.push('');
  lines.push('## 🧭 章节精读');
  lines.push('');
  if (sections.length) {
    let cur = '';
    for (const s of sections) {
      if (s.title === cur) continue;
      cur = s.title;
      lines.push(`### § ${s.title}`);
      lines.push('');
      lines.push('**主要内容**：<!-- 本节讲什么 -->');
      lines.push('');
      lines.push('**科学问题**：<!-- 本节解决什么问题 -->');
      lines.push('');
      lines.push('**方法**：<!-- 用什么方法/技术/手段 -->');
      lines.push('');
      lines.push('**特征/性质/结论**：<!-- 结果的性质、特征、量级 -->');
      lines.push('');
      lines.push('**研究价值**：<!-- 对领域/对本方向的价值 -->');
      lines.push('');
      lines.push('**关键公式**：');
      lines.push('');
      lines.push('<!-- 本节定义式/控制方程/关键推导结果, 用 LaTeX: 行内 $…$、行间 $$…$$。每个公式后加 1-2 句说明其含义。例子:');
      lines.push('');
      lines.push('$$');
      lines.push('\\frac{\\partial \\rho}{\\partial t} + \\nabla\\cdot(\\rho\\mathbf{u}) = 0');
      lines.push('$$');
      lines.push('');
      lines.push('表示质量守恒: 密度的时间变化率与质量通量散度之和为零。 -->');
      lines.push('');
    }
  } else {
    lines.push('<!-- 未识别到章节标题, 请按论文实际结构手动拆分, 逐节填写 -->');
    lines.push('');
  }
  lines.push('## 🖼️ 图表详解');
  lines.push('');
  if (figures.length) {
    for (const f of figures) {
      lines.push(`### ${f.kind === 'table' ? '表' : '图'} ${f.label}（第 ${f.page} 页）`);
      lines.push('');
      lines.push(`> [!quote] 原题注：${f.caption}`);
      lines.push('');
      lines.push(`![${f.caption.slice(0, 60)}](assets/${meta.key}/${f.file})`);
      lines.push('');
      lines.push('**图表内容**：<!-- 图中画了什么（坐标轴、曲线、数据构成） -->');
      lines.push('');
      lines.push('**图内解说**：<!-- 从左到右/从整体到局部, 逐元素解释 -->');
      lines.push('');
      lines.push('**科学内涵**：<!-- 这张图支撑了什么结论/体现什么特征 -->');
      lines.push('');
    }
  } else {
    lines.push('<!-- 未识别到图/表。请阅读 PDF 后人工截图, 或调用 extract_pdf.py crop 补图 -->');
    lines.push('');
  }
  lines.push('## 🔬 特征、性质与研究价值');
  lines.push('');
  lines.push('<!-- 该方法/结果具备的独特性质、可复现性、适用边界 -->');
  lines.push('');
  lines.push('## 🚀 未来研究方向与研究潜力');
  lines.push('');
  lines.push('<!-- 作者提出的后续工作 + 你自己的推断: 下一步做什么、难点、潜力 -->');
  lines.push('');
  lines.push('## 🌐 与前沿科学问题的关联');
  lines.push('');
  lines.push('<!-- 和哪些领域前沿问题 (如恒星大气 NLTE 反演、MHD 模拟、太阳活动) 相关 -->');
  lines.push('');
  lines.push('## 🔗 关联笔记');
  lines.push('');
  lines.push('<!-- 用 [[wikilink]] 链接 Vault 中其他相关笔记, 构建知识图谱 -->');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const metaPath = argOf(argv, '--meta');
  const extractDir = argOf(argv, '--extract');
  const vaultRoot = argOf(argv, '--vault');
  const notesRoot = argOf(argv, '--notes-relative-root') ?? 'Zotero Notes';
  const assetsDirName = argOf(argv, '--assets') ?? 'assets';
  const zoteroUid = argOf(argv, '--zotero-uid');
  const dryRun = flag(argv, '--dry-run');
  if (!metaPath || !extractDir || !vaultRoot) fail('需要 --meta --extract --vault');

  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const [sections, figures] = await Promise.all([
    readFile(path.join(extractDir, 'sections.json'), 'utf8').then((s) => JSON.parse(s)).catch(() => []),
    readFile(path.join(extractDir, 'figures.json'), 'utf8').then((s) => JSON.parse(s)).catch(() => []),
  ]);

  // 1) 目标目录: vaultRoot / notesRoot / collections... / (条目目录: 短标题+年份)
  //    注意: Windows 会剥离路径组件尾部的 . 和空格 (如 "K. N." 会被规范化为 "K. N"),
  //    导致 Obsidian/PowerShell/Python 无法访问 → 此处统一去掉尾部 . / 空格
  const collSegs = (meta.collections ?? []).map((c) => sanitize(c, 60)).map((s) => s.replace(/[. ]+$/, ''));
  const titleSeg = folderName(meta).replace(/[. ]+$/, '');
  const noteDir = path.join(vaultRoot, notesRoot, ...collSegs, titleSeg);
  const assetsDir = path.join(noteDir, assetsDirName, meta.key);
  const notePath = path.join(noteDir, `${titleSeg}.md`);

  if (dryRun) {
    console.log(JSON.stringify({ notePath, assetsDir, figures: figures.length, sections: sections.length }, null, 2));
    return;
  }

  // 2) 拷贝图片
  await mkdir(assetsDir, { recursive: true });
  const copied = [];
  for (const f of figures) {
    const src = path.join(extractDir, 'figures', f.file);
    try { await stat(src); } catch { continue; }
    await copyFile(src, path.join(assetsDir, f.file));
    copied.push(f.file);
  }

  // 3) 生成笔记 (若存在, 备份旧版而非覆盖)
  let finalNote = notePath;
  if (await stat(notePath).then(() => true).catch(() => false)) {
    finalNote = path.join(noteDir, `${titleSeg} (${new Date().toISOString().slice(0, 10)}).md`);
  }
  const body = [
    frontmatter(meta, zoteroUid),
    '',
    noteBodyAssembly(meta, sections, figures, zoteroUid),
    '',
  ].join('\n');
  await writeFile(finalNote, body, 'utf8');

  // 4) 公式 $ 配对快速校验（奇数提示 agent 修正 LaTeX）
  let mathWarn = null;
  const dollars = (body.match(/\$/g) ?? []).length;
  if (dollars % 2 !== 0) {
    mathWarn = `公式美元符号数为奇数 (${dollars}), 笔记中的 $ 未配对, 请检查 LaTeX`;
  }

  // 4) 同时把 extract 全文/JSON 拷入工作区, 供 agent 继续精读 (不进入 vault)
  console.log(JSON.stringify({
    ok: true,
    note: finalNote,
    assetsDir,
    figuresCopied: copied.length,
    figuresTotal: figures.length,
    captionsMissing: figures.length ? 0 : null,
    mathWarn,
    nextSteps: ['读取 fulltext.md 精读全文', '逐节填写章节笔记（含关键公式, LaTeX 行内 $…$ / 行间 $$…$$）', '逐图解说', '语言规范审查（§7.1）', '添加 [[wikilink]] 关联笔记'],
  }, null, 2));
}

main().catch((e) => { console.error(`失败: ${e.message}`); process.exit(1); });
