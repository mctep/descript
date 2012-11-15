var de = require('./de.js');

require('./de.result.js');

var no = require('nommon');

//  ---------------------------------------------------------------------------------------------------------------  //

var fs_ = require('fs');
var path_ = require('path');
var url_ = require('url');
var http_ = require('http');
var vm_ = require('vm');

//  ---------------------------------------------------------------------------------------------------------------  //
//  Vars and consts
//  ---------------------------------------------------------------------------------------------------------------  //

var error_aborted = new de.Result.Error({
    id: 'ERROR_ABORTED'
});

var result_null = new de.Result.Value(null);
var promise_null = ( new no.Promise() ).resolve(result_null);

var _id = 0;
var _blocks = {};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block = function(block, descript, options) {};

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.prototype._init = function(descript, options) {
    this.descript = descript;

    this.options = ( options || (( options = {} )) );

    this.priority = this.priority || 0;

    var config = this.descript.config;

    this.dirname = options.dirname || config.rootdir;

    //  Может быть либо функцией, либо строкой вида: '.id == 42 && !state.foo'
    this.guard = compileExpr(options.guard);

    this.before = options.before || null;
    this.after = options.after || null;

    this.preselect = compileObject(options.preselect);
    this.postselect = compileObject(options.postselect);

    this.result = compileExpr(options.result);

    this.key = compileString(options.key);
    this.maxage = de.duration(options.maxage || 0);

    this.params = options.params || null;
    //  FIXME: DEFAULT_TIMEOUT.
    this.timeout = options.timeout || config.timeout || 5000;

    this.datatype = options.datatype;

};

function compileExpr(expr) {
    if (!expr) { return null; }

    return (typeof expr === 'function') ? expr : no.jpath.expr(expr);
}

function compileString(str) {
    if (!str) { return null; }

    return (typeof str === 'function') ? str : no.jpath.string(str);
}

function compileObject(obj) {
    if (!obj) { return null; }

    if (typeof obj === 'function') {
        return obj;
    }

    var r = {};
    for (var key in obj) {
        r[key] = compileExpr( obj[key] );
    }
    return r;
}

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.prototype.resolveFilename = function(filename) {
    if ( filename.charAt(0) !== '/' ) {
        filename = path_.resolve(this.dirname, filename);
    }
    //  FIXME: Проверять, что путь не вышел за пределы rootdir.

    return filename;
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.prototype.valueOf = function() {
    var id = this._id;
    if (!id) {
        id = this._id = '@block' + _id++ + '@';
        _blocks[id] = this;
    }

    return id;
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.prototype.run = function(params, context) {
    //  Проверяем гвард, если он есть.
    var _guard = this.guard;
    if ( _guard && !_guard(params, params, context) ) {
        //  Если блок выполнять не нужно, возвращаем предопределенный promise,
        //  который зарезолвлен null'ом.
        return promise_null;
    }

    var state = context.state;

    //  Возможность положить что-нибудь в стейт до выполнения блока.
    var _preselect = this.preselect;
    if (_preselect) {
        for (var key in _preselect) {
            state[key] = _preselect[key](params, params, context);
        }
    }

    var _before = this.before;
    if (_before) {
        _before(params, context);
    }

    //  Вычисляем новые параметры (или берем старые).
    var _params = this.params;
    if (_params) {
        params = _params(params, context);
    }

    var promise;

    var results = this.descript._results;

    //  Смотрим, определен ли ключ для этого блока.
    var _key = this.key;
    var key;
    var isCached = false;
    if (_key) {
        //  Вычисляем ключ.
        key = _key(params, params, context);

        //  Смотрим, не закэширован ли блок с таким же ключом.
        var cached = results[key];
        if (cached) {
            //  Не протух ли еще наш кэш?
            if (cached.timestamp + this.maxage > context.now) {
                //  Нет, берем из кэша promise с результатом.
                promise = cached.promise;
                isCached = true;
            } else {
                //  Протухло.
                results[key] = null;
            }
        }
    }

    //  Блок не закэширован.
    if (!promise) {
        //  Создаем новый promise.
        promise = new no.Promise();

        //  Кэша нет, но ключ есть.
        if (key) {
            //  Кэшируем блок на будущее.
            //  Можно не ждать окончания выполнения блока, т.к. там все равно promise кэшируется.
            results[key] = {
                timestamp: context.now,
                promise: promise
            };

            promise.then(function(result) {
                //  Если выполнение привело к ошибке, выкидываем ключ из кэша.
                //  Чтобы в следующий раз блок выполнился еще раз.
                if (result instanceof de.Result.Error) {
                    results[key] = null;
                }
            });
        }
    }

    var that = this;

    var hTimeout = null;
    var _timeout = this.timeout;
    //  Если определен таймаут для блока и блок незакэширован...
    if (!isCached && _timeout) {
        //  Если блок выполнился быстрее, чем таймаут.
        promise.then(function() {
            if (hTimeout) {
                //  Отменяем setTimeout.
                clearTimeout(hTimeout);
                hTimeout = null;
            }
        });

        hTimeout = setTimeout(function() {
            //  Если через _timeout ms ничего не случится, кидаем ошибку.
            promise.resolve( new de.Result.Error({
                id: 'TIMEOUT',
                message: 'Timeout' // FIXME: Вменяемый текст.
            }) );
            //  И отменяем все запросы этого блока.
            //  Пока что отменяются только http-запросы.
            promise.trigger('abort');
        }, _timeout);
    }

    //  Возможность положить что-нибудь в state после выполнения блока.
    var _postselect = this.postselect;
    if (_postselect) {
        promise.then(function(result) {
            var obj = result.object();

            for (var key in _postselect) {
                state[key] = _postselect[key](obj, obj, context);
            }
        });
    }

    var _after = this.after;
    if (_after) {
        _after(params, context);
    }

    //  Если блок все-таки не закэширован, запускаем его.
    if (!isCached) {
        this._run(promise, params, context);
    }

    //  Возвращаем promise, в который потом прилетит результат.
    var _result = this.result;
    if (_result) {
        var _promise = new no.Promise();

        promise.then(function(r) {
            var obj = r.object();

            var _r = _result(obj, obj, context);

            _promise.resolve( new de.Result.Value(_r) );
        });

        return _promise;
    }

    return promise;
};

de.Block.prototype._run = function(promise, params, context) {};


//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.compile = function(block, descript, options) {

    // options = options || {};

    var compiled;
    var priority;

    switch (typeof block) {

        case 'string':

            var r;

            if (( r = /^http:\/\//.test(block) )) { // Строка начинается с 'http://' -- это http-блок.
                                                    // FIXME: Поддержка https, post, get и т.д.
                compiled = new de.Block.Http(block, descript, options);

            } else if (( r = block.match(/^(.*\(\))(\d+)?$/) )) { // Строка оканчивается на '()' -- это call-блок.
                compiled = new de.Block.Call(r[1], descript, options);
                priority = r[2];

            } else if (( r = block.match(/^(.*\.jsx)(\d+)?$/) )) { // Строка оканчивается на '.jsx' -- это include-блок.
                compiled = new de.Block.Include(r[1], descript, options);
                priority = r[2];

            } else if (( r = block.match(/^(.*\.(?:json|txt|xml))(\d+)?$/) )) { // Строка оканчивается на '.json' -- это file-блок.
                compiled = new de.Block.File(r[1], descript, options);
                priority = r[2];

            //  В предыдущих трех случаях в конце строки может быть число, означающее приоритет.
            //  Например:
            //      {
            //          common: 'common.jsx' + 25,
            //          ...
            //      }
            //
            //  В случае http-блока, приоритет нужно задавать так (потому, что число на конце может быть частью урла):
            //      {
            //          common: http('http://foo.com/bar') +25,
            //          ...
            //      }
            //
            //  Работает это за счет того, что у de.Block переопределен метод valueOf,
            //  который возвращает уникальную строку вида '@block25@'.

            } else if (( r = block.match(/^(@block\d+@)(\d+)$/) ) || ( r = block.match(/^(\d+)(@block\d+@)$/) )) { // Строка вида '@block25@45' или '45@block25@',
                                                                                                                   // где 25 это порядковый номер блока, а 45 -- приоритет.
                var id = r[1];

                compiled = _blocks[id];
                priority = r[2];

                delete _blocks[id];

            }

            break;

        case 'object':

            //  NOTE: Тут нельзя использовать (block instanceof Array) потому, что .jsx файлы эвалятся
            //  в другом контексте и там другой Array. Для справки -- util.isArray примерно в 10 раз медленнее, чем instanceof.
            if ( Array.isArray(block) ) {
                compiled = new de.Block.Array(block, descript, options);

            } else if ( block && !(block instanceof de.Block) ) {
                compiled = new de.Block.Object(block, descript, options);

            } else {
                compiled = block;

            }

            break;

        case 'function':

            compiled = new de.Block.Function(block, descript, options);

            break;

    }

    if (!compiled) {
        compiled = new de.Block.Value(block, descript, options);
    }

    if (priority) {
        compiled.priority = +priority;
    }

    return compiled;

};

//  ---------------------------------------------------------------------------------------------------------------  //

//  FIXME: Не очень подходящее название, кажется.
de.Block.prototype.fork = function(promise, params, context) {
    var worker = this.run(params, context).pipe(promise);

    promise.forward('abort', worker);
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Array
//  ---------------------------------------------------------------------------------------------------------------  //

function groupItems(items) {
    var l = items.length;
    if (!l) {
        return [ [] ];
    }

    var sorted = items.sort(function(a, b) { return b.block.priority - a.block.priority; });

    var groups = [];
    var group = [];

    var i = 0;
    var item = sorted[0];
    var next;
    while (i < l) {
        group.push(item);

        i++;
        if (i < l) {
            next = sorted[i];
            if (item.block.priority !== next.block.priority) {
                groups.push(group);
                group = [];
            }
        } else {
            groups.push(group);
            break;
        }

        item = next;
    }

    return groups;
};

de.Block.Array = function(array, descript, options) {
    this._init(descript, options);

    var items = [];
    for (var i = 0, l = array.length; i < l; i++) {
        items.push({
            index: i,
            block: de.Block.compile(array[i], descript, options)
        });
    }

    this.groups = groupItems(items);

};

no.inherit(de.Block.Array, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Array.prototype._run = function(promise, params, context) {
    var that = this;

    var results = [];
    var groups = this.groups;

    var i = 0;
    var l = groups.length;

    var workers;
    var wait;

    promise.on('abort', function() {
        //  Останавливаем run(), чтобы он не запускал больше ничего.
        i = l;

        promise.resolve(error_aborted);

        if (workers) {
            //  FIXME: Нужно ли это?
            wait.reject();

            for (var j = 0, m = workers.length; j < m; j++) {
                workers[j].trigger('abort');
            }
        }
    });

    (function run() {
        if (i < l) {
            workers = [];

            var group = groups[i];
            for (var j = 0, m = group.length; j < m; j++) {
                (function(item) {
                    var worker = item.block.run(params, context)
                        .then(function(r) {
                            results[item.index] = r;
                        });

                    workers.push(worker);
                })( group[j] );
            }

            i++;

            wait = no.Promise.wait(workers).then(run);

        } else {
            workers = null;

            promise.resolve( that._getResult(results) );
        }
    })();
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Array.prototype._getResult = function(results) {
    return new de.Result.Array(results);
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Call
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Call = function(call, descript, options) {
    this._init(descript, options);

    var r = call.match(/^(?:(.*?):)?(.*)\(\)$/);

    var module = r[1] || '';
    var method = this.method = r[2];

    module = descript.modules[module];

    call = module[method];
    this.call = (typeof call === 'function') ? call : module;
};

no.inherit(de.Block.Call, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Call.prototype._run = function(promise, params, context) {
    this.call(promise, params, context, this.descript, this.method);
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.File
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.File = function(filename, descript, options) {
    this._init(descript, options);

    this.filename = no.jpath.string(filename);
};

no.inherit(de.Block.File, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.File.prototype._run = function(promise, params, context) {
    var filename = this.resolveFilename( this.filename(params, params, context) );

    var datatype = this.datatype;
    if (!datatype) {
        var ext = path_.extname(filename);

        switch (ext) {
            case '.json':
                datatype = 'json';
                break;
        }
    }

    var files = this.descript._files;

    //  В кэше хранятся promise'ы с контентом файла (в виде Buffer'а).
    var cached = files[filename];
    if (!cached) {
        cached = files[filename] = no.de.file.get(filename);
    }

    cached
        .then(function(content) {
            no.de.file.watch('file-changed', filename);

            promise.resolve( new de.Result.Raw(content, datatype ) );
        })
        .else_(function(error) {
            files[filename] = null;

            promise.resolve( new de.Result.Error(error) );
        });
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Function
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Function = function(func, descript, options) {
    this._init(descript, options);

    this.func = func;
};

no.inherit(de.Block.Function, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Function.prototype._run = function(promise, params, context) {
    var result = this.func(context, params);

    //  FIXME: Правильные options.
    var block = new de.Block.compile(result);

    block.fork(promise, params, context);
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Http
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Http = function(url, descript, options) {
    this._init(descript, options);

    var ch = url.slice(-1);
    if (ch === '?' || ch === '&') {
        this.extend = true;
        url = url.slice(0, -1);
    }

    this.url = no.jpath.string(url);
};

no.inherit(de.Block.Http, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Http.prototype._run = function(promise, params, context) {
    var url = this.url(params, context);

    var worker = no.de.http.get(url, (this.extend) ? params : null);

    //  FIXME: Сдедать это в конструкторе или в _init?
    var datatype = this.datatype || 'json';

    worker
        .then(function(result) {
            promise.resolve( new de.Result.Raw(result, datatype) );
        })
        .else_(function(error) {
            promise.resolve( new de.Result.Error(error) );
        });

    promise.forward('abort', worker);
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Include
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Include = function(filename, descript, options) {
    this._init(descript, options);

    this.filename = no.jpath.string(filename);
};

no.inherit(de.Block.Include, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Include.prototype._run = function(promise, params, context) {
    var filename = this.resolveFilename( this.filename(params, params, context) );

    var descript = this.descript;

    var includes = descript._includes;

    var block = includes[filename];
    if (block) {
        block.fork(promise, params, context);
    }

    var that = this;
    no.de.file.load(filename, descript.sandbox)
        .then(function(include) {
            var dirname = path_.dirname(filename);

            var options = no.extend( {}, that.options, { dirname: dirname } );
            block = includes[filename] = new de.Block.compile(include, descript, options);
            no.de.file.watch('include-changed', filename);

            block.fork(promise, params, context);
        })
        .else_(function(error) {
            includes[filename] = null;
            promise.resolve( new de.Result.Error(error) );
        });
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Object
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Object = function(object, descript, options) {
    this._init(descript, options);

    var items = [];
    var keys = this.keys = [];

    var i = 0;
    for (var key in object) {
        items.push({
            index: i++,
            block: de.Block.compile(object[key], descript, options)
        });
        keys.push(key);
    }

    this.groups = groupItems(items);
};

no.inherit(de.Block.Object, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Object.prototype._run = de.Block.Array.prototype._run;

de.Block.Object.prototype._getResult = function(results) {
    var keys = this.keys;

    var r = {};

    for (var i = 0, l = results.length; i < l; i++) {
        r[ keys[i] ] = results[i];
    }

    return new de.Result.Object(r);
};


//  ---------------------------------------------------------------------------------------------------------------  //
//  de.Block.Value
//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Value = function(value, descript, options) {
    this._init(descript, options);

    this.value = value;
};

no.inherit(de.Block.Value, de.Block);

//  ---------------------------------------------------------------------------------------------------------------  //

de.Block.Value.prototype._run = function(promise, params, context) {
    //  FIXME: Нельзя ли сразу в конструкторе создать de.Result.Value?
    promise.resolve( new de.Result.Value(this.value) );
};

//  ---------------------------------------------------------------------------------------------------------------  //

module.exports = de.Block;

//  ---------------------------------------------------------------------------------------------------------------  //

