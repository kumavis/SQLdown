'use strict';
var inherits = require('inherits');
var knex = require('knex');
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;
var Iter = require('./iterator');
var fs = require('fs');
var Promise = require('bluebird');
var url = require('url');
var TABLENAME = 'sqldown';
module.exports = SQLdown;
function parseConnectionString(string) {
  if (process.browser) {
    return {
      client: 'websql'
    };
  }
  var parsed = url.parse(string);
  var protocol = parsed.protocol;
  if(protocol === null) {
    return {
      client:'sqlite3',
      connection: {
        filename: string
      }
    };
  }
  if (protocol.slice(-1) === ':') {
    protocol = protocol.slice(0, -1);
  }
  return {
    client: protocol,
    connection: string
  };
}
function getTableName (location, options) {
  if (process.browser) {
    return location;
  }
  var parsed = url.parse(location, true).query;
  return parsed.table || options.table || TABLENAME;
}
// constructor, passes through the 'location' argument to the AbstractLevelDOWN constructor
// our new prototype inherits from AbstractLevelDOWN
inherits(SQLdown, AbstractLevelDOWN);

function SQLdown(location) {
  if (!(this instanceof SQLdown)) {
    return new SQLdown(location);
  }
  AbstractLevelDOWN.call(this, location);
  this.db = this.counter = this.compactFreq = this.tablename = void 0;
}
SQLdown.destroy = function (location, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  var conn = parseConnectionString(location);
  if (conn.client === 'sqlite3') {
    fs.unlink(location, callback);
    return;
  }
  var db = knex(conn);
  db.schema.dropTableIfExists(getTableName(location, options)).then(function () {
    return db.destroy();
  }).exec(callback);
};


SQLdown.prototype._open = function (options, callback) {
  var self = this;
  this.db = knex(parseConnectionString(this.location));
  this.tablename = getTableName(this.location, options);
  this.compactFreq = options.compactFrequency || 5;
  this.counter = 0;
  this.db.schema.hasTable(this.tablename).then(function (exists) {
      if (!exists) {
        return self.db.schema.createTable(self.tablename, function (table) {
          table.increments('id').primary().index();
          table.text('key').index();
          table.text('value').index();
        });
      }
    })
    .nodeify(callback);
};

SQLdown.prototype._get = function (key, options, cb) {
  var self = this;
  var asBuffer = true;
  if (options.asBuffer === false) {
    asBuffer = false;
  }
  if (options.raw) {
    asBuffer = false;
  }
  this.db.select('value').from(this.tablename).whereIn('id', function (){
    this.max('id').from(self.tablename).where({key:key});
  }).exec(function (err, res) {
    if (err) {
      return cb(err.stack);
    }
    if (!res.length) {
      return cb(new Error('NotFound'));
    }
    try {
      var value = JSON.parse(res[0].value);
      if (asBuffer) {
        value = new Buffer(value);
      }
      cb(null, value);
    } catch (e) {
      cb(new Error('NotFound'));
    }
  });
};
SQLdown.prototype._put = function (key, rawvalue, opt, cb) {
  var self = this;
  if (!this._isBuffer(rawvalue) && process.browser  && typeof rawvalue !== 'object') {
    rawvalue = String(rawvalue);
  }
	var value = JSON.stringify(rawvalue);
  this.db(this.tablename).insert({
    key: key,
    value:value
  }).then(function () {
    return self.maybeCompact();
  }).nodeify(cb);
};
SQLdown.prototype._del = function (key, opt, cb) {
  this.db(this.tablename).where({key: key}).delete().exec(cb);
};
SQLdown.prototype._batch = function (array, options, callback) {
  var self = this;
  this.db.transaction(function (trx) {
    return Promise.all(array.map(function (item) {
      if (item.type === 'del') {
        return self.db(self.tablename).transacting(trx).where({key: item.key}).delete();
      } else {
        return trx.insert({
          key: item.key,
          value:JSON.stringify(item.value)
        }).into(self.tablename);
      }
    }));
  }).then(function () {
    return self.maybeCompact();
  }).nodeify(callback);
};
SQLdown.prototype.compact = function () {
  var sub = this.db.max('id').from(this.tablename).as('temp1').groupBy('key');
  return this.db(this.tablename).not.whereIn('id', function () {
    this.select('id').from(sub);
  }).delete();
};
SQLdown.prototype.maybeCompact = function () {
  this.counter++;
  this.counter %= this.compactFreq;
  if (this.counter) {
    return Promise.resolve();
  } else {
    return this.compact();
  }
};
SQLdown.prototype._close = function (callback) {
  var self = this;
  process.nextTick(function () {
    self.db.destroy().exec(callback);
  });
};

SQLdown.prototype.iterator = function (options) {
  return new Iter(this, options);
};
