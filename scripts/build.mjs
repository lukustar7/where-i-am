/**
 * 零依赖静态构建脚本。
 *
 * 构建不是简单复制：它会先确认入口引用、PWA 清单、离线缓存资源和 JavaScript
 * 语法都有效，再生成 dist 目录。任一步失败都会以非零状态退出，阻止残缺版本交付。
 */

import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { constants as fileConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = resolve(ROOT_DIRECTORY, 'dist');

const BUILD_ENTRIES = Object.freeze([
  'index.html',
  'styles.css',
  'manifest.json',
  'sw.js',
  'icon.jpg',
  'js'
]);

const REQUIRED_FILES = Object.freeze([
  'index.html',
  'styles.css',
  'manifest.json',
  'sw.js',
  'icon.jpg',
  'js/app.js',
  'js/geo.js',
  'js/heading.js'
]);

async function assertReadable(relativePath) {
  const absolutePath = resolve(ROOT_DIRECTORY, relativePath);
  await access(absolutePath, fileConstants.R_OK);
}

function assertJavaScriptSyntax(relativePath) {
  const absolutePath = resolve(ROOT_DIRECTORY, relativePath);
  const result = spawnSync(process.execPath, ['--check', absolutePath], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `JavaScript syntax check failed: ${relativePath}`);
  }
}

async function validateProject() {
  await Promise.all(REQUIRED_FILES.map(assertReadable));

  const [html, manifestSource, serviceWorkerSource] = await Promise.all([
    readFile(resolve(ROOT_DIRECTORY, 'index.html'), 'utf8'),
    readFile(resolve(ROOT_DIRECTORY, 'manifest.json'), 'utf8'),
    readFile(resolve(ROOT_DIRECTORY, 'sw.js'), 'utf8')
  ]);

  const requiredHtmlReferences = [
    'href="styles.css"',
    'href="manifest.json"',
    'src="js/app.js"'
  ];

  for (const reference of requiredHtmlReferences) {
    if (!html.includes(reference)) {
      throw new Error(`index.html is missing required reference: ${reference}`);
    }
  }

  const manifest = JSON.parse(manifestSource);
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    throw new Error('manifest.json must declare at least one application icon.');
  }

  for (const icon of manifest.icons) {
    await assertReadable(icon.src);
  }

  const requiredOfflineAssets = [
    './index.html',
    './styles.css',
    './manifest.json',
    './icon.jpg',
    './js/app.js',
    './js/geo.js',
    './js/heading.js'
  ];

  for (const asset of requiredOfflineAssets) {
    if (!serviceWorkerSource.includes(`'${asset}'`)) {
      throw new Error(`sw.js is missing offline asset: ${asset}`);
    }
  }

  for (const relativePath of ['sw.js', 'js/app.js', 'js/geo.js', 'js/heading.js']) {
    assertJavaScriptSyntax(relativePath);
  }
}

async function createOutput() {
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });

  for (const entry of BUILD_ENTRIES) {
    await cp(
      resolve(ROOT_DIRECTORY, entry),
      resolve(OUTPUT_DIRECTORY, entry),
      { recursive: true }
    );
  }
}

await validateProject();
await createOutput();
console.log(`Build complete: ${OUTPUT_DIRECTORY}`);
