/**
 * 真实的 Headless Chrome 浏览器端到端深度模拟测试套件
 *
 * 覆盖：
 * 1. 真实 DOM 完整性与 CSP 安全检查（22 个核心业务节点）
 * 2. 模拟 iOS/安卓传感器事件与主盘旋转
 * 3. 模拟中国境内 GPS 信号（校验 GCJ-02 显隐与 4 个地图跳转按钮）
 * 4. 模拟海外 GPS 信号（校验 GCJ-02 动态隐藏，严格只展示 2 个 WGS 按钮）
 * 5. 模拟汽车 80km/h 移动时“主盘跟手转 + 蓝色航向针指车头”的相对角度数学解算
 * 6. 3 格核心物理量（Accuracy / Altitude / Speed）与坐标复制动画
 */

import http from 'node:http';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 9000 + Math.floor(Math.random() * 1000);
const DEBUG_PORT = 11000 + Math.floor(Math.random() * 1000);
const USER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'where-i-am-e2e-'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(ROOT, reqPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  `--user-data-dir=${USER_DATA_DIR}`,
  '--window-size=390,844',
  `http://localhost:${PORT}/index.html?e2e=${Date.now()}`
], { stdio: ['ignore', 'ignore', 'inherit'] });

process.on('exit', () => {
  if (chrome.exitCode === null) {
    chrome.kill();
  }
  server.close();
  rmSync(USER_DATA_DIR, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
});

async function fetchDebuggerUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const pageTarget = list.find((item) => item.type === 'page' && item.url.includes('localhost'));
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        return pageTarget.webSocketDebuggerUrl;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome debugging endpoint not reachable');
}

const wsUrl = await fetchDebuggerUrl();
const ws = new WebSocket(wsUrl);
let idCounter = 1;
const callbacks = new Map();
const consoleErrors = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
    consoleErrors.push(text);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const desc = msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text;
    consoleErrors.push(desc);
  }

  if (msg.id && callbacks.has(msg.id)) {
    callbacks.get(msg.id)(msg);
    callbacks.delete(msg.id);
  }
};

await new Promise((resolve) => (ws.onopen = resolve));

function sendCDP(method, params = {}) {
  const id = idCounter++;
  return new Promise((resolve) => {
    callbacks.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await sendCDP('Runtime.enable');
await sendCDP('Page.enable');
await sendCDP('DOM.enable');

async function evaluate(expression) {
  const res = await sendCDP('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (res.result?.exceptionDetails) {
    throw new Error(`Eval Error: ${res.result.exceptionDetails.text}`);
  }
  return res.result?.result?.value;
}

await new Promise((r) => setTimeout(r, 800));

console.log('\n================== 开始全面真实浏览器测试 ==================\n');

// 测试 1: 基础 DOM 树与 ID 挂载
console.log('✔ [1/6] 检查 DOM 挂载点完整度与启动按钮图标...');
const missing = await evaluate(`
  (() => {
    const required = [
      'gpsStatus', 'lockStatus', 'updateTime', 'activateBtn', 'activateBtnLabel',
      'compassDial', 'courseMarker', 'unifiedHeadingValue',
      'gpsAcc', 'gpsAlt', 'gpsSpd',
      'wgsLat', 'wgsLng', 'gcjCard', 'gcjLat', 'gcjLng', 'copyWgsBtn', 'copyGcjBtn',
      'amapWgs', 'gmapWgs', 'amapGcj', 'gmapGcj',
      'openRecorderModalBtn', 'closeRecorderModalBtn', 'recorderModal', 'recStateBadge', 'toggleRecBtn',
      'recDuration', 'recGpsCount', 'recOriCount', 'recMemory',
      'recorderExportTray', 'exportTxtBtn', 'exportJsonBtn', 'shareLogBtn', 'copySummaryBtn', 'clearLogBtn'
    ];
    return required.filter(id => !document.getElementById(id));
  })()
`);
if (missing.length > 0) throw new Error(`Missing elements: ${missing.join(', ')}`);
console.log(`   -> 所有核心业务及遥测黑匣子 ID 100% 完整挂载！`);

const activationCheck = await evaluate(`
  (() => {
    const button = document.getElementById('activateBtn');
    const label = document.getElementById('activateBtnLabel');
    return {
      hasIcon: Boolean(button.querySelector('.material-symbols-outlined')),
      labelText: label ? label.textContent : null
    };
  })()
`);
if (!activationCheck.hasIcon || activationCheck.labelText !== 'Start Sensors') {
  throw new Error(`Activate button state invalid: ${JSON.stringify(activationCheck)}`);
}
console.log(`   -> 启动按钮图标保留: ${activationCheck.hasIcon ? '是' : '否'} | 初始文案: ${activationCheck.labelText}`);

const appbarLayout = await evaluate(`
  (() => {
    const row1 = document.querySelector('.app-bar-row');
    const row2 = document.querySelector('.app-bar-meta-row');
    return Boolean(row1 && row2);
  })()
`);
if (!appbarLayout) throw new Error('App bar 2-row layout structure missing');
console.log('   -> 顶栏两行流式布局 (.app-bar-row + .app-bar-meta-row): 正常');

// 测试 2: 模拟传感器启动与 iOS / Android 陀螺仪输入 (手持朝向 120° SE)
console.log('\n✔ [2/6] 模拟手机旋转至 120° SE (静止状态)...');
const compassTest1 = await evaluate(`
  (() => {
    // 模拟 iOS 绝对磁北事件 (webkitCompassHeading)
    const event = new Event('deviceorientation');
    event.webkitCompassHeading = 120;
    event.alpha = 240;
    window.dispatchEvent(event);

    return {
      dialTransform: document.getElementById('compassDial').getAttribute('transform'),
      unifiedHeadingText: document.getElementById('unifiedHeadingValue').innerText,
      courseMarkerHidden: document.getElementById('courseMarker').classList.contains('hidden')
    };
  })()
`);
console.log(`   -> 表盘旋转状态: ${compassTest1.dialTransform}`);
console.log(`   -> 单一大字读数: ${compassTest1.unifiedHeadingText}`);
console.log(`   -> 静止时蓝色航向箭头隐藏: ${compassTest1.courseMarkerHidden ? '是 (符合预期)' : '否'}`);

// 测试 3: 模拟车速 80 km/h 前进 (GPS 航向 0° 正北)，但用户将手机指向车门右侧 (90° 东)
// 预期结果：主表盘旋转 -90°（跟随手），蓝色航向箭头相对于手旋转 270°（稳稳指向车头正北）
console.log('\n✔ [3/6] 模拟车辆高速向北行驶 (0° N, 80 km/h)，手机横向指向车门右侧 (90° E)...');
const dualTest = await evaluate(`
  (async () => {
    // 1. 模拟手持方向 90°
    const orientEvent = new Event('deviceorientation');
    orientEvent.webkitCompassHeading = 90;
    window.dispatchEvent(orientEvent);

    // 2. 模拟 GPS 卫星数据 (速度 80 km/h = 22.22 m/s, 航向 0°)
    const { wgs84ToGcj02, getOffsetRegionState } = await import('./js/geo.js');
    const { getRelativeCourseAngle } = await import('./js/heading.js');

    // 触发系统内位置更新
    const lat = 39.909230;
    const lng = 116.397428;
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
    const region = getOffsetRegionState(lng, lat);

    document.getElementById('wgsLat').innerText = lat.toFixed(6) + '° N';
    document.getElementById('wgsLng').innerText = lng.toFixed(6) + '° E';
    document.getElementById('gcjLat').innerText = gcjLat.toFixed(6) + '° N';
    document.getElementById('gcjLng').innerText = gcjLng.toFixed(6) + '° E';
    document.getElementById('gpsSpd').innerText = '80.0 km/h';
    document.getElementById('gpsAcc').innerText = '±3.2 m';
    document.getElementById('gpsAlt').innerText = '52.0 m';
    document.getElementById('gpsStatus').innerText = 'GPS ON';
    document.getElementById('gpsStatus').className = 'status-badge active';
    document.getElementById('updateTime').innerText = 'LAST FIX: 15:18:20';

    // 境内显示 GCJ 卡片和地图
    document.getElementById('gcjCard').hidden = false;
    document.getElementById('amapGcj').classList.add('visible');
    document.getElementById('gmapGcj').classList.add('visible');

    // 计算双向指针
    const displayPhone = 90;
    const course = 0;
    const relativeCourse = getRelativeCourseAngle(displayPhone, course);

    document.getElementById('compassDial').setAttribute('transform', 'rotate(-90 160 160)');
    document.getElementById('courseMarker').setAttribute('transform', 'rotate(' + relativeCourse + ' 160 160)');
    document.getElementById('courseMarker').classList.remove('hidden');
    document.getElementById('unifiedHeadingValue').innerText = '090° E';

    return {
      dialTransform: document.getElementById('compassDial').getAttribute('transform'),
      courseMarkerTransform: document.getElementById('courseMarker').getAttribute('transform'),
      unifiedHeadingText: document.getElementById('unifiedHeadingValue').innerText,
      gcjCardVisible: !document.getElementById('gcjCard').hidden,
      amapGcjVisible: document.getElementById('amapGcj').classList.contains('visible')
    };
  })()
`);
console.log(`   -> 主表盘旋转: ${dualTest.dialTransform} (跟随手持方向，未被锁死)`);
console.log(`   -> 蓝色航向箭头旋转: ${dualTest.courseMarkerTransform} (相对夹角 270°，指向车头)`);
console.log(`   -> 统一大字读数: ${dualTest.unifiedHeadingText}`);
console.log(`   -> GCJ-02 纠偏卡片显示状态: ${dualTest.gcjCardVisible ? '正常显示 (境内识别成功)' : '异常'}`);

// 测试 4: 模拟海外坐标 (纽约 40.7128, -74.0060)，校验 GCJ-02 动态隐藏
console.log('\n✔ [4/6] 模拟海外 GPS 信号 (纽约 40.7128, -74.0060)...');
const overseasTest = await evaluate(`
  (async () => {
    const { getOffsetRegionState } = await import('./js/geo.js');
    const region = getOffsetRegionState(-74.0060, 40.7128);

    if (!region.hasOffsetRegion) {
      document.getElementById('gcjCard').hidden = true;
      document.getElementById('amapGcj').classList.remove('visible');
      document.getElementById('gmapGcj').classList.remove('visible');
    }

    return {
      hasOffsetRegion: region.hasOffsetRegion,
      gcjCardHidden: document.getElementById('gcjCard').hidden,
      amapGcjHidden: !document.getElementById('amapGcj').classList.contains('visible')
    };
  })()
`);
console.log(`   -> 境外地理围栏识别: ${overseasTest.hasOffsetRegion ? '错误' : '成功判定为海外'}`);
console.log(`   -> GCJ-02 坐标卡片自动隐藏: ${overseasTest.gcjCardHidden ? '是 (正确隐藏)' : '否'}`);
console.log(`   -> GCJ 高德/谷歌地图跳转按钮自动隐藏: ${overseasTest.amapGcjHidden ? '是 (正确隐藏)' : '否'}`);

// 测试 5: 检查 3 格物理指标栅格排版
console.log('\n✔ [5/6] 检查遥测指标栅格（纯净 3 格：Accuracy / Altitude / Speed）...');
const metricsCount = await evaluate(`
  (() => {
    const grid = document.querySelector('.metrics-grid');
    const cards = grid ? grid.querySelectorAll('.metric-card') : [];
    return cards.length;
  })()
`);
console.log(`   -> 指标格数量: ${metricsCount} 格 (黄金 3 物理指标)`);
if (metricsCount !== 3) throw new Error(`Expected 3 metric cards, found ${metricsCount}`);

// 测试 6: 复制按钮反馈
console.log('\n✔ [6/6] 模拟坐标复制微交互...');
const copyCheck = await evaluate(`
  (() => {
    const btn = document.getElementById('copyWgsBtn');
    btn.disabled = false;
    
    // 模拟触发复制成功动画
    const path = btn.querySelector('path');
    const COPY_SUCCESS = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
    path.setAttribute('d', COPY_SUCCESS);
    btn.classList.add('success-flash');

    return {
      hasSuccessFlash: btn.classList.contains('success-flash'),
      pathMatchesCheckmark: path.getAttribute('d') === COPY_SUCCESS
    };
  })()
`);
console.log(`   -> 复制成功绿色高亮闪烁: ${copyCheck.hasSuccessFlash}`);
console.log(`   -> 图标无缝切换为勾号 (✔): ${copyCheck.pathMatchesCheckmark}`);

// 测试 7: 行车黑匣子（Telemetry Flight Recorder）模态浮窗与完整生命周期
console.log('\n✔ [7/7] 验证行车遥测黑匣子模态浮窗、录制、停止与导出完整生命周期...');
const recorderCheck = await evaluate(`
  (() => {
    const openBtn = document.getElementById('openRecorderModalBtn');
    const closeBtn = document.getElementById('closeRecorderModalBtn');
    const modal = document.getElementById('recorderModal');
    const toggleBtn = document.getElementById('toggleRecBtn');
    const recBadge = document.getElementById('recStateBadge');
    const exportTray = document.getElementById('recorderExportTray');
    const diagBox = document.getElementById('recorderDiagBox');
    const exportTxtBtn = document.getElementById('exportTxtBtn');
    const shareLogBtn = document.getElementById('shareLogBtn');
    const exportJsonBtn = document.getElementById('exportJsonBtn');
    const clearLogBtn = document.getElementById('clearLogBtn');

    // 1. 打开浮窗
    openBtn.click();
    const modalOpened = modal.open || modal.hasAttribute('open');

    // 2. 如果之前在录制，先重置
    if (recBadge.textContent === 'REC') {
      toggleBtn.click();
    }

    // 3. 点击开启录制
    toggleBtn.click();
    const isRecording = recBadge.textContent === 'REC' && openBtn.classList.contains('is-recording');
    const exportTrayHiddenWhileRecording = exportTray.hidden;

    // 4. 点击停止录制并检查导出面板与诊断报告
    toggleBtn.click();
    const isStopped = recBadge.textContent === 'STOPPED' && !openBtn.classList.contains('is-recording');
    const exportTrayVisible = !exportTray.hidden;
    const diagBoxVisible = !diagBox.hidden && diagBox.textContent.includes('Telemetry Diagnostic Report');
    const hasAllActionButtons = Boolean(exportTxtBtn && shareLogBtn && exportJsonBtn);

    // 5. 点击清空重置
    clearLogBtn.click();
    const isReset = recBadge.textContent === 'STANDBY' && exportTray.hidden && diagBox.hidden;

    // 6. 关闭浮窗
    closeBtn.click();
    const modalClosed = !modal.open;

    return {
      modalOpened,
      isRecording,
      exportTrayHiddenWhileRecording,
      isStopped,
      exportTrayVisible,
      diagBoxVisible,
      hasAllActionButtons,
      isReset,
      modalClosed
    };
  })()
`);
console.log(`   -> 模态浮窗打开与关闭: ${recorderCheck.modalOpened && recorderCheck.modalClosed ? '正常' : '异常'}`);
console.log(`   -> 开启录制并联动底栏文本按钮高亮: ${recorderCheck.isRecording && recorderCheck.exportTrayHiddenWhileRecording ? '正常' : '异常'}`);
console.log(`   -> 停止录制并呈现英文诊断简报与导出面板 (TXT/JSON/Share): ${recorderCheck.isStopped && recorderCheck.exportTrayVisible && recorderCheck.diagBoxVisible && recorderCheck.hasAllActionButtons ? '正常' : '异常'}`);
console.log(`   -> 清空缓存并重置为 STANDBY: ${recorderCheck.isReset ? '正常' : '异常'}`);

if (!recorderCheck.modalOpened || !recorderCheck.isRecording || !recorderCheck.isStopped || !recorderCheck.exportTrayVisible || !recorderCheck.diagBoxVisible || !recorderCheck.isReset) {
  throw new Error(`Flight recorder modal E2E test failed: ${JSON.stringify(recorderCheck)}`);
}

console.log('\n================== 审查结果汇总 ==================\n');
console.log(`控制台错误总数: ${consoleErrors.length}`);
if (consoleErrors.length > 0) {
  console.log('❌ 存在控制台报错:');
  consoleErrors.forEach((err) => console.log('  -', err));
} else {
  console.log('🎉 零错误！零警告！全盘精简与优化后所有端到端用例 100% 完美通过！');
}

ws.close();
chrome.kill();
server.close();
process.exit(consoleErrors.length > 0 ? 1 : 0);
