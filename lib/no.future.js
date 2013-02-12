var no = require('nommon');

//  ---------------------------------------------------------------------------------------------------------------  //

no.Future = function() {};

no.Future.prototype.run = function(params, context) {
    if (this.before) {
        var r = this.before(params, context);

        if (r !== undefined) {
            return (new no.Promise() ).resolve(r);
        }
    }

    var that = this;

    var promise = this._run(params, context);

    promise.then(function(result) {
        if (that.after) {
            var r = that.after(params, context, result);

            if (r !== undefined) {
                return promise.resolve(r);
            }
        }

        promise.resolve(result);
    });

    return promise;
};

//  ---------------------------------------------------------------------------------------------------------------  //

no.Future.Function = function(future) {
    this.future = future;
};

no.inherit(no.Future.Function, no.Future);

no.Future.Function.prototype._run = function(params, context) {
    return this.future(params, context);
};

//  ---------------------------------------------------------------------------------------------------------------  //

no.Future.Array = function(array) {
    this._nofuture_init(array);
};

no.inherit(no.Future.Array, no.Future);

no.Future.Array.prototype._nofuture_init = function(array) {
    var items = [];
    for (var i = 0, l = array.length; i < l; i++) {
        items.push({
            index: i,
            future: array[i]
        });
    }

    this._nofuture_groups = groupItems(items);
};

function groupItems(items) {
    var l = items.length;
    if (!l) {
        return [];
    }

    var sorted = items.sort( function(a, b) { return b.future.priority - a.future.priority; } );

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
            if (item.future.priority !== next.future.priority) {
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

de.Future.Array.prototype._run = function(promise, params, context) {
    var that = this;

    var results = [];
    var groups = this._nofuture_groups;

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

            promise.resolve( that._nofuture_result(results) );
        }
    })();
};

//  ---------------------------------------------------------------------------------------------------------------  //

de.Future.Array.prototype._nofuture_result = function(results) {
    return results;
};
//  ---------------------------------------------------------------------------------------------------------------  //

no.Future.Object = function(object) {
    this._nofuture_init(object);
};

no.inherit(no.Future.Object, no.Future);

de.Future.Object.prototype._nofuture_init = function(object) {
    var items = [];
    var keys = [];
    for (var key in object) {
        items.push( object[key] );
        keys.push(key);
    }

    this._nofuture_groups = groupItems(items);
    this._nofuture_keys = keys;
};

de.Future.Object.prototype._nofuture_result = function(results) {
    //  TODO: ...
};

//  ---------------------------------------------------------------------------------------------------------------  //

no.future = function(future) {
    switch (typeof future) {
        case 'function':
            return new no.Future(future);

        case 'object':
            //  FIXME: Обработать null.

            if ( Array.isArray(future) ) {
                return new no.Future.Array(future);
            } else {
                return new no.Future.Object(future);
            }

        default:
            //  TODO: Сделать no.Future.Value?
    }
};

//  ---------------------------------------------------------------------------------------------------------------  //

//  TODO: Или no.Future.prototype.withParams()
//
no.Future.prototype.setParams = function(params) {
    return new no.Future.Curry(this, params);
};

no.Future.Curry = function(future, params) {
    this.future = future;
    this.params = params;
};

no.inherit(no.Future.Curry, no.Future);

no.Future.Curry.prototype._run = function(params, context) {
    return this.future.run(this.params, context);
};

//  ---------------------------------------------------------------------------------------------------------------  //

