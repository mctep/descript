var no = require('nommon');

var de = require('./de.js');
require('./de.common.js');
require('./de.result.js');

//  ---------------------------------------------------------------------------------------------------------------  //

var url_ = require('url');
var http_ = require('http');

//  ---------------------------------------------------------------------------------------------------------------  //

de.http = {};

// ----------------------------------------------------------------------------------------------------------------- //

de.http.get = function(url, params, headers, context) {

    var options = url_.parse(url, true, true);

    if (params) {
        //  NOTE: Оказывается, http.request не смотрит на параметр query,
        //  а смотрит только на path. Поэтому приходится формировать новый path.
        options.path = url_.format({
            pathname: options.pathname,
            query: no.extend(options.query, params)
        });
    }

    options.headers = headers;

    var req;
    var promise = new no.Promise();

    promise.on('abort', function() {
        req.abort();
    });

    var full_path = '[http ' + JSON.stringify('http://' + options.host + options.path) + '] ';

    var t1 = Date.now();
    promise.done(function() {
        context.log_end('info', full_path + 'ended', t1);
    });
    promise.fail(function() {
        context.log_end('info', full_path + 'failed', t1);
    });

    getHttp(options, 0);

    return promise;

    function getHttp(options, count) {

        req = http_.request(options, function(res) {
            var result = new de.Result.Http(res.headers);

            var status = res.statusCode;

            var error;
            switch (status) {
                //  TODO: Кэшировать 301 запросы.
                case 301:
                case 302:
                    //  FIXME: А это нельзя вынести повыше?
                    res.resume();

                    // FIXME: MAX_REDIRECTS.
                    if (count > 3) {
                        context.error('Too many redirects');
                        return promise.reject( de.error({
                            'id': 'HTTP_TOO_MANY_REDIRECTS'
                        }) );
                    }

                    var location = res.headers['location'] || '';
                    location = url_.resolve(options.href, location);
                    options = url_.parse(location, true, true);

                    context.debug(full_path + 'redirected to ' + location);
                    return getHttp(options, count + 1);

                case 400:
                case 403:
                case 404:
                case 500:
                case 503:
                case 504:
                    res.resume();

                    context.error(full_path + 'error ' + status);
                    return promise.reject( de.error({
                        'id': 'HTTP_' + status,
                        'message': http_.STATUS_CODES[status]
                    }) );

                default:
                    //  FIXME: Кидать ошибку?
            }

            res.on('data', function(data) {
                result.data(data);
            });
            res.on('end', function() {
                result.end();
                promise.resolve(result);
            });
            res.on('close', function(error) {
                context.error(full_path + 'error ' + error.message);
                promise.reject( de.error({
                    'id': 'HTTP_CONNECTION_CLOSED',
                    'message': error.message
                }) );
            });
        });

        req.on('error', function(error) {
            context.error(full_path + 'error ' + error.message);
            promise.reject( de.error({
                'id': 'HTTP_UNKNOWN_ERROR',
                'message': error.message
            }) );
        });

        req.end();
    }

};

//  ---------------------------------------------------------------------------------------------------------------  //
