const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '18888', 10);
const SAVE_DIR = path.resolve(__dirname);

// ========== 辅助函数 ==========

function log(msg) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${msg}`);
}

// 用 fetch 获取页面内容（替代 curl，兼容云端部署）
async function fetchPage(url, options = {}) {
  const ua = options.ua || 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const maxTime = (options.timeout || 30) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxTime);
  try {
    const headers = { 'User-Agent': ua };
    if (options.referer) headers['Referer'] = options.referer;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    return '';
  }
}

async function downloadFile(url, savePath) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Referer': 'https://m.ke.com/' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(savePath, buffer);
    return buffer.length > 200;
  } catch (e) {
    clearTimeout(timer);
    return false;
  }
}

// ========== Puppeteer 浏览器抓取（绕过验证码） ==========

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });
    return browser;
  } catch (e) {
    log('Puppeteer 启动失败: ' + e.message);
    return null;
  }
}

async function fetchPageWithBrowser(url, options = {}) {
  const b = await getBrowser();
  if (!b) throw new Error('Puppeteer 不可用');
  const page = await b.newPage();
  try {
    await page.setUserAgent(options.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: (options.timeout || 30) * 1000 });
    // 等待 JS 渲染完成
    await new Promise(r => setTimeout(r, 3000));
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

function isCaptchaPage(html) {
  return /<title>\s*(人机验证|CAPTCHA|验证码)\s*<\/title>/i.test(html) ||
         html.includes('人机验证') ||
         html.includes('id="captcha"') ||
         html.includes('请完成安全验证');
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

// ========== 核心提取逻辑 ==========

function extractInfo(html, originalUrl) {
  const info = {};

  // 户型标题
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  info.pageTitle = titleMatch ? titleMatch[1] : '';
  info.huxing = (html.match(/<span class="title-text">([^<]+)<\/span>/) || [])[1] || '';
  info.status = (html.match(/<span class="status[^"]*">([^<]+)<\/span>/) || [])[1] || '';
  info.price = (html.match(/参考总价([^<]+)/) || [])[1] || '';

  // 面积
  const areaM = html.match(/建面\s*([^<]+?)m/m);
  info.area = areaM ? '建面 ' + areaM[1].trim() + 'm²' : '';
  if (!info.area) {
    info.area = (html.match(/面积[：:]\s*([^<"]+)/) || [])[1] || '';
  }

  // 朝向
  info['朝向'] = (html.match(/朝向[：:]\s*<\/span>\s*<span class="value">([^<]+)/) || [])[1] || '';
  if (!info['朝向']) {
    const cm = html.match(/<span class="key">朝向[：:]<\/span>\s*<span class="value">([^<]+)<\/span>/);
    info['朝向'] = cm ? cm[1].trim().replace(/&nbsp;/g,' ') : '';
  }

  // 物业类型
  info['物业类型'] = (html.match(/物业类型[：:]\s*<\/span>\s*<span class="value">([^<]+)/) || [])[1] || '';
  // 户型结构
  info['户型结构'] = (html.match(/户型结构[：:]\s*<\/span>\s*<span class="value">([^<]+)/) || [])[1] || '';
  // 楼盘名称
  info['楼盘名称'] = (html.match(/<h3 class="name">([^<]+)<\/h3>/) || [])[1] || '';
  // 区域
  info['区域'] = '';
  if (html.includes('白云-石井')) {
    info['区域'] = '白云-石井';
  } else {
    const lm = html.match(/<div class="resblock-location-line">\s*([^<]+)\s*<\/div>/);
    info['区域'] = lm ? lm[1].trim() : '';
  }

  // 楼盘单价
  const pm = html.match(/<span class="price_num">([^<]+)<\/span>/);
  if (pm) {
    info['单价'] = pm[1].trim().replace(/&nbsp;/g,' ') + '元/平';
  } else {
    const pm2 = html.match(/(\d+)\s*元\/平/);
    info['单价'] = pm2 ? pm2[0].trim() : '';
  }

  // 楼盘面积范围
  const arm = html.match(/建面\s*([^<]+?)㎡/);
  info['面积范围'] = arm ? '建面 ' + arm[1].trim() + '㎡' : '';

  // 标签
  const tags = [];
  const tagRegex = /<span class="tag">([^<]+)<\/span>/g;
  let t;
  while ((t = tagRegex.exec(html)) !== null) {
    const val = t[1].trim();
    if (!tags.includes(val) && ['住宅', '在售', '近地铁', '多轨交汇', '医疗配套', '综合商场'].includes(val)) {
      tags.push(val);
    }
  }
  info.tags = tags;

  // ---- 图片提取 ----
  const images = [];
  const albumMatch = html.match(/data-album='(\[[\s\S]*?\])'/);
  if (albumMatch) {
    try {
      const albumData = JSON.parse(albumMatch[1].replace(/\\"/g, '"').replace(/\\\//g, '/'));
      let hxSeq = 0;
      albumData.forEach(item => {
        if (item.type_name === 'VR') {
          const url = (item.image_url || '').replace(/\?.*$/, '');
          if (url && !images.find(i => i.url === url)) {
            images.push({ type: 'VR全景', url, name: 'VR全景截图' });
          }
        } else if (item.type_name === '户型图') {
          const url = (item.image_url || '').replace(/\?.*$/, '');
          hxSeq++;
          if (url && !images.find(i => i.url === url)) {
            images.push({ type: '户型图', url, name: `户型图${hxSeq}` });
          }
        }
      });
    } catch (e) {
      log('解析 data-album 失败: ' + e.message);
    }
  }

  // 楼盘封面
  const coverR = /<img[^>]*origin-src="([^"]+)"[^>]*alt="([^"]*(?:楼盘|五矿)[^"]*)"[^>]*>/;
  const coverM = html.match(coverR);
  if (coverM) {
    const url = coverM[1].replace(/\.\d+x\d+\.(jpg|jpeg|png|webp)$/i, '');
    if (!images.find(i => i.url === url)) images.push({ type: '楼盘封面', url, name: '楼盘封面' });
  } else {
    const coverM2 = html.match(/<img[^>]*origin-src="([^"]+)"[^>]*class="avatar[^"]*"[^>]*>/);
    if (coverM2) {
      const url = coverM2[1].replace(/\.\d+x\d+\.(jpg|jpeg|png|webp)$/i, '');
      if (!images.find(i => i.url === url)) images.push({ type: '楼盘封面', url, name: '楼盘封面' });
    }
  }
  info.images = images;

  // ---- 其他户型列表 ----
  const otherHuxing = [];
  const itemRegex = /<li class="frame-list-item[^>]*>([\s\S]*?)<\/li>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(html)) !== null) {
    const ih = itemMatch[1];
    const nm = ih.match(/<span class="name">([^<]+)<\/span>/);
    if (!nm) continue;
    const am = ih.match(/建面\s+([^<]+)/);
    const cm = ih.match(/朝向([^<]+)/);
    const prm = ih.match(/(\d+万)\/套/);
    const lkm = ih.match(/href="([^"]+)"/);
    otherHuxing.push({
      户型: nm[1].trim(),
      面积: am ? '建面 ' + am[1].trim() : '',
      朝向: cm ? cm[1].trim() : '',
      价格: prm ? prm[1] + '/套' : '',
      链接: lkm ? (lkm[1].startsWith('http') ? lkm[1] : 'https://m.ke.com' + lkm[1]) : ''
    });
  }
  info.otherHuxing = otherHuxing;

  return info;
}

// ========== 保存文件 ==========

async function saveFiles(info, saveDir) {
  const results = [];
  let baseName = info.楼盘名称 || info.huxing || '未知户型';
  if (info.huxing) baseName += '_' + info.huxing;
  baseName = sanitizeFilename(baseName);

  // ---- 创建以 baseName 命名的子文件夹（自动去重） ----
  let folderDir = path.join(saveDir, baseName);
  if (fs.existsSync(folderDir)) {
    let suffix = 1;
    while (fs.existsSync(path.join(saveDir, `${baseName}_${suffix}`))) {
      suffix++;
    }
    baseName = `${baseName}_${suffix}`;
    folderDir = path.join(saveDir, baseName);
  }
  fs.mkdirSync(folderDir, { recursive: true });

  // 1. 保存文本信息
  let textContent = `========================================\n`;
  textContent += `贝壳找房 - 户型信息提取\n`;
  textContent += `来源: ${info.sourceUrl}\n`;
  textContent += `提取时间: ${new Date().toLocaleString('zh-CN')}\n`;
  textContent += `========================================\n\n`;
  textContent += `【楼盘名称】${info.楼盘名称 || ''}\n`;
  textContent += `【所在区域】${info.区域 || ''}\n`;
  textContent += `【户型】${info.huxing || ''}\n`;
  textContent += `【状态】${info.status || ''}\n`;
  textContent += `【参考总价】${info.price || ''}\n`;
  textContent += `【建筑面积】${info.area || ''}\n`;
  textContent += `【朝向】${info.朝向 || ''}\n`;
  textContent += `【户型结构】${info.户型结构 || ''}\n`;
  textContent += `【物业类型】${info.物业类型 || ''}\n`;
  textContent += `【楼盘单价】${info.单价 || ''}\n`;
  textContent += `【楼盘面积范围】${info.面积范围 || ''}\n`;
  if (info.tags && info.tags.length) {
    textContent += `【楼盘标签】${info.tags.join('、')}\n`;
  }

  if (info.otherHuxing && info.otherHuxing.length) {
    textContent += `\n========================================\n`;
    textContent += `本楼盘其他户型\n`;
    textContent += `========================================\n`;
    info.otherHuxing.forEach((h, i) => {
      textContent += `\n${i + 1}. ${h.户型} | ${h.面积} | 朝向${h.朝向} | ${h.价格}`;
      if (h.链接) textContent += `\n   链接: ${h.链接}`;
    });
  }

  if (info.images && info.images.length) {
    textContent += `\n\n========================================\n`;
    textContent += `图片清单\n`;
    textContent += `========================================\n`;
    info.images.forEach(img => {
      textContent += `\n${img.name}: ${img.url}`;
    });
  }

  const txtName = `${baseName}.txt`;
  const txtPath = path.join(folderDir, txtName);
  fs.writeFileSync(txtPath, textContent, 'utf-8');
  results.push({ type: '文本', name: txtName, path: txtPath });
  log(`文本已保存: ${txtPath}`);

  // 2. 下载图片（放到子文件夹）
  for (const img of info.images) {
    const ext = path.extname(img.url).split('?')[0] || '.jpg';
    const imgName = `${img.name}${ext}`;
    const imgPath = path.join(folderDir, imgName);

    log(`正在下载: ${img.name} ...`);
    const ok = await downloadFile(img.url, imgPath);
    if (ok) {
      const stat = fs.statSync(imgPath);
      results.push({ type: '图片', name: imgName, path: imgPath, size: stat.size });
      log(`下载成功: ${imgName} (${(stat.size / 1024).toFixed(1)}KB)`);
    } else {
      // 尝试备用 URL
      let fallbackUrl = img.url;
      if (img.url.includes('ke-image.ljcdn.com')) {
        fallbackUrl = img.url.replace('ke-image.ljcdn.com', 'image1.ljcdn.com') + '.1440x.jpg';
      }
      if (fallbackUrl !== img.url) {
        log(`尝试备用地址: ${fallbackUrl}`);
        const ok2 = await downloadFile(fallbackUrl, imgPath);
        if (ok2) {
          const stat = fs.statSync(imgPath);
          results.push({ type: '图片', name: imgName, path: imgPath, size: stat.size });
          log(`下载成功: ${imgName} (${(stat.size / 1024).toFixed(1)}KB)`);
          continue;
        }
      }
      results.push({ type: '图片', name: imgName, path: imgPath, error: '下载失败' });
      log(`下载失败: ${img.name}`);
    }
  }

  // 记录子文件夹路径供前端使用
  const folderInfo = { folderName: baseName, folderPath: folderDir };

  return { files: results, folderName: baseName, folderPath: folderDir };
}

// ========== 请求处理 ==========

function serveStatic(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('404 Not Found');
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data, null, 2));
}

// ========== 提取入口 ==========

async function handleExtract(url, saveDir) {
  // 从 URL 提取楼盘ID和户型ID
  const projectMatch = url.match(/p_([^/]+)/);
  const frameMatch = url.match(/huxingtu\/(\d+)/);
  const projectId = projectMatch ? projectMatch[1] : '';
  const frameId = frameMatch ? frameMatch[1] : '';

  if (!projectId || !frameId) {
    throw new Error('无法从 URL 中解析楼盘和户型ID，请检查链接格式');
  }

  // 直接用已知可访问的移动端 URL
  const mobileUrl = `https://m.ke.com/gz/loupan/p_${projectId}/huxingtu/${frameId}.html`;

  log(`正在抓取: ${mobileUrl}`);
  let html;
  if (process.env.USE_PUPPETEER === 'true') {
    log('使用 Puppeteer 浏览器模式...');
    html = await fetchPageWithBrowser(mobileUrl, { timeout: 30 });
  } else {
    html = await fetchPage(mobileUrl, { timeout: 30 });
  }

  // 如果失败，尝试使用不同 User-Agent
  if (!html || isCaptchaPage(html) || html.includes('404')) {
    log('首次尝试失败，使用备用 User-Agent 重试...');
    await new Promise(r => setTimeout(r, 2000));
    if (process.env.USE_PUPPETEER === 'true') {
      html = await fetchPageWithBrowser(mobileUrl, {
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        timeout: 30
      });
    } else {
      html = await fetchPage(mobileUrl, {
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        timeout: 30
      });
    }
  }

  // 检查是否获取到有效内容（必须有楼盘名称或户型数据）
  if (!html || isCaptchaPage(html) || html.includes('404错误')) {
    throw new Error(`无法获取页面内容（触发验证码或链接无效），请确认链接可访问: ${mobileUrl}`);
  }

  log(`页面获取成功，大小: ${html.length} 字节`);
  return processHtml(html, url, saveDir);
}

// 从 URL 参数中提取楼盘和户型ID
function extractIdsFromUrl(url) {
  const projectMatch = url.match(/p_([^/]+)/);
  const frameMatch = url.match(/huxingtu\/(\d+)/);
  return {
    projectId: projectMatch ? projectMatch[1] : '',
    frameId: frameMatch ? frameMatch[1] : ''
  };
}

function processHtml(html, originalUrl, saveDir) {
  const info = extractInfo(html, originalUrl);
  info.sourceUrl = originalUrl;

  // 补充 ID 信息
  const ids = extractIdsFromUrl(originalUrl);
  info.projectId = ids.projectId;
  info.frameId = ids.frameId;

  // 如果没有从 data-album 提取到封面，尝试从所属楼盘区域抓
  if (!info.images.find(i => i.type === '楼盘封面')) {
    const coverAltMatch = html.match(/<img[^>]*origin-src="([^"]+)"[^>]*class="avatar[^"]*"[^>]*alt="([^"]*)"[^>]*>/);
    if (coverAltMatch) {
      let coverUrl = coverAltMatch[1].replace(/\.\d+x\d+\.(jpg|jpeg|png|webp)$/i, '');
      info.images.push({ type: '楼盘封面', url: coverUrl, name: '楼盘封面' });
    }
  }

  return saveFiles(info, saveDir).then(({ files, folderName, folderPath }) => {
    return { info, files, folderName, folderPath };
  });
}

// ========== 批量提取入口 ==========

async function handleBatchExtract(url, saveDir, onProgress) {
  // 1. 先解析主页面获取其他户型列表
  const projectMatch = url.match(/p_([^/]+)/);
  const frameMatch = url.match(/huxingtu\/(\d+)/);
  const projectId = projectMatch ? projectMatch[1] : '';
  if (!projectId) throw new Error('无法从 URL 中解析楼盘ID');

  // 获取当前户型页面以提取其他户型列表
  const mainUrl = `https://m.ke.com/gz/loupan/p_${projectId}/huxingtu/${frameMatch[1]}.html`;
  log(`获取楼盘户型列表: ${mainUrl}`);
  let mainHtml;
  if (process.env.USE_PUPPETEER === 'true') {
    mainHtml = await fetchPageWithBrowser(mainUrl, { timeout: 30 });
  } else {
    mainHtml = await fetchPage(mainUrl, { timeout: 30 });
  }

  if (!mainHtml || isCaptchaPage(mainHtml)) {
    throw new Error('无法获取户型列表页面');
  }

  const mainInfo = extractInfo(mainHtml, url);
  const allUrls = [url];

  // 收集所有其他户型链接（去重）
  const seenUrls = new Set([url]);
  for (const h of mainInfo.otherHuxing) {
    if (h.链接 && !seenUrls.has(h.链接)) {
      seenUrls.add(h.链接);
      allUrls.push(h.链接);
    }
  }

  const total = allUrls.length;
  log(`批量下载: 共 ${total} 个户型`);

  // 2. 并发处理（限制同时 3 个）
  const results = [];
  let completed = 0;

  async function processOne(u) {
    try {
      const result = await handleExtract(u, saveDir);
      completed++;
      if (onProgress) onProgress(completed, total, result.info?.huxing || '');
      return { success: true, ...result };
    } catch (e) {
      completed++;
      log(`户型提取失败 [${u}]: ${e.message}`);
      return { success: false, url: u, error: e.message };
    }
  }

  // 分批并发
  const concurrency = 3;
  for (let i = 0; i < allUrls.length; i += concurrency) {
    const batch = allUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(u => processOne(u)));
    results.push(...batchResults);
  }

  return { results, batchTotal: total };
}

// ========== HTTP 服务器 ==========

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // API: 提取
  if (pathname === '/api/extract' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const targetUrl = body.url;
      const saveDir = body.saveDir || SAVE_DIR;
      const isBatch = body.batch === true;

      if (!targetUrl) {
        sendJSON(res, { error: '请提供URL' }, 400);
        return;
      }

      if (isBatch) {
        // 批量下载本楼盘所有户型
        const result = await handleBatchExtract(targetUrl, saveDir);
        sendJSON(res, { success: true, batch: true, ...result });
      } else {
        // 单户型提取
        const result = await handleExtract(targetUrl, saveDir);
        sendJSON(res, { success: true, batch: false, ...result });
      }

    } catch (e) {
      log('提取失败: ' + e.message);
      sendJSON(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  // API: 图片预览
  if (pathname === '/preview') {
    const filePath = urlObj.searchParams.get('path');
    if (filePath && fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const ct = mimeTypes[ext] || 'application/octet-stream';
      serveStatic(res, filePath, ct);
    } else {
      res.writeHead(404);
      res.end('');
    }
    return;
  }

  // API: 打开文件夹（仅本地有效）
  if (pathname === '/api/open-folder' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const dir = body.path || SAVE_DIR;
      if (process.platform === 'win32') {
        execSync(`start "" "${dir}"`);
      } else if (process.platform === 'darwin') {
        execSync(`open "${dir}"`);
      } else {
        execSync(`xdg-open "${dir}"`);
      }
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { success: false, error: e.message });
    }
    return;
  }

  // 静态文件
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(__dirname, 'index.html');
    serveStatic(res, indexPath, 'text/html; charset=utf-8');
    return;
  }

  // 其他静态资源
  const filePath = path.join(__dirname, pathname.replace(/^\//, ''));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    serveStatic(res, filePath, contentType);
    return;
  }

  res.writeHead(404);
  res.end('404');
});

server.listen(PORT, () => {
  log(`========================================`);
  log(`贝壳找房 - 户型信息提取工具`);
  log(`========================================`);
  log(`服务已启动: http://localhost:${PORT}`);
  log(`保存路径: ${SAVE_DIR}`);
  log(`========================================`);
});
