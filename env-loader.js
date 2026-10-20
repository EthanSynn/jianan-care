// ============================================================
// 见岸 · 轻量 .env 加载器（零依赖，Node 端通用）
// ------------------------------------------------------------
// 为什么不用 dotenv 包：
//   1. 云函数部署时要额外装依赖，拖慢冷启动、也增加体积；
//   2. 微信云函数目录里塞 node_modules 容易出各种打包坑；
//   3. 我们要的逻辑很简单，自己写 40 行足够，且行为完全可控。
//
// 用法：
//   const { loadEnv } = require('./env-loader');
//   loadEnv(__dirname);               // 从模块所在目录向上找 .env
//
// 行为约定：
//   · 已存在的 process.env 值优先，不被 .env 覆盖（便于云端用平台配置覆盖本地文件）
//   · 找不到 .env 不报错（云端靠平台环境变量，本地靠 .env，两种姿势都要能跑）
//   · 支持 # 注释、双引号/单引号包裹的值、行内 = 两侧空格
// ============================================================

const fs = require('fs');
const path = require('path');

/** 解析 .env 文本，返回键值对对象 */
function parseEnv(text) {
  const out = {};
  // 去掉 BOM（Windows 上编辑器容易带）
  const src = String(text).replace(/^\uFEFF/, '');
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = line.slice(eq + 1).trim();

    // 去引号（保留引号内的空白）
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      // 未加引号时，去掉行尾注释（" # xxx"）
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }

    out[key] = val;
  }
  return out;
}

/**
 * 从 startDir 开始逐级向上查找 .env 并加载。
 * @param {string} startDir 起始目录（通常传 __dirname）
 * @param {object} [opts]   { maxLevels: 向上找几层，默认 4 }
 * @returns {string|null}   实际加载的文件路径；没找到返回 null
 */
function loadEnv(startDir, opts) {
  const maxLevels = (opts && opts.maxLevels) || 4;
  let dir = startDir || process.cwd();

  for (let i = 0; i < maxLevels; i++) {
    const candidate = path.join(dir, '.env');
    try {
      if (fs.existsSync(candidate)) {
        const vars = parseEnv(fs.readFileSync(candidate, 'utf8'));
        for (const k of Object.keys(vars)) {
          // 已存在的环境变量优先（云端平台配置 > 本地文件）
          if (process.env[k] === undefined || process.env[k] === '') {
            process.env[k] = vars[k];
          }
        }
        return candidate;
      }
    } catch (e) {
      // 读取失败（权限等）不应中断启动，静默跳过
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到根了
    dir = parent;
  }
  return null;
}

// ============================================================
// Key 脱敏：任何日志输出都必须走这里
// ------------------------------------------------------------
// 为什么单独抽出来：出错时最容易顺手把整个 key 打进日志，
// 而云函数的日志是对团队可见的，等于泄密。统一走 mask 就堵住了。
// ============================================================
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '(未配置)';
  if (s.length <= 8) return s[0] + '****';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

module.exports = { loadEnv, parseEnv, maskKey };
