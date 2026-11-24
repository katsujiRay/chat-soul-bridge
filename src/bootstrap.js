/**
 * 入口最前置引导模块（src/bootstrap.js）
 *
 * ESM 静态 import 会在主模块顶层代码之前按依赖顺序执行。
 * 将本文件作为入口文件（src/index.js、scripts/*.mjs）的第 1 行 import，
 * 可确保在 context-db / db / emotion / todos / impressions / memory 等模块
 * 计算 process.cwd() 之前，先完成子 Bot 目录切换（chdir）与分层 .env 加载。
 */
import { initBotRuntime } from './runtime.js';

initBotRuntime();
