const tools = require('./tools');
const fs = require('fs');
const path = require('path');
const storages = {};

module.exports = function (restoreSource, config, log, callback) {
    const files = {};

    let counter = 0;
    let creators = [];
    for (const type in config) {
        if (config.hasOwnProperty(type)) {
            if (typeof config[type] === 'object' &&
                config[type].type === 'creator') {
                if (creators.indexOf(type) === -1) {
                    creators.push(type);
                }
            }
            for (const attr in config[type]) {
                if (config[type].hasOwnProperty(attr) &&
                    typeof config[type][attr] === 'object' &&
                    config[type][attr].type === 'creator') {
                    if (creators.indexOf(attr) === -1) {
                        creators.push(attr);
                    }
                }
            }
        }
    }
    const backupDir = path.join(tools.getIobDir(), 'backups').replace(/\\/g, '/');

    if (fs.existsSync(backupDir) && (!restoreSource || restoreSource === 'local')) {
        let fff = fs.readdirSync(backupDir).sort().map(file => path.join(backupDir, file).replace(/\\/g, '/'));
        fff = fff.map(file => {
            const stat = fs.statSync(file);
            return {path: file, name: file.split('/').pop(), size: stat.size};
        }).filter(file => file.name.match(/^\d\d\d\d_\d\d_\d\d-\d\d_\d\d_\d\d_backupiobroker\.tar\.gz$/) || creators.indexOf(file.name.split('_')[0]) !== -1 || creators.indexOf(file.name.split('.')[0]) !== -1);
        files.local = {};
        fff.forEach(file => {
            if (file.name.match(/^\d\d\d\d_\d\d_\d\d-\d\d_\d\d_\d\d_backupiobroker\.tar\.gz$/)) {
                files.local.minimal = files.local.minimal || [];
                files.local.minimal.push(file);
            } else {
                const type = file.name.split('_')[0];
                files.local[type] = files.local[type] || [];
                files.local[type].push(file);
            }
        });
    }

    const done = [];

    for (const type in config) {
        if (config.hasOwnProperty(type)) {
            for (const attr in config[type]) {
                if (config[type].hasOwnProperty(attr) &&
                    typeof config[type][attr] === 'object' &&
                    config[type][attr].type === 'storage') {
                    if (done.indexOf(attr) !== -1) continue;
                    done.push(attr);

                    try {
                        storages[attr] = storages[attr] || require('./list/' + attr);
                    } catch (e) {
                        log.error('Cannot load list module ' + attr + ': ' + e);
                        continue;
                    }

                    counter++;
                    storages[attr].list(restoreSource, config[type][attr], creators, log, (err, result, type) => {
                        err && log.error(err);
                        if (result) {
                            if (type === 'cifs') {
                                for (const type in result) {
                                    if (result.hasOwnProperty(type)) {
                                        result[type] = result[type].filter(file => !files.local[type].find(f => f.path === file.path));
                                    }
                                }
                            }
                            files[type] = result;
                            
                        }
                        setTimeout(function() {
                            if (!--counter && callback) callback({error: err, data: files});
                        }, 2000);
                    });
                }
            }
        }
    }

    if (!counter) {
        callback && callback({error: null, data: files});
    }
};