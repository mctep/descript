var de = require('./de.js');

var no = require('nommon');

var path_ = require('path');
var vm_ = require('vm');

//  ---------------------------------------------------------------------------------------------------------------  //

de.parseCookies = function(cookie) {
    var cookies = {};

    var parts = cookie.split(';');
    for (var i = 0, l = parts.length; i < l; i++) {
        var r = parts[i].match(/^\s*([^=]+)=(.*)$/);
        if (r) {
            cookies[ r[1] ] = r[2];
        }
    }

    return cookies;
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.duration = function(s) {
    if (typeof s === 'number') {
        return s;
    }

    var parts = s.split(/(\d+)([dhms])/);
    var d = 0;

    for (var i = 0, l = parts.length; i < l; i += 3) {
        var n = +parts[i + 1];

        switch (parts[i + 2]) {
            case 'd':
                d += n * (60 * 60 * 24);
                break;
            case 'h':
                d += n * (60 * 60);
                break;
            case 'm':
                d += n * (60);
                break;
            case 's':
                d += n;
                break;
        }
    }

    return d * 1000;
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.eval = function(js, namespace, sandbox, filename) {
    //  FIXME: Таки пострелять в оба вариант.
    //  Вроде в 0.10.2 разница в пределах погрешности измерения.
    //  Если это действительно так, то лучше использовать vm.

    var sb = {};
    if (namespace && sandbox) {
        sb[namespace] = sandbox;
    }

    //  Прокидываем в песочницу для удобства:
    if (filename) {
        var dirname = path_.dirname( path_.resolve(filename) );
        sb.require = function(filename) {
            if ( filename.charAt(0) === '.' ) {
                return require( path_.resolve(dirname, filename) );
            } else {
                return require(filename);
            }
        };
    } else {
        sb.require = require;
    }
    sb.console = console;
    //  Array нужен, чтобы правильно работал instanceof Array.
    //  FIXME: Лучше бы везде заменить на Array.isArray.
    //  sb.Array = Array;

    return vm_.runInNewContext('(' + js + ')', sb);
    /*
    */

    /*
    if (namespace) {
        return Function( namespace, 'global', '"use strict"; return (' + js + ');' )(sandbox);
    } else {
        return Function( 'global', '"use strict"; return (' + js + ');' )();
    }
    */
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.error = function(error) {
    return new de.Result.Error(error);
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.forward = function(src, dest) {
    src.pipe(dest);
    dest.forward('abort', src);
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.mime = function(headers) {
    var s = headers['content-type'];

    var i = s.indexOf(';');
    return (i === -1) ? s : s.substr(0, i);
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.events = no.extend( {}, no.Events );

//  ---------------------------------------------------------------------------------------------------------------  //

var pid = process.pid;
var gid = 0;

de.id = function() {
    return pid + '.' + gid++;
};

