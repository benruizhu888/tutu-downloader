'use strict';

/**
 * 启动器：清掉 ELECTRON_RUN_AS_NODE 之类的环境变量，
 * 保证 Electron 以「应用模式」而不是 Node 模式启动。
 */

const { spawn } = require('child_process');

const electron = require('electron'); // 安装包导出的是可执行文件路径
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = process.argv.slice(2);
const child = spawn(electron, args.length ? args : ['.'], { stdio: 'inherit', env });

child.on('close', (code) => process.exit(code == null ? 0 : code));
