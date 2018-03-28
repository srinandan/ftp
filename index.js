'use strict';

var debug = require('debug')('plugin:oauth');
var url = require('url');
var rs = require('jsrsasign');
var fs = require('fs');
var path = require('path');
var cache = require('memored');
var map = require('memored');
var JWS = rs.jws.JWS;
var requestLib = require('request');
var _ = require('lodash');

const authHeaderRegex = /Bearer (.+)/;
const PRIVATE_JWT_VALUES = ['application_name', 'client_id', 'api_product_list', 'iat', 'exp'];
const SUPPORTED_DOUBLE_ASTERIK_PATTERN = "**";
const SUPPORTED_SINGLE_ASTERIK_PATTERN = "*";
const SUPPORTED_SINGLE_FORWARD_SLASH_PATTERN = "/";

const acceptAlg = ['RS256'];

var acceptField = {};
acceptField.alg = acceptAlg;

var productOnly;
var cacheKey = false;

var tokenCache = false;
map.setup({
    purgeInterval: 10000
});

var tokenCacheSize = 100;

module.exports.init = function(config, logger, stats) {

    var request = config.request ? requestLib.defaults(config.request) : requestLib;
    var keys = config.jwk_keys ? JSON.parse(config.jwk_keys) : null;

    var middleware = function(req, res, next) {

        var authHeaderName = config['authorization-header'] ? config['authorization-header'] : 'authorization';
        var apiKeyHeaderName = config['api-key-header'] ? config['api-key-header'] : 'x-api-key';
        var keepAuthHeader = config['keep-authorization-header'] || false;
        cacheKey = config['cacheKey'] || false;
        //set grace period
        var gracePeriod = config['gracePeriod'] || 0;
        acceptField.gracePeriod = gracePeriod;
        //support for enabling oauth or api key only
        var oauth_only = config['allowOAuthOnly'] || false;
        var apikey_only = config['allowAPIKeyOnly'] || false;
        //
        var apiKey;
        //this flag will enable check against resource paths only
        productOnly = config['productOnly'] || false;
        //token cache settings
        tokenCache = config['tokenCache'] || false;
        tokenCacheSize = config['tokenCacheSize'] || 100;
        //
        //support for enabling oauth or api key only
        if (oauth_only) {
            if (!req.headers[authHeaderName]) {
                if (config.allowNoAuthorization) {
                    return next();
                } else {
                    debug('missing_authorization');
                    return sendError(req, res, next, logger, stats, 'missing_authorization', 'Missing Authorization header');
                }
            } else {
                var header = authHeaderRegex.exec(req.headers[authHeaderName]);
                if (!header || header.length < 2) {
                    debug('Invalid Authorization Header');
                    return sendError(req, res, next, logger, stats, 'invalid_request', 'Invalid Authorization header');
                }
            }
        } else if (apikey_only) {
            if (!req.headers[apiKeyHeaderName]) {
                debug('missing api key');
                return sendError(req, res, next, logger, stats, 'invalid_authorization', 'Missing API Key header');
            }
        }

        //leaving rest of the code same to ensure backward compatibility
        if (!req.headers[authHeaderName] || config.allowAPIKeyOnly) {
            if (apiKey = req.headers[apiKeyHeaderName]) {
                exchangeApiKeyForToken(req, res, next, config, logger, stats, middleware, apiKey);
            } else if (req.reqUrl && req.reqUrl.query && (apiKey = req.reqUrl.query[apiKeyHeaderName])) {
                exchangeApiKeyForToken(req, res, next, config, logger, stats, middleware, apiKey);
            } else if (config.allowNoAuthorization) {
                return next();
            } else {
                debug('missing_authorization');
                return sendError(req, res, next, logger, stats, 'missing_authorization', 'Missing Authorization header');
            }
        } else {
            var header = authHeaderRegex.exec(req.headers[authHeaderName]);
            if (!config.allowInvalidAuthorization) {
                if (!header || header.length < 2) {
                    debug('Invalid Authorization Header');
                    return sendError(req, res, next, logger, stats, 'invalid_request', 'Invalid Authorization header');
                }
            }

            if (!keepAuthHeader) {
                delete(req.headers[authHeaderName]); // don't pass this header to target
            }

            var token = '';
            if (header) {
                token = header[1];
            }
            verify(token, config, logger, stats, middleware, req, res, next);
        }
    }

    var exchangeApiKeyForToken = function(req, res, next, config, logger, stats, middleware, apiKey) {
        var cacheControl = req.headers['cache-control'];
        if (cacheKey || (!cacheControl || (cacheControl && cacheControl.indexOf('no-cache') < 0))) { // caching is allowed
            cache.read(apiKey, function(err, value) {
                if (value) {
                    if (Date.now() / 1000 < value.exp) { // not expired yet (token expiration is in seconds)
                        debug('api key cache hit', apiKey);
                        return authorize(req, res, next, logger, stats, value);
                    } else {
                        cache.remove(apiKey);
                        debug('api key cache expired', apiKey);
                        requestApiKeyJWT(req, res, next, config, logger, stats, middleware, apiKey);
                    }
                } else {
                    debug('api key cache miss', apiKey);
                    requestApiKeyJWT(req, res, next, config, logger, stats, middleware, apiKey);
                }
            });
        } else {
            requestApiKeyJWT(req, res, next, config, logger, stats, middleware, apiKey);
        }

    }

    function requestApiKeyJWT(req, res, next, config, logger, stats, middleware, apiKey) {

        if (!config.verify_api_key_url) return sendError(req, res, next, logger, stats, 'invalid_request', 'API Key Verification URL not configured');

        var api_key_options = {
            url: config.verify_api_key_url,
            method: 'POST',
            json: {
                'apiKey': apiKey
            },
            headers: {
                'x-dna-api-key': apiKey
            }
        };

        if (config.agentOptions) {
            if (config.agentOptions.requestCert) {
                api_key_options.requestCert = true;
                if (config.agentOptions.cert && config.agentOptions.key) {
                    api_key_options.key = fs.readFileSync(path.resolve(config.agentOptions.key), 'utf8');
                    api_key_options.cert = fs.readFileSync(path.resolve(config.agentOptions.cert), 'utf8');
                    if (config.agentOptions.ca) api_key_options.ca = fs.readFileSync(path.resolve(config.agentOptions.ca), 'utf8');
                } else if (config.agentOptions.pfx) {
                    api_key_options.pfx = fs.readFileSync(path.resolve(config.agentOptions.pfx));
                }
                if (config.agentOptions.rejectUnauthorized) {
                    api_key_options.rejectUnauthorized = true;
                }
                if (config.agentOptions.secureProtocol) {
                    api_key_options.secureProtocol = true;
                }
                if (config.agentOptions.ciphers) {
                    api_key_options.ciphers = config.agentOptions.ciphers;
                }
                if (config.agentOptions.passphrase) api_key_options.passphrase = config.agentOptions.passphrase;
            }
        }
        //debug(api_key_options);
        request(api_key_options, function(err, response, body) {
            if (err) {
                debug('verify apikey gateway timeout');
                return sendError(req, res, next, logger, stats, 'gateway_timeout', err.message);
            }
            if (response.statusCode !== 200) {
                debug('verify apikey access_denied');
                return sendError(req, res, next, logger, stats, 'access_denied', response.statusMessage);
            }
            verify(body, config, logger, stats, middleware, req, res, next, apiKey);
        });
    }

    var verify = function(token, config, logger, stats, middleware, req, res, next, apiKey) {

        var isValid = false;
        var oauthtoken = token && token.token ? token.token : token;
        var decodedToken = JWS.parse(oauthtoken);
        if (tokenCache == true) {
            debug('token caching enabled')
            map.read(oauthtoken, function(err, tokenvalue) {
                if (!err && tokenvalue != undefined && tokenvalue != null && tokenvalue == oauthtoken) {
                    debug('found token in cache');
                    isValid = true;
                    if (ejectToken(decodedToken.payloadObj.exp)) {
                        debug('ejecting token from cache');
                        map.remove(oauthtoken);
                    }
                } else {
                    debug('token not found in cache');
                    if (keys) {
                        debug('using jwk');
                        var pem = getPEM(decodedToken, keys);
                        isValid = JWS.verifyJWT(oauthtoken, pem, acceptField);
                    } else {
                        debug('validating jwt');
                        isValid = JWS.verifyJWT(oauthtoken, config.public_key, acceptField);
                    }
                }
                if (!isValid) {
                    debug('token is not valid');
                    if (config.allowInvalidAuthorization) {
                        console.warn('ignoring err', err);
                        return next();
                    } else {
                        debug('invalid token');
                        return sendError(req, res, next, logger, stats, 'invalid_token');
                    }
                } else {
                    if (tokenvalue == null || tokenvalue == undefined) {
                        map.size(function(err, sizevalue) {
                            if (!err && sizevalue != null && sizevalue < 100) {
                                map.store(oauthtoken, oauthtoken);
                            } else {
                                debug('too many tokens in cache; ignore storing token');
                            }
                        });
                    }
                    authorize(req, res, next, logger, stats, decodedToken.payloadObj, apiKey);
                }
            });
        } else {
            if (keys) {
                var pem = getPEM(decodedToken, keys);
                isValid = JWS.verifyJWT(oauthtoken, pem, acceptField);
            } else {
                isValid = JWS.verifyJWT(oauthtoken, config.public_key, acceptField);
            }
            if (!isValid) {
                if (config.allowInvalidAuthorization) {
                    console.warn('ignoring err', err);
                    return next();
                } else {
                    debug('invalid token');
                    return sendError(req, res, next, logger, stats, 'invalid_token');
                }
            } else {
                authorize(req, res, next, logger, stats, decodedToken.payloadObj, apiKey);
            }
        }
    };

    return {

        onrequest: function(req, res, next) {
            middleware(req, res, next);
        }
    };

    function authorize(req, res, next, logger, stats, decodedToken, apiKey) {
        if (checkIfAuthorized(config, req.reqUrl.path, res.proxy, decodedToken)) {
            req.token = decodedToken;

            var authClaims = _.omit(decodedToken, PRIVATE_JWT_VALUES);
            req.headers['x-authorization-claims'] = new Buffer(JSON.stringify(authClaims)).toString('base64');

            if (apiKey) {
                var cacheControl = req.headers['cache-control'];
                if (cacheKey || (!cacheControl || (cacheControl && cacheControl.indexOf('no-cache') < 0))) { // caching is allowed
                    // default to now (in seconds) + 30m if not set
                    decodedToken.exp = decodedToken.exp || +(((Date.now() / 1000) + 1800).toFixed(0));
                    //apiKeyCache[apiKey] = decodedToken;
                    cache.store(apiKey, decodedToken);
                    debug('api key cache store', apiKey);
                } else {
                    debug('api key cache skip', apiKey);
                }
            }
            next();
        } else {
            return sendError(req, res, next, logger, stats, 'access_denied');
        }
    }

}

// from the product name(s) on the token, find the corresponding proxy
// then check if that proxy is one of the authorized proxies in bootstrap
const checkIfAuthorized = module.exports.checkIfAuthorized = function checkIfAuthorized(config, urlPath, proxy, decodedToken) {

    var parsedUrl = url.parse(urlPath);
    //
    debug('product only: ' + productOnly);
    //

    if (!decodedToken.api_product_list) {
        debug('no api product list');
        return false;
    }

    return decodedToken.api_product_list.some(function(product) {

        const validProxyNames = config.product_to_proxy[product];

        if (!productOnly) {
            if (!validProxyNames) {
                debug('no proxies found for product');
                return false;
            }
        }


        const apiproxies = config.product_to_api_resource[product];

        var matchesProxyRules = false;
        if (apiproxies && apiproxies.length) {
            apiproxies.forEach(function(tempApiProxy) {
                if (matchesProxyRules) {
                    //found one
                    debug('found matching proxy rule');
                    return;
                }

                urlPath = parsedUrl.pathname;
                const apiproxy = tempApiProxy.includes(proxy.base_path) ?
                    tempApiProxy :
                    proxy.base_path + (tempApiProxy.startsWith("/") ? "" : "/") + tempApiProxy
                if (apiproxy.endsWith("/") && !urlPath.endsWith("/")) {
                    urlPath = urlPath + "/";
                }

                if (apiproxy.includes(SUPPORTED_DOUBLE_ASTERIK_PATTERN)) {
                    const regex = apiproxy.replace(/\*\*/gi, ".*")
                    matchesProxyRules = urlPath.match(regex)
                } else {
                    if (apiproxy.includes(SUPPORTED_SINGLE_ASTERIK_PATTERN)) {
                        const regex = apiproxy.replace(/\*/gi, "[^/]+");
                        matchesProxyRules = urlPath.match(regex)
                    } else {
                        // if(apiproxy.includes(SUPPORTED_SINGLE_FORWARD_SLASH_PATTERN)){
                        // }
                        matchesProxyRules = urlPath == apiproxy;

                    }
                }
            })

        } else {
            matchesProxyRules = true
        }

        debug("matches proxy rules: " + matchesProxyRules);
        //add pattern matching here
        if (!productOnly)
            return matchesProxyRules && validProxyNames.indexOf(proxy.name) >= 0;
        else
            return matchesProxyRules;
    });
}

function getPEM(decodedToken, keys) {
    var i = 0;
    debug('jwk kid ' + decodedToken.headerObj.kid);
    for (; i < keys.length; i++) {
        if (keys.kid == decodedToken.headerObj.kid) {
            break;
        }
    }
    var publickey = rs.KEYUTIL.getKey(keys.keys[i]);
    return rs.KEYUTIL.getPEM(publickey);
}

function ejectToken(expTimestamp) {
    var currentTimestampInSeconds = new Date().getTime() / 1000;
    var timeDifferenceInSeconds = (expTimestamp - currentTimestampInSeconds);

    if (Math.abs(timeDifferenceInSeconds) <= parseInt(acceptField.gracePeriod)) {
        return true;
    } else {
        return false;
    }
}

function sendError(req, res, next, logger, stats, code, message) {

    switch (code) {
        case 'invalid_request':
            res.statusCode = 400;
            break;
        case 'access_denied':
            res.statusCode = 403;
            break;
        case 'invalid_token':
        case 'missing_authorization':
        case 'invalid_authorization':
            res.statusCode = 401;
            break;
        case 'gateway_timeout':
            res.statusCode = 504;
            break;
        default:
            res.statusCode = 500;
    }

    var response = {
        error: code,
        error_description: message
    };

    debug('auth failure', res.statusCode, code, message ? message : '', req.headers, req.method, req.url);
    logger.error({
        req: req,
        res: res
    }, 'oauth');

    if (!res.finished) res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
    stats.incrementStatusCount(res.statusCode);
    next(code, message);
    return code;
}
