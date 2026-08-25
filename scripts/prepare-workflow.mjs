#!/usr/bin/env node
/**
 * prepare-workflow.mjs — 为 workflow 精读编排生成输入清单
 *
 * 扫描 .zotnote-work 下所有条目, 结合 Vault 笔记状态, 输出"待精读 + 已有笔记
 * 标题清单"的 workflow-input.json, 供 subagent fan-out 使用。
 *
 * 规则:
 *   - 待处理 = workdir 下有 extract/<key>/fulltext.md 且 Vault 中对应笔记
 *     status != "精读完成"（骨架/未精读）的条目;
 *   - vaultTitles = Vault Zotero Notes 下所有 md 的文件名(去扩展名),
 *     供每个 subagent 做 [[wikilink]] 时选目标（篇间一致性由脚本预扫解决）;
 *   - figures 摘要写入输入, subagent 不必重复解析 figures.json。
 *
 * 用法:
 *   node scripts/prepare-workflow.mjs --workdir <dir> [--vault <vaultRoot>]
 *       [--notes-root Zotero Notes] [--out workflow-input.json] [--key K1,K2]
 *
 * 输出 workflow-input.json:
 *   { generatedAt, items: [{ key, title, note, extractDir, figures:[{file,label,caption,page,source}],
 *       sections:[{level,title,page}], expectedFigures }], vaultTitles: [...], total }
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(2); }
function cfgPath() { return path.join(os.homedir(), '.config', 'zotnote', 'config.json'); }

function loadConfig() {
  if (!existsSync(cfgPath())) return {};
  try { return JSON.parse(readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}

async function listMd(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      await listMd(p, acc);
    } else if (e.name.toLowerCase().endsWith('.md')) acc.push(p);
  }
  return acc;
}

async function vaultNoteIndex(vaultRoot, notesRoot) {
  const dir = path.join(vaultRoot, notesRoot);
  const files = await listMd(dir);
  const byKey = new Map();
  const titles = [];
  for (const f of files) {
    let s = '';
    try { s = await readFile(f, 'utf8'); } catch { continue; }
    titles.push(path.basename(f).replace(/\.md$/i, ''));
    const key = (s.match(/^item-key:\s*(\S+)/m) ?? [])[1];
    const status = (s.match(/^status:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
    if (key) byKey.set(key, { path: f, status, title: path.basename(f).replace(/\.md$/i, '') });
  }
  return { byKey, titles };
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const workdir = argOf(argv, '--workdir') ?? path.join(path.dirname(cfg.installDir || '.'), '.zotnote-work');
  const vaultRoot = argOf(argv, '--vault') ?? cfg.obsidian?.vaultRoot;
  const notesRoot = argOf(argv, '--notes-root') ?? cfg.obsidian?.notesRoot ?? 'Zotero Notes';
  const outPath = argOf(argv, '--out') ?? path.join(workdir, 'workflow-input.json');
  const keysFilter = (argOf(argv, '--key') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!vaultRoot) fail('缺少 vaultRoot: 传 --vault 或先配置 ~/.config/zotnote/config.json');

  const { byKey, titles } = await vaultNoteIndex(vaultRoot, notesRoot);

  // 枚举 workdir 条目
  const dirs = (await readdir(workdir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^[A-Z0-9]{8}$/i.test(e.name))
    .map((e) => e.name);
  const items = [];
  for (const key of dirs) {
    if (keysFilter.length && !keysFilter.includes(key)) continue;
    const extractDir = path.join(workdir, key, 'extract', key);
    if (!existsSync(path.join(extractDir, 'fulltext.md'))) continue; // 未提取跳过
    const metaPath = path.join(workdir, key, `item-${key}.json`);
    let meta = null;
    try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { meta = null; }
    let figures = [], sections = [];
    try { figures = JSON.parse(await readFile(path.join(extractDir, 'figures.json'), 'utf8')); } catch {}
    try { sections = JSON.parse(await readFile(path.join(extractDir, 'sections.json'), 'utf8')); } catch {}
    const note = byKey.get(key);
    if (note?.status === '精读完成') continue; // 已完成跳过
    items.push({
      key,
      title: meta?.title ?? key,
      authors: meta?.authors ?? [],
      year: meta?.year ?? '',
      journal: meta?.journal ?? '',
      itemType: meta?.itemType ?? '',
      note: note?.path ?? null, // 骨架笔记路径(null=还没有笔记, agent 须先走 run.mjs)
      noteStatus: note?.status ?? null,
      extractDir,
      figures: figures.map((f) => ({ file: f.file, label: f.label, page: f.page, source: f.source, caption: f.caption })),
      sections: sections.map((s) => ({ level: s.level, title: s.title, page: s.page })),
      expectedFigures: figures.length,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    workdir,
    vaultRoot,
    notesRoot,
    vaultTitles: titles, // 供 wikilink 选目标, 保证篇间一致
    total: items.length,
    items,
  };
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    total: items.length,
    vaultNoteCount: titles.length,
    keys: items.map((i) => `${i.key}${i.note ? '' : '(无骨架,需先run)'}`),
  }, null, 2));
}

main().catch((e) => { console.error(`失败: ${e.message}`); process.exit(2); });
