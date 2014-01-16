var http = require('http');
var dns = require('dns');
var url  = require('url');
var clone  = require('clone');
var httpProxy = require('http-proxy');
var proxy = new httpProxy.RoutingProxy();
var redis  = require('redis'),
    client = redis.createClient(6379, '127.0.0.1', {detect_buffers: true});
var events = require('events'),
    eventEmitter = new events.EventEmitter();


function computeKey(host, path, method) {
    return method + ':' + host + ':' + path;
}

function makeKeyField(key, prefix) {
    return prefix + ':' + key;
}

function getHeadersKey(key) {
    return makeKeyField(key, 'headers');
}

function getBodyKey(key) {
    return makeKeyField(key, 'body');
}

function canStore(statusCode, headers) {
    // Do not cache 304 response to conditional requests
    if( isConditional(headers) && statusCode == 304 ) {
        return false;
    }

    // rules are
    // if not private
    // and not no-store nor no cache
    // then use the value in this order
    // s-maxage
    // max-age
    // expires
    // Exceptions are 
    // must-revalidate
    // proxy-revalidate

    if( headers['cache-control'] === undefined ) {
        return false;
    }

    var params = headers['cache-control'].trim().split(',');

    var values = {};

    for(idx in params) {
        if( params[idx].indexOf('=') !== -1 ) {
            var parts = params[idx].trim().split('=');
            key = parts[0].trim();
            val = parts[1].trim();
            if( key == 's-maxage' || key == 'max-age' ) {
                val = parseInt(val);
            }
            values[ key ] = val;
        } else {
            values[ params[idx].trim() ] = 1;
        }
    }
    
    if( 
        values['private'] !== undefined ||
        values['no-cache'] !== undefined ||
        values['no-store'] !== undefined 
    ) {
        // Do not cache
        return false;
    }

    if( values['s-maxage'] !== undefined ) {
        return values['s-maxage'];
    }
    else if( values['max-age'] !== undefined ) {
        return values['max-age'];
    }
    
    return false;
}

function isNotModified(req, resp) {
    if( req['if-modified-since'] !== undefined 
        && resp['last-modified'] !== undefined ) {
        var condDate = new Date(req['if-modified-since']);
        var lastModified = new Date(resp['last-modified']);
        return condDate > lastModified;
    }
    return false;
}

function isConditional(req) {

    if( req['if-modified-since'] !== undefined
    || req['if-none-match'] !== undefined ) {
        return true;
    }
    return false;
}

function isBinary(headers) {
    var binary = false;

    if( headers['content-type'] !== undefined ) {
        var contentParts = headers['content-type'].split(';');
        var contentType = contentParts[0].split('/');
        if(contentType[0] == 'image') {
            binary = true;
        }
    }

    return binary;
}


var cacheResponse = function cacheResponse(cacheKey, proxyResponse, cacheIt) {
    
    if( cacheIt ) {
        var headersKey = getHeadersKey(cacheKey);
        var bodyKey = getBodyKey(cacheKey);

        client.hset(headersKey, 'statusCode', proxyResponse.statusCode);
        client.hset(headersKey, 'headers', JSON.stringify(proxyResponse.headers));
        client.expire(headersKey, cacheIt.toString());

        client.del(bodyKey);
    }
    
}

var cacheContent = function cacheContent(cacheKey, cacheIt, chunk) {
    if( cacheIt ) {
        var bodyKey = getBodyKey(cacheKey);
        client.append(bodyKey, chunk);
    }
}

var expireContent = function expireContent(cacheKey, cacheIt) {
    if( cacheIt ) {
        var bodyKey = getBodyKey(cacheKey);
        client.expire(bodyKey, cacheIt);
    }
}

function getHost(headers)
{
  var parts = headers['host'].trim().split(':');
  return parts[0].trim();
}

function getPort(headers)
{
  var parts = headers['host'].trim().split(':');
  return (parts[1] || '80').trim();
}

var doRequest = function doRequest(req, res, cacheKey) {

  var host = getHost(req.headers);
  var port = getPort(req.headers);

  dns.lookup(host, function (err, addresses) {
    if (err) throw err;

    if( addresses == serverHostname && port == serverPort ) {
        // better stop now to avoid request loop
        res.writeHead(400, {});
        res.end();
    }
  });
  
  delete req.headers['host'];

  var proxyRequest = http.request({
    // Disable connection pooling
    //'agent': false,
    'method': req.method,
    'hostname': host,
    'port': port,
    //'headers': req.headers,
    'path': req.url
  }, function(proxyResponse) {
    
    var headers = clone(proxyResponse.headers);
    headers['x-cache'] = 'MISS';

    var cacheIt = canStore(proxyResponse.statusCode, proxyResponse.headers);

    eventEmitter.emit('cacheResponse', cacheKey, proxyResponse, cacheIt);

    var encoding = 'utf8';
    
    res.writeHead(proxyResponse.statusCode, headers);
    

    if( isBinary(headers) ) {
        encoding = 'binary';
        proxyResponse.setEncoding(encoding);
    }
    else {
    }
    
    proxyResponse.on('data', function (chunk) {
        res.write(chunk, encoding);
        eventEmitter.emit('cacheContent', cacheKey, cacheIt, chunk);
    });

    proxyResponse.on('end', function(){
        eventEmitter.emit('expireContent', cacheKey, cacheIt);
        res.end();
    });

  });

  proxyRequest.end();
}

var server = http.createServer(function (req, res) {

  var cacheKey = computeKey(req.headers['host'], req.url, req.method);
  
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
      client.hgetall(getHeadersKey(cacheKey), function(err, results) {
        
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


})

server.on('error', function(err){
    console.log(err);
});

var serverPort = 80, 
serverHostname = '0.0.0.0';

if( process.argv.length > 2 ) {
    serverHostname = process.argv[2];
}

if( process.argv.length > 3 ) {
    serverPort = process.argv[3];
}

console.log('Running on http://'+serverHostname+':'+serverPort+'/');
server.listen(serverPort, serverHostname);

eventEmitter.on('doRequest', doRequest);
eventEmitter.on('cacheResponse', cacheResponse);
eventEmitter.on('cacheContent', cacheContent);
eventEmitter.on('expireContent', expireContent);


console.log('Server running at http://'+serverHostname+':'+serverPort+'/');


