
'use strict';

/*
 * This module handles all IO called on the cache (currently Redis)
 */

var url = require('url'),
    redis = require('redis');


function HttpCache(config) {
    if (!(this instanceof HttpCache)) {
        return new HttpCache(config);
    }

    this.config = config;
    // Configure Redis
    this.redisClient = redis.createClient(
            this.config.redisPort,
            this.config.redisHost
            );
    
    this.redisClient.on('error', function (err) {
        this.log('RedisError ' + err);
    }.bind(this));

}

HttpCache.prototype.makeKeyField = function(key, prefix) {
    return prefix + ':' + key;
};

HttpCache.prototype.getHeadersKey = function(key) {
    return this.makeKeyField(key, 'headers');
};

HttpCache.prototype.getBodyKey = function(key) {
    return this.makeKeyField(key, 'body');
};

HttpCache.prototype.computeKey = function (host, path, method) {
	return method + ':' + host + ':' + path;
};
HttpCache.prototype.getHost = function (headers) {
  var parts = headers['host'].trim().split(':');
  return parts[0].trim();
};

HttpCache.prototype.getPort = function (headers) {
  var parts = headers['host'].trim().split(':');
  return (parts[1] || '80').trim();
};

HttpCache.prototype.canCached = function (req, res) {
  if( (req.headers['cache-control'] !== undefined 
    && req.headers['cache-control'] == 'no-cache')
    || (req.method != 'GET' && req.method != 'HEAD' )
  )return false;
  return true;
 };

HttpCache.prototype.checkCache = function (req, res) {
	var cacheKey = this.computeKey(req.headers['host'], req.url, req.method);
	console.log("HttpCache:", cacheKey);
  if( (req.headers['cache-control'] !== undefined 
    && req.headers['cache-control'] == 'no-cache')
    || (req.method != 'GET' && req.method != 'HEAD' )
  ) {
    // Force request
    var host = getHost(req.headers);
    var port = getPort(req.headers);
    console.log('proxying request without storing');
    proxy.proxyRequest(req, res, {
        host: host,
        port: port
    });
  } else {
      client.hgetall(this.getHeadersKey(cacheKey), function(err, results) {
        
        if( results !== null ) {
            var headers = JSON.parse(results['headers']);
            headers['x-cache'] = 'HIT';

            if( isNotModified(req.headers, headers) ) {
                // answer to conditional requests
                headers['content-length'] = 0;
                res.writeHead(304, headers);
                res.end();
            }
            else {

                if( req.method == 'HEAD') {
                    res.end();
                } else {
                    var binary = isBinary(headers);
                    var encoding = binary ? 'binary' : 'utf8';

                    res.writeHead(results['statusCode'], headers);

                    client.get(getBodyKey(cacheKey), function(err, reply) {
                        res.write(reply, encoding);
                        res.end();
                    });
                }

            }
        } else {

          eventEmitter.emit('doRequest', req, res, cacheKey);

        }

      });
  }	
};

HttpCache.prototype.getDomainName = function (hostname) {
    var idx = hostname.lastIndexOf('.');

    if (idx < 0) {
        return hostname;
    }
    idx = hostname.lastIndexOf('.', idx - 1);
    if (idx < 0) {
        return hostname;
    }
    return hostname.substr(idx);
};

module.exports = HttpCache;
