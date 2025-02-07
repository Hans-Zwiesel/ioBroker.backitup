/* jshint -W097 */
/* jshint strict: false */
/*jslint node: true */
'use strict';

const utils       = require('@iobroker/adapter-core'); // Get common adapter utils
const schedule    = require('node-schedule');
const fs          = require('fs');
const path        = require('path');
const adapterName = require('./package.json').name.split('.').pop();

const tools       = require('./lib/tools');
const executeScripts = require('./lib/execute');
const list        = require('./lib/list');
const restore     = require('./lib/restore');
const GoogleDrive = require('./lib/googleDriveLib');

let adapter;

let systemLang = 'de';                                  // system language
const backupConfig = {};
const backupTimeSchedules = [];                         // Array für die Backup Zeiten
let taskRunning = false;

/**
 * Decrypt the password/value with given key
 * @param {string} key - Secret key
 * @param {string} value - value to decript
 * @returns {string}
 */
function decrypt(key, value) {
    let result = '';
    for(let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

function startBackup(config, cb) {
    if (taskRunning) {
        return setTimeout(startBackup, 10000, config, cb);
    } else {
        taskRunning = true;
        executeScripts(adapter, config, err => {
            taskRunning = false;
            cb && cb(err);
        });
    }
}

// Is executed when a State has changed

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName});

    adapter = new utils.Adapter(options);

    adapter.on('stateChange', (id, state) => {
        if ((state.val === true || state.val === 'true') && !state.ack) {
    
            if (id === adapter.namespace + '.oneClick.minimal' ||
                id === adapter.namespace + '.oneClick.total' ||
                id === adapter.namespace + '.oneClick.ccu') {
                const type = id.split('.').pop();
                const config = JSON.parse(JSON.stringify(backupConfig[type]));
                config.enabled = true;
                config.deleteBackupAfter = 0; // do not delete files by custom backup
    
                startBackup(config, err => {
                    if (err) {
                        adapter.log.error(`[${type}] ${err}`);
                        
                    } else {
                        adapter.log.debug(`[${type}] exec: done`);
                    }
                    setTimeout(function() {
                        adapter.getState('output.line', (err, state) => {
                            if (state.val === '[EXIT] 0') {
                                adapter.setState('history.' + type + 'Success', true, true);
                                adapter.setState(`history.${type}LastTime`, tools.getTimeString(systemLang));
                            } else {
                                adapter.setState(`history.${type}LastTime`, 'error: ' + tools.getTimeString(systemLang));
                                adapter.setState('history.' + type + 'Success', false, true);
                            }
                            
                        });
                    }, 500);
                    adapter.setState('oneClick.' + type, false, true);
                });
            }
        }
    });

    adapter.on('ready', main);

    adapter.on('message', obj => {
        if (obj) {
            switch (obj.command) {
                case 'list':
                    list(obj.message, backupConfig, adapter.log, res => obj.callback && adapter.sendTo(obj.from, obj.command, res, obj.callback));
                    break;

                case 'authGoogleDrive':
                    if (obj.message && obj.message.code) {
                        const google = new GoogleDrive();
                        google.getToken(obj.message.code)
                            .then(json => adapter.sendTo(obj.from, obj.command, {done: true, json: JSON.stringify(json)}, obj.callback))
                            .catch(err => adapter.sendTo(obj.from, obj.command, {error: err}, obj.callback));
                    } else if (obj.callback) {
                        const google = new GoogleDrive();
                        google.getAuthorizeUrl().then(url =>
                            adapter.sendTo(obj.from, obj.command, {url}, obj.callback));
                    }
                    break;

                case 'restore':
                    if (obj.message) {
                        restore(adapter, backupConfig, obj.message.type, obj.message.fileName, adapter.log, res => obj.callback && adapter.sendTo(obj.from, obj.command, res, obj.callback));
                    } else if (obj.callback) {
                        obj.callback({error: 'Invalid parameters'});
                    }
                    break;

                case 'getTelegramUser':
                    adapter.getForeignState(adapter.config.telegramInstance + '.communicate.users', (err, state) => {
                        err && adapter.log.error(err);
                        if (state && state.val) {
                            try {
                                adapter.sendTo(obj.from, obj.command, state.val, obj.callback);
                            } catch (err) {
                                err && adapter.log.error(err);
                                adapter.log.error('Cannot parse stored user IDs from Telegram!');
                            }
                        }
                    });
                    break;
            }
        }
    });

    return adapter;
}

function checkStates() {
    // Fill empty data points with default values
    adapter.getState('history.html', (err, state) => {
        if (!state || state.val === null) {
            adapter.setState('history.html', {
                val: '<span class="backup-type-total">' + tools._('No backups yet', systemLang) + '</span>',
                ack: true
            });
        }
    });
    adapter.getState('history.minimalLastTime', (err, state) => {
        if (!state || state.val === null) {
            adapter.setState('history.minimalLastTime', {val: tools._('No backups yet', systemLang), ack: true});
        }
    });
    adapter.getState('history.totalLastTime', (err, state) => {
        if (!state || state.val === null) {
            adapter.setState('history.totalLastTime', {val: tools._('No backups yet', systemLang), ack: true});
        }
    });
    adapter.getState('history.ccuLastTime', (err, state) => {
        if (!state || state.val === null) {
            adapter.setState('history.ccuLastTime', {val: tools._('No backups yet', systemLang), ack: true});
        }
    });
    adapter.getState('oneClick.minimal', (err, state) => {
        if (!state || state.val === null) {
            adapter.setState('oneClick.minimal', {val: false, ack: true});
        }
    });
    adapter.getState('oneClick.total', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('oneClick.total', {val: false, ack: true});
        }
    });
    adapter.getState('oneClick.ccu', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('oneClick.ccu', {val: false, ack: true});
        }
    });
    adapter.getState('history.ccuSuccess', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('history.ccuSuccess', {val: false, ack: true});
        }
    });
    adapter.getState('history.minimalSuccess', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('history.minimalSuccess', {val: false, ack: true});
        }
    });
    adapter.getState('history.totalSuccess', (err, state) => {
        if (state === null || state.val === null) {
            adapter.setState('history.totalSuccess', {val: false, ack: true});
        }
    });
}

// function to create Backup schedules (Backup time)
function createBackupSchedule() {
    for (const type in backupConfig) {
        if (!backupConfig.hasOwnProperty(type)) continue;

        const config = backupConfig[type];
        if (config.enabled === true || config.enabled === 'true') {
            let time = config.time.split(':');

            adapter.log.info(`[${type}] backup was activated at ${config.time} every ${config.everyXDays} day(s)`);

            if (backupTimeSchedules[type]) {
                backupTimeSchedules[type].cancel();
            }
            const cron = '10 ' + time[1] + ' ' + time[0] + ' */' + config.everyXDays + ' * * ';
            backupTimeSchedules[type] = schedule.scheduleJob(cron, () => {
                adapter.setState('oneClick.' + type, true, true);

                startBackup(backupConfig[type], err => {
                    if (err) {
                        adapter.log.error(`[${type}] ${err}`);
                    } else {
                        adapter.log.debug(`[${type}] exec: done`);
                    }
                    setTimeout(function() {
                        adapter.getState('output.line', (err, state) => {
                            if (state.val === '[EXIT] 0') {
                                adapter.setState('history.' + type + 'Success', true, true);
                                adapter.setState(`history.${type}LastTime`, tools.getTimeString(systemLang));
                            } else {
                                adapter.setState(`history.${type}LastTime`, 'error: ' + tools.getTimeString(systemLang));
                                adapter.setState('history.' + type + 'Success', false, true);
                            }
                        });
                    }, 500);
                    adapter.setState('oneClick.' + type, false, true);
                });
            });

            if (config.debugging) {
                adapter.log.debug(`[${type}] ${cron}`);
            }
        } else if (backupTimeSchedules[type]) {
            adapter.log.info(`[${type}] backup deactivated`);
            backupTimeSchedules[type].cancel();
            backupTimeSchedules[type] = null;
        }
    }
}

function initConfig(secret) {
    // compatibility
    if (adapter.config.cifsMount === 'CIFS') {
        adapter.config.cifsMount = '';
    }
    if (adapter.config.redisEnabled === undefined) {
        adapter.config.redisEnabled = adapter.config.backupRedis
    }

    const telegram = {
        enabled: adapter.config.notificationEnabled,
        notificationsType: adapter.config.notificationsType,
        type: 'message',
        instance: adapter.config.telegramInstance,
        SilentNotice: adapter.config.telegramSilentNotice,
        NoticeType: adapter.config.telegramNoticeType,
        User: adapter.config.telegramUser,
        onlyError: adapter.config.telegramOnlyError,
        telegramWaiting: adapter.config.telegramWaitToSend * 1000,
        systemLang
    };

    const pushover = {
        enabled: adapter.config.notificationEnabled,
        notificationsType: adapter.config.notificationsType,
        type: 'message',
        instance: adapter.config.pushoverInstance,
        SilentNotice: adapter.config.pushoverSilentNotice,
        NoticeType: adapter.config.pushoverNoticeType,
        deviceID: adapter.config.pushoverDeviceID,
        onlyError: adapter.config.pushoverOnlyError,
        pushoverWaiting: adapter.config.pushoverWaitToSend * 1000,
        systemLang
    };

    const email = {
        enabled: adapter.config.notificationEnabled,
        notificationsType: adapter.config.notificationsType,
        type: 'message',
        instance: adapter.config.emailInstance,
        NoticeType: adapter.config.emailNoticeType,
        emailReceiver: adapter.config.emailReceiver,
        emailSender: adapter.config.emailSender,
        onlyError: adapter.config.emailOnlyError,
        stopIoB: adapter.config.totalStopIoB,                   // specify if ioBroker should be stopped/started
        emailWaiting: adapter.config.emailWaitToSend * 1000,
        systemLang
    };

    const history = {
        enabled: true,
        type: 'message',
        entriesNumber: adapter.config.historyEntriesNumber,
        systemLang
    };

    const ftp = {
        enabled: adapter.config.ftpEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        host: adapter.config.ftpHost,                       // ftp-host
        deleteOldBackup: adapter.config.ftpDeleteOldBackup, // Delete old Backups from FTP
        ownDir: adapter.config.ftpOwnDir,
        bkpType: adapter.config.restoreType,
        dir: (adapter.config.ftpOwnDir === true) ? null : adapter.config.ftpDir, // directory on FTP server
        dirMinimal: adapter.config.ftpMinimalDir,
        dirTotal: adapter.config.ftpTotalDir,
        user: adapter.config.ftpUser,                       // username for FTP Server
        pass: adapter.config.ftpPassword ? decrypt(secret, adapter.config.ftpPassword) : '',  // password for FTP Server
        port: adapter.config.ftpPort || 21                  // FTP port
    };

    const dropbox = {
        enabled: adapter.config.dropboxEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        deleteOldBackup: adapter.config.dropboxDeleteOldBackup, // Delete old Backups from Dropbox
        accessToken: adapter.config.dropboxAccessToken,
        ownDir: adapter.config.dropboxOwnDir,
        bkpType: adapter.config.restoreType,
        dir: (adapter.config.dropboxOwnDir === true) ? null : adapter.config.dropboxDir,
        dirMinimal: adapter.config.dropboxMinimalDir,
        dirTotal: adapter.config.dropboxTotalDir
    };

    const googledrive = {
        enabled: adapter.config.googledriveEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        deleteOldBackup: adapter.config.googledriveDeleteOldBackup, // Delete old Backups from google drive
        accessJson: adapter.config.googledriveAccessJson,
        ownDir: adapter.config.googledriveOwnDir,
        bkpType: adapter.config.restoreType,
        dir: (adapter.config.googledriveOwnDir === true) ? null : adapter.config.googledriveDir,
        dirMinimal: adapter.config.googledriveMinimalDir,
        dirTotal: adapter.config.googledriveTotalDir
    };

    const cifs = {
        enabled: adapter.config.cifsEnabled,
        mountType: adapter.config.connectType,
        type: 'storage',
        source: adapter.config.restoreSource,
        mount: adapter.config.cifsMount,
        fileDir: __dirname,
        wakeOnLAN: adapter.config.wakeOnLAN,
        macAd: adapter.config.macAd,
        wolTime: adapter.config.wolWait,
        smb: adapter.config.smbType,
        sudo: adapter.config.sudoMount,
        deleteOldBackup: adapter.config.cifsDeleteOldBackup, //Delete old Backups from Network Disk
        ownDir: adapter.config.cifsOwnDir,
        bkpType: adapter.config.restoreType,
        dir: (adapter.config.cifsOwnDir === true) ? null : adapter.config.cifsDir,                       // specify if CIFS mount should be used
        dirMinimal: adapter.config.cifsMinimalDir,
        dirTotal: adapter.config.cifsTotalDir,
        user: adapter.config.cifsUser,                     // specify if CIFS mount should be used
        pass: adapter.config.cifsPassword ? decrypt(secret, adapter.config.cifsPassword) : ''  // password for FTP Server
    };

    const mysql = {
        enabled: adapter.config.mySqlEnabled === undefined ? true : adapter.config.mySqlEnabled,
        type: 'creator',
        ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpMinimalDir} : {}),
        cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsMinimalDir}  : {}),
        dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxMinimalDir}  : {}),
        googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveMinimalDir}  : {}),
        dbName: adapter.config.mySqlName,              // database name
        user: adapter.config.mySqlUser,                // database user
        pass: adapter.config.mySqlPassword ? decrypt(secret, adapter.config.mySqlPassword) : '',            // database password
        deleteBackupAfter: adapter.config.mySqlDeleteAfter, // delete old backupfiles after x days
        host: adapter.config.mySqlHost,                // database host
        port: adapter.config.mySqlPort,                // database port
        exe: adapter.config.mySqlDumpExe               // path to mysqldump
    };

    // Configurations for standard-IoBroker backup
    backupConfig.minimal = {
        name: 'minimal',
        type: 'creator',
        enabled: adapter.config.minimalEnabled,
        time: adapter.config.minimalTime,
        debugging: adapter.config.debugLevel,
        everyXDays: adapter.config.minimalEveryXDays,
        nameSuffix: adapter.config.minimalNameSuffix,           // names addition, appended to the file name
        deleteBackupAfter: adapter.config.minimalDeleteAfter,   // delete old backupfiles after x days
        mysqlEnabled: adapter.config.mysqlMinimalEnabled,       // mysql enabled for minimal
        redisEnabled: adapter.config.redisMinimalEnabled,       // redis enabled for minimal
        zigbeeEnabled: adapter.config.zigbeeEnabled,            // zigee enabled for minimal
        ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpMinimalDir} : {}),
        cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsMinimalDir}  : {}),
        dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxMinimalDir}  : {}),
        googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveMinimalDir}  : {}),
        mysql: {
            enabled: adapter.config.mySqlEnabled === undefined ? true : adapter.config.mySqlEnabled,
            type: 'creator',
            ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpMinimalDir} : {}),
            cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsMinimalDir}  : {}),
            dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxMinimalDir}  : {}),
            googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveMinimalDir}  : {}),
            dbName: adapter.config.mySqlName,              // database name
            user: adapter.config.mySqlUser,                // database user
            pass: adapter.config.mySqlPassword ? decrypt(secret, adapter.config.mySqlPassword) : '',            // database password
            deleteBackupAfter: adapter.config.mySqlDeleteAfter, // delete old backupfiles after x days
            host: adapter.config.mySqlHost,                // database host
            port: adapter.config.mySqlPort,                // database port
            exe: adapter.config.mySqlDumpExe               // path to mysqldump
        },
        dir: tools.getIobDir(),
		redis: {
			enabled: adapter.config.redisEnabled,
            type: 'creator',
            ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpMinimalDir}  : {}),
            cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsMinimalDir} : {}),
            dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxMinimalDir}  : {}),
            googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveMinimalDir}  : {}),
			path: adapter.config.redisPath || '/var/lib/redis', // specify Redis path
        },
        zigbee: {
			enabled: adapter.config.zigbeeEnabled,
            type: 'creator',
            ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpMinimalDir}  : {}),
            cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsMinimalDir} : {}),
            dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxMinimalDir}  : {}),
            googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveMinimalDir}  : {}),
			path: tools.getIobDir() + '/iobroker-data', // specify zigbee path
        },
        history,
        telegram,
        email,
        pushover,
    };

    // Configurations for CCU / pivCCU / RaspberryMatic backup
    backupConfig.ccu = {
        name: 'ccu',
        type: 'creator',
        enabled: adapter.config.ccuEnabled,
        time: adapter.config.ccuTime,
        debugging: adapter.config.debugLevel,
        everyXDays: adapter.config.ccuEveryXDays,
        nameSuffix: adapter.config.ccuNameSuffix,               // names addition, appended to the file name
        deleteBackupAfter: adapter.config.ccuDeleteAfter,       // delete old backupfiles after x days

        ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpCcuDir} : {}),
        cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsCcuDir}  : {}),
        dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxCcuDir}  : {}),
        googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveCcuDir}  : {}),
        history,
        telegram,
        email,
        pushover,

        host: adapter.config.ccuHost,                           // IP-address CCU
        user: adapter.config.ccuUser,                           // username CCU
        pass: adapter.config.ccuPassword ? decrypt(secret, adapter.config.ccuPassword) : '',                       // password der CCU
    };

    // Configurations for total-IoBroker backup
    backupConfig.total = {
        name: 'total',
        type: 'creator',
        enabled: adapter.config.totalEnabled,
        time: adapter.config.totalTime,
        debugging: adapter.config.debugLevel,
        everyXDays: adapter.config.totalEveryXDays,
        nameSuffix: adapter.config.totalNameSuffix,             // names addition, appended to the file name

        deleteBackupAfter: adapter.config.totalDeleteAfter,     // delete old backupfiles after x days
        ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpTotalDir}  : {}),
        cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsTotalDir} : {}),
        dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxTotalDir}  : {}),
        googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveTotalDir}  : {}),
        history,
        telegram,
        email,
        pushover,
        mysql: {
            enabled: adapter.config.mySqlEnabled === undefined ? true : adapter.config.mySqlEnabled,
            type: 'creator',
            ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpTotalDir} : {}),
            cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsTotalDir}  : {}),
            dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxTotalDir}  : {}),
            googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveTotalDir}  : {}),
            dbName: adapter.config.mySqlName,              // database name
            user: adapter.config.mySqlUser,                // database user
            pass: adapter.config.mySqlPassword ? decrypt(secret, adapter.config.mySqlPassword) : '',            // database password
            deleteBackupAfter: adapter.config.mySqlDeleteAfter, // delete old backupfiles after x days
            host: adapter.config.mySqlHost,                // database host
            port: adapter.config.mySqlPort,                // database port
            exe: adapter.config.mySqlDumpExe               // path to mysqldump
        },
        dir: tools.getIobDir(),
        redis: {
            enabled: adapter.config.redisEnabled,
            ftp:  Object.assign({}, ftp,  (adapter.config.ftpOwnDir === true) ? {dir:  adapter.config.ftpTotalDir} : {}),
            cifs: Object.assign({}, cifs, (adapter.config.cifsOwnDir === true) ? {dir:  adapter.config.cifsTotalDir}  : {}),
            dropbox: Object.assign({}, dropbox, (adapter.config.dropboxOwnDir === true) ? {dir:  adapter.config.dropboxTotalDir}  : {}),
            googledrive: Object.assign({}, googledrive, (adapter.config.googledriveOwnDir === true) ? {dir:  adapter.config.googledriveTotalDir}  : {}),
            path: adapter.config.redisPath || '/var/lib/redis', // specify Redis path
        },
        stopIoB: adapter.config.totalStopIoB,                   // specify if ioBroker should be stopped/started
    };
}

function readLogFile() {
    try {
        const logName = path.join(tools.getIobDir(), 'backups', 'logs.txt').replace(/\\/g, '/');
        if (fs.existsSync(logName)) {
            adapter.log.debug(`Printing logs of previous backup`);
            const text = fs.readFileSync(logName).toString();
            const lines = text.split('\n');
            lines.forEach((line, i) => lines[i] = line.replace(/\r$|^\r/, ''));
            lines.forEach(line => {
                line = line.trim();

                if (line) {
                    if (line.startsWith('[DEBUG] [total/total] Packed ')) return;

                    if (line.startsWith('[ERROR]')) {
                        adapter.log.error(line);
                    } else {
                        adapter.log.debug(line);
                    }
                    adapter.setState('output.line', line);
                }
            });
            adapter.setState('output.line', '[EXIT] 0');
            fs.unlinkSync(logName);

            // make the messaging
            const config = require(__dirname + '/lib/total.json');
            config.afterBackup = true;
            executeScripts(adapter, config, err => {

            });
        }
    } catch (e) {
        adapter.log.warn(`Cannot read log file: ${e}`);
    }
}

function createBashScripts() {
    const isWin = process.platform.startsWith('win');

    let jsPath;
    try {
        jsPath = require.resolve('iobroker.js-controller/iobroker.bat');
        jsPath = jsPath.replace(/\\/g, '/');
        const parts = jsPath.split('/');
        parts.pop();
        jsPath = parts.join('/');
    } catch (e) {
        jsPath = path.join(tools.getIobDir(), 'node_modules/iobroker.js-controller');
    }

    // delete .sh and .bat for updates
    if (fs.existsSync(__dirname + '/lib/.update')) {
        if (isWin) {
            fs.existsSync(__dirname + '/lib/stopIOB.bat') && fs.unlinkSync(__dirname + '/lib/stopIOB.bat');
            fs.existsSync(__dirname + '/lib/startIOB.bat') && fs.unlinkSync(__dirname + '/lib/startIOB.bat');
            fs.existsSync(__dirname + '/lib/start_b_IOB.bat') && fs.unlinkSync(__dirname + '/lib/start_b_IOB.bat');
            fs.existsSync(__dirname + '/lib/stop_r_IOB.bat') && fs.unlinkSync(__dirname + '/lib/stop_r_IOB.bat');
            fs.unlinkSync(__dirname + '/lib/.update');
        } else {
            fs.existsSync(__dirname + '/lib/stopIOB.sh') && fs.unlinkSync(__dirname + '/lib/stopIOB.sh');
            fs.existsSync(__dirname + '/lib/startIOB.sh') && fs.unlinkSync(__dirname + '/lib/startIOB.sh');
            fs.existsSync(__dirname + '/lib/external.sh') && fs.unlinkSync(__dirname + '/lib/external.sh');
            fs.unlinkSync(__dirname + '/lib/.update');
        }
    }

    if (isWin) {
        if (!fs.existsSync(__dirname + '/lib/stopIOB.bat')) {
            fs.writeFileSync(__dirname + '/lib/stopIOB.bat', `cd "${path.join(tools.getIobDir())}"\ncall serviceIoBroker.bat stop\ncd "${path.join(__dirname, 'lib')}"\nnode execute.js`);
        }
        if (!fs.existsSync(__dirname + '/lib/startIOB.bat')) {
            fs.writeFileSync(__dirname + '/lib/startIOB.bat', `cd "${path.join(tools.getIobDir())}"\ncall serviceIoBroker.bat start\niobroker start all`);
        }
        if (!fs.existsSync(__dirname + '/lib/start_b_IOB.bat')) {
            fs.writeFileSync(__dirname + '/lib/start_b_IOB.bat', `cd "${path.join(tools.getIobDir())}"\ncall serviceIoBroker.bat start`);
        }
        if (!fs.existsSync(__dirname + '/lib/stop_r_IOB.bat')) {
            fs.writeFileSync(__dirname + '/lib/stop_r_IOB.bat', `cd "${path.join(tools.getIobDir())}"\ncall serviceIoBroker.bat stop\ncd "${path.join(__dirname, 'lib')}"\nnode restore.js`);
        }
    } else {
        if (!fs.existsSync(__dirname + '/lib/stopIOB.sh')) {
            fs.writeFileSync(__dirname + '/lib/stopIOB.sh', `# iobroker stop for backup and restore\nif systemctl status iobroker | grep -q "active (running)"; then\nsudo systemd-run --uid=iobroker bash ${path.join(__dirname, 'lib')}/external.sh\nelse\ncd "${path.join(__dirname, 'lib')}"\nbash external.sh\nfi`);
            fs.chmodSync(__dirname + '/lib/stopIOB.sh', 508);
        }
        if (!fs.existsSync(__dirname + '/lib/startIOB.sh')) {
            fs.writeFileSync(__dirname + '/lib/startIOB.sh', `# iobroker start after backup and restore\nif [ -f ${path.join(__dirname, 'lib')}/.restore.info ] ; then\ncd "${path.join(tools.getIobDir())}"\niobroker start all\nfi\nif [ -f ${path.join(__dirname, 'lib')}/.start.info ] ; then\ncd "${path.join(tools.getIobDir())}"\nbash iobroker start\nfi\nif [ -f ${path.join(__dirname, 'lib')}/.startctl.info ] ; then\nsudo systemctl start iobroker\nfi`);
            fs.chmodSync(__dirname + '/lib/startIOB.sh', 508);
        }
        if (!fs.existsSync(__dirname + '/lib/external.sh')) {
            fs.writeFileSync(__dirname + '/lib/external.sh', `# backup and restore\nif systemctl status iobroker | grep -q "active (running)"; then\nsudo systemctl stop iobroker;\ntouch ${path.join(__dirname, 'lib')}/.startctl.info;\nelse\ncd "${path.join(tools.getIobDir())}"\nbash iobroker stop;\ntouch ${path.join(__dirname, 'lib')}/.start.info;\nfi\nif [ -f ${path.join(__dirname, 'lib')}/.backup.info ] ; then\ncd "${path.join(__dirname, 'lib')}"\nnode execute.js\nfi\nif [ -f ${path.join(__dirname, 'lib')}/.restore.info ] ; then\ncd "${path.join(__dirname, 'lib')}"\nnode restore.js\nfi`);
            fs.chmodSync(__dirname + '/lib/external.sh', 508);
        }
    }
}

// umount after restore
function umount() {

    const backupDir = path.join(tools.getIobDir(), 'backups');
    const child_process = require('child_process');

    if (fs.existsSync(__dirname + '/.mount')) {
        child_process.exec(`mount | grep -o "${backupDir}"`, (error, stdout, stderr) => {
            if (stdout.indexOf(backupDir) !== -1) {
                adapter.log.debug('mount activ... umount in 2 Seconds!!');
                let rootUmount = 'umount';
                if (adapter.config.sudoMount === 'true' || adapter.config.sudoMount === true) {
                    rootUmount = 'sudo umount';
                }
                setTimeout(function() {
                    child_process.exec(`${rootUmount} ${backupDir}`, (error, stdout, stderr) => {
                        if (error) {
                            adapter.log.debug('umount: device is busy... wait 5 Minutes!!');
                            setTimeout(function() {
                                child_process.exec(`${rootUmount} ${backupDir}`, (error, stdout, stderr) => {
                                    if (error) {
                                        adapter.log.error(error);
                                    } else {
                                        fs.existsSync(__dirname + '/.mount') && fs.unlinkSync(__dirname + '/.mount');
                                    }
                                });
                            }, 300000);
                        } else {
                            fs.existsSync(__dirname + '/.mount') && fs.unlinkSync(__dirname + '/.mount');
                        }
                    });
                }, 2000);
            } else {
                adapter.log.debug('mount inactiv!!');
            }
        });
    }
}

// Create Backupdir on first start
function createBackupDir() {
    if (!fs.existsSync(path.join(tools.getIobDir(), 'backups'))) {
        fs.mkdirSync(path.join(tools.getIobDir(), 'backups'));
        adapter.log.debug('Created BackupDir');
    }
}
// delete Hide Files after restore or total backup
function deleteHideFiles() {
    fs.existsSync(__dirname + '/lib/.backup.info') && fs.unlinkSync(__dirname + '/lib/.backup.info');
    fs.existsSync(__dirname + '/lib/.restore.info') && fs.unlinkSync(__dirname + '/lib/.restore.info');
    fs.existsSync(__dirname + '/lib/.startctl.info') && fs.unlinkSync(__dirname + '/lib/.startctl.info');
    fs.existsSync(__dirname + '/lib/.start.info') && fs.unlinkSync(__dirname + '/lib/.start.info');
}

function main() {
    createBashScripts();
    readLogFile();
    createBackupDir();
    umount();
    deleteHideFiles();

    adapter.getForeignObject('system.config', (err, obj) => {
        systemLang = obj.common.language;
        initConfig((obj && obj.native && obj.native.secret) || 'Zgfr56gFe87jJOM');

        checkStates();

        createBackupSchedule();
    });

    // subscribe on all variables of this adapter instance with pattern "adapterName.X.memory*"
    adapter.subscribeStates('oneClick.*');
}
// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}