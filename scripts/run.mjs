#!/usr/bin/env node
/**
 * run.mjs — zotnote 一键流水线（供 agent 或用户直接调用）
 *
 *   ① 解析 Zotero 条目 → ② 定位 PDF → ③ 提取章节/图表 → ④ 生成 Obsidian 笔记骨架
 *
 * 用法:
 *   node scripts/run.mjs --key MYBFJAXP
 *   node scripts/run.mjs --key MYBFJAXP --workdir <临时工作目录> [--dry-run] [--skip-pdf-download]
 *
 * 配置读取: ~/.config/zotnote/config.json
 *   { zotero: {apiKey, userID, storagePath}, obsidian: {vaultRoot, notesRoot}, pythonCmd }
 *
 * 输出: 笔记路径 + assets 路径 + figures/sections 摘要, 供 agent 继续精读填充。
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function flag(argv, name) { return argv.includes(name); }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(1); }
function cfgPath() { return path.join(os.homedir(), '.config', 'zotnote', 'config.json'); }

function loadConfig() {
  if (!existsSync(cfgPath())) return null;
  try { return JSON.parse(readFileSync(cfgPath(), 'utf8')); } catch { return null; }
}

function runJson(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`${cmd} 失败: ${(r.stderr || r.stdout || '').slice(0, 600)}`);
  return JSON.parse(extractJson(r.stdout));
}

/** 从 stdout 中截取首个 { 到末尾 } 的 JSON（容忍前后附加文本） */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) fail(`stdout 中无 JSON: ${text.slice(0, 200)}`);
  return text.slice(start, end + 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const key = argOf(argv, '--key');
  if (!key) fail('需要 --key <Zotero item key>（用 `zotero.mjs --mode search` 查找）');
  const cfg = loadConfig();
  if (!cfg) fail('缺少 ~/.config/zotnote/config.json, 请先配置（见 README）');
  const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/+/, '');
  const workdir = argOf(argv, '--workdir') ?? path.join(path.dirname(cfg.installDir || scriptDir), '.zotnote-work');
  const dryRun = flag(argv, '--dry-run');

  // ② 拿元数据 + PDF
  const infoOut = spawnSync(process.execPath, [path.join(scriptDir, 'zotero.mjs'), '--mode', 'info', '--key', key], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (infoOut.status !== 0) fail(`info 失败: ${(infoOut.stderr || '').slice(0, 400)}`);
  const meta = JSON.parse(infoOut.stdout.trim());
  if (meta.attachments?.pdf?.localPath) console.log(`PDF: ${meta.attachments.pdf.localPath}（本地）`);
  else console.log(`PDF: 需下载（本地 storage 未命中）`);

  const pdfOut = spawnSync(process.execPath, [path.join(scriptDir, 'zotero.mjs'), '--mode', 'pdf', '--key', key, '--out', workdir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (pdfOut.status !== 0) fail(`pdf 失败: ${(pdfOut.stderr || '').slice(0, 400)}`);
  const pdfInfo = JSON.parse(extractJson(pdfOut.stdout));
  const metaPath = path.join(workdir, `item-${key}.json`);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  // ③ 提取
  const extractDir = path.join(workdir, 'extract', key);
  const pyCmd = cfg.pythonCmd || 'python';
  const extOut = spawnSync(pyCmd, [path.join(scriptDir, 'extract_pdf.py'), 'extract', pdfInfo.pdf, '--out', extractDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (extOut.status !== 0) fail(`extract 失败: ${(extOut.stderr || '').slice(0, 500)}`);
  const extSummary = JSON.parse(extractJson(extOut.stdout));
  console.log(`提取: ${extSummary.figures_extracted} 张图 / ${extSummary.captions} 条题注 / ${extSummary.sections} 个章节`);

  // ④ 生成笔记
  if (dryRun) {
    const d = JSON.parse(spawnSync(process.execPath, [path.join(scriptDir, 'vault.mjs'), '--meta', metaPath, '--extract', extractDir, '--vault', cfg.obsidian.vaultRoot, '--notes-relative-root', cfg.obsidian.notesRoot, '--zotero-uid', String(cfg.zotero.userID ?? ''), '--dry-run'], { encoding: 'utf8' }).stdout.trim());
    console.log(JSON.stringify({ dryRun: true, ...d }, null, 2));
    return;
  }
  const vOut = spawnSync(process.execPath, [path.join(scriptDir, 'vault.mjs'), '--meta', metaPath, '--extract', extractDir, '--vault', cfg.obsidian.vaultRoot, '--notes-relative-root', cfg.obsidian.notesRoot, '--zotero-uid', String(cfg.zotero.userID ?? '')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (vOut.status !== 0) fail(`vault 失败: ${(vOut.stderr || '').slice(0, 500)}`);
  const vJson = JSON.parse(extractJson(vOut.stdout));

  console.log(JSON.stringify({
    ok: true,
    item: { key: meta.key, title: meta.title, authors: meta.authors, year: meta.year },
    note: vJson.note,
    assets: vJson.assetsDir,
    figures: vJson.figuresCopied,
    sections: extSummary.sections,
    extractDir,
    nextSteps: [
      '读取 extractDir/fulltext.md 精读全文（按页码分段）',
      '逐节填写笔记中【主要内容/科学问题/方法/特征结论/研究价值】',
      '对每张 assets 里的图逐图详细解说（可用图像工具查看）',
      '在【关联笔记】用 [[wikilink]] 连接 Vault 中已有笔记',
      '完成后把笔记 frontmatter 的 status 改为 精读完成',
    ],
  }, null, 2));
}

main().catch((e) => { console.error(`失败: ${e.message}`); process.exit(1); });
