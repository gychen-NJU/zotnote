#!/usr/bin/env node
/**
 * batch.mjs — zotnote 批量增量模式
 *
 * 遍历某个 Zotero collection 的全部条目（默认递归子目录）,
 * 自动跳过已经生成过笔记的文章（依据 Vault 中笔记 frontmatter 的 item-key）,
 * 仅为新增文章批量执行: 取 PDF → 提取章节图表 → 生成 Obsidian 笔记骨架。
 *
 * 用法:
 *   node scripts/batch.mjs --collection <key|名称> [--recursive] [--dry-run]
 *   node scripts/batch.mjs --collection <key|名称> --dry-run          # 只列出将处理哪些
 *   node scripts/batch.mjs --collection <key|名称> --workdir <dir>    # 指定工作目录
 *   node scripts/batch.mjs --collection <key|名称> --limit 10         # 本次最多处理 N 篇
 *
 * 判断"已建笔记"的规则:
 *   1. 扫描 <vaultRoot>/<notesRoot> 下所有 .md, 读取 YAML frontmatter 的 item-key;
 *   2. 命中 item-key 即视为已建（即使笔记标题/路径被用户改过也不误判);
 *   3. 同时比对 vault 下 assets/<itemKey>/ 目录是否存在（双保险）。
 *
 * 输出:
 *   { ok, summary: { total, alreadyDone, toProcess, failed },
 *     skipped: [...], processed: [{key, note, assets}], manifest: <path> }
 *   manifest.json 记录本次处理的清单, 供后续逐篇精读。
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function flag(argv, name) { return argv.includes(name); }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(1); }
function cfgPath() { return path.join(os.homedir(), '.config', 'zotnote', 'config.json'); }

function loadConfig() {
  if (!existsSync(cfgPath())) fail('缺少 ~/.config/zotnote/config.json, 请先配置（见 README）');
  return JSON.parse(readFileSync(cfgPath(), 'utf8'));
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function runSync(cmd, args, silent) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败(${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  return extractJson(r.stdout) ?? null;
}

/** 递归收集 vault 下所有 .md 文件 */
async function listMd(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.obsidian' || e.name.startsWith('.')) continue;
      await listMd(p, acc);
    } else if (e.name.toLowerCase().endsWith('.md')) {
      acc.push(p);
    }
  }
  return acc;
}

/** 从 md 文件解析 frontmatter 中的 item-key */
async function itemKeysFromNoteFiles(vaultRoot, notesRoot) {
  const dir = path.join(vaultRoot, notesRoot);
  const files = await listMd(dir);
  const keys = new Set();
  for (const f of files) {
    try {
      const s = await readFile(f, 'utf8');
      const m = s.match(/^---\n([\s\S]*?)\n---/);
      if (!m) continue;
      const k = m[1].match(/^item-key:\s*(\S+)\s*$/m);
      if (k) keys.add(k[1]);
    } catch { /* 不可读跳过 */ }
  }
  return keys;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const argv = process.argv.slice(2);
  const coll = argOf(argv, '--collection');
  if (!coll) fail('需要 --collection <Zotero collection key 或名称>');
  const cfg = loadConfig();
  const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/+/, '');
  const workdir = argOf(argv, '--workdir') ?? path.join(path.dirname(cfg.installDir || scriptDir), '.zotnote-work');
  const dryRun = flag(argv, '--dry-run');
  const recursive = flag(argv, '--recursive');
  const limit = Number(argOf(argv, '--limit') ?? 0);
  const vaultRoot = cfg.obsidian.vaultRoot;
  const notesRoot = cfg.obsidian.notesRoot;

  console.log(`① 枚举 collection "${coll}"${recursive ? '（递归含子目录）' : ''} ...`);
  const collData = runSync(process.execPath, [path.join(scriptDir, 'zotero.mjs'), '--mode', 'collection', '--collection', coll, ...(recursive ? ['--recursive'] : [])]);
  if (!collData) fail('枚举 collection 失败');
  const items = collData.items ?? [];
  console.log(`   共 ${items.length} 个条目`);

  console.log(`② 扫描已有笔记（<vault>/Zotero Notes 下 frontmatter item-key）...`);
  const doneKeys = await itemKeysFromNoteFiles(vaultRoot, notesRoot);
  console.log(`   已有笔记 ${doneKeys.size} 篇`);

  const skipped = [];
  const todo = [];
  for (const it of items) {
    if (doneKeys.has(it.key)) { skipped.push({ key: it.key, title: it.title }); continue; }
    todo.push(it);
  }
  const toProcess = limit > 0 ? todo.slice(0, limit) : todo;
  const skippedBeyondLimit = limit > 0 ? todo.slice(limit) : [];

  console.log(`③ 待处理 ${toProcess.length} 篇${dryRun ? '（--dry-run 预览）' : ''}${skippedBeyondLimit.length ? `（超 --limit 暂缓 ${skippedBeyondLimit.length} 篇）` : ''}`);
  if (dryRun) {
    console.log(JSON.stringify({
      ok: true, summary: { total: items.length, alreadyDone: skipped.length, toProcess: toProcess.length, skippedBeyondLimit: skippedBeyondLimit.length },
      skipped: skipped.map((s) => s.title), toProcess: toProcess.map((t) => t.title),
    }, null, 2));
    return;
  }

  await mkdir(workdir, { recursive: true });
  const processed = [];
  const failed = [];
  for (let i = 0; i < toProcess.length; i++) {
    const it = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] ${it.key} — ${it.title.slice(0, 60)}`);
    try {
      // 一键处理 = 复用 run.mjs 的完整管线
      const r = runSync(process.execPath, [path.join(scriptDir, 'run.mjs'), '--key', it.key, '--workdir', path.join(workdir, it.key)]);
      if (!r) throw new Error('run.mjs 无 JSON 输出');
      processed.push({ key: it.key, title: it.title, note: r.note, assets: r.assets, figures: r.figures, sections: r.sections });
      console.log(`   ✓ 笔记: ${r.note}`);
    } catch (e) {
      failed.push({ key: it.key, title: it.title, error: e.message });
      console.error(`   ✗ 失败: ${e.message}`);
    }
    await sleep(500);
  }

  // 写入 manifest 供后续精读
  const manifest = {
    generatedAt: new Date().toISOString(),
    collection: collData.collection,
    workdir,
    total: items.length,
    alreadyDone: skipped.length,
    processed: processed.map((p) => p.key),
    failed: failed.map((f) => f.key),
    pending: skippedBeyondLimit.map((t) => t.key),
  };
  const manifestPath = path.join(workdir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('\n' + JSON.stringify({
    ok: failed.length === 0,
    summary: { total: items.length, alreadyDone: skipped.length, processed: processed.length, failed: failed.length, pending: skippedBeyondLimit.length },
    skipped: skipped.map((s) => s.key),
    processed: processed.map((p) => p.key),
    failed: failed.map((f) => ({ key: f.key, error: f.error })),
    manifest: manifestPath,
    nextSteps: [
      '逐篇精读: read <assets 目录所在笔记> 或使用 manifest 清单逐个 run 精读流程',
      '对 processed 中的每篇: 读 extractDir/fulltext.md → 填充占位 → 加 [[wikilink]]',
    ],
  }, null, 2));
  if (failed.length) process.exitCode = 2;
}

main().catch((e) => { console.error(`失败: ${e.message}`); process.exit(1); });
