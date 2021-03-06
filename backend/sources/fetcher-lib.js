// ---------------------------------------

if (require.main === module)
	throw (new Error ());

// ---------------------------------------

var http = require ("http");
var url = require ("url");

var configuration = require ("./configuration");
var store = require ("./store-lib")
var transcript = require ("./transcript") (module, configuration.libTranscriptLevel);

// ---------------------------------------

function _fetch (_url, _context, _callback) {
	var _task = {};
	_task.url = _url;
	_task.context = _context;
	_task.callback = _callback;
	_task.type = configuration.fetchTaskType;
	_task.feedKey = store.generateFeedKey (_task.url);
	_task.taskKey = store.generateFeedTaskKey (_task.url, _task.type);
	_task.acceptContentType = "application/atom+xml; charset=utf-8; q=1, application/rss+xml; charset=utf-8; q=0.5";
	_doFetchStep1 (_task);
}

function _doFetchStep1 (_task) {
	transcript.traceDebugging ("fetching `%s` step 1 (fetching latest fetch task)...", _task.url);
	store.fetchFeedTask (_task.context.riak, _task.taskKey,
			function (_error, _previousTaskOutcome, _riakMetaData) {
				if (_error !== null) {
					_task.error = _error;
					_onFetchError (_task);
				} else {
					_task.taskRiakMetaData = _riakMetaData;
					_task.previousTaskOutcome = _previousTaskOutcome;
					if ((_task.previousTaskOutcome !== null)
							&& (
								(_task.previousTaskOutcome.currentEtag === undefined)
								|| (_task.previousTaskOutcome.currentTimestamp === undefined)
								|| (_task.previousTaskOutcome.currentData === undefined)
								|| (_task.previousTaskOutcome.updatedTimestamp === undefined)
								|| (_task.previousTaskOutcome.outcome === undefined)
								|| (_task.previousTaskOutcome.error === undefined)))
						_task.previousTaskOutcome = null;
					if ((_task.previousTaskOutcome === null)
							|| ((new Date () .getTime () - _task.previousTaskOutcome.currentTimestamp) > configuration.fetcherMinFetchAge))
						_doFetchStep2 (_task);
					else {
						_task.error = {reason : "rejected", cause : "fetchAge <="};
						_onFetchError (_task);
					}
				}
			});
}

function _doFetchStep2 (_task) {
	transcript.traceDebugging ("fetching `%s` step 2 (fetching latest data)...", _task.url);
	_fetchUrl (_task.url, _task.acceptContentType,
			_task.previousTaskOutcome ? _task.previousTaskOutcome.previousEtag : null,
			_task.previousTaskOutcome ? _task.previousTaskOutcome.previousTimestamp : null,
			function (_error, _outcome, _data) {
				if (_error !== null) {
					_task.error = _error;
					_task.dataOutcome = null;
					_task.data = null;
					_onFetchStep3b (_task);
				} else {
					_task.dataOutcome = _outcome;
					_task.data = _data;
					if (_task.data !== null)
						_onFetchStep3a (_task);
					else
						_onFetchStep3b (_task);
				}
			});
}

function _onFetchStep3a (_task) {
	transcript.traceDebugging ("fetching `%s` step 3a (updating data)...", _task.url);
	_task.dataKey = store.generateFeedDataKey (_task.url, _task.data);
	store.updateFeedData (_task.context.riak, _task.dataKey, _task.data,
			{
					contentType : _task.dataOutcome.contentType,
					usermeta : {feedKey : _task.feedKey, feedTaskKey : _task.taskKey, feedTaskType : _task.type}},
			function (_error, _riakMetaData) {
				if (_error !== null) {
					_task.error = _error;
					_onFetchError (_task);
				} else {
					_task.dataRiakMetaData = _riakMetaData;
					_onFetchStep4 (_task);
				}
			});
}

function _onFetchStep3b (_task) {
	_task.dataKey = _task.previousTaskOutcome ? _task.previousTaskOutcome.currentData : null;
	_task.dataRiakMetaData = null;
	_onFetchStep4 (_task);
}

function _onFetchStep4 (_task) {
	transcript.traceDebugging ("fetching `%s` step 4 (updating fetch task)...", _task.url);
	_task.currentTaskOutcome = {
		key : _task.taskKey,
		type : _task.type,
		feed : _task.feedKey,
		url : _task.url,
		currentData : _task.dataKey,
		currentEtag : _task.dataOutcome ? _task.dataOutcome.currentEtag : null,
		currentTimestamp : new Date () .getTime (),
		previousData : _task.previousTaskOutcome ? _task.previousTaskOutcome.currentData : null,
		previousEtag : _task.previousTaskOutcome ? _task.previousTaskOutcome.currentEtag : null,
		previousTimestamp : _task.previousTaskOutcome ? _task.previousTaskOutcome.currentTimestamp : null,
		updatedTimestamp : _task.previousTaskOutcome ? _task.previousTaskOutcome.updatedTimestamp : null,
		outcome : _task.dataOutcome,
		error : _task.error ? _task.error : null
	};
	if (_task.currentTaskOutcome.currentData != _task.currentTaskOutcome.previousData)
		_task.currentTaskOutcome.updatedTimestamp = _task.currentTaskOutcome.currentTimestamp;
	_task.taskRiakMetaData.contentType = "application/json";
	store.updateFeedTask (_task.context.riak, _task.taskKey, _task.currentTaskOutcome, _task.taskRiakMetaData,
			function (_error, _riakMetaData) {
				if (_error !== null) {
					_task.error = _error;
					_onFetchError (_task);
				} else {
					_task.taskRiakMetaData = _riakMetaData;
					if (_task.error === undefined) {
						transcript.traceDebugging ("succeeded fetching `%s`", _task.url);
						_task.callback (null, _task.currentTaskOutcome);
					} else
						_onFetchError (_task);
				}
			});
}

function _onFetchError (_task) {
	transcript.traceDebuggingObject ("failed fetching `%s`", _task.url, _task.error);
	_task.callback (_task.error, undefined);
}

// ---------------------------------------

var _hosts420Last = {};
var _hosts420Age = {};

function _fetchUrl (_url, _contentType, _etag, _timestamp, _callback) {
	
	if (_url === undefined)
		throw (new Error ());
	if (_contentType === undefined)
		_contentType = null;
	if (_etag === undefined)
		_etag = null;
	if (_timestamp === undefined)
		_timestamp = null;
	if (_callback === undefined)
		throw (new Error ());
	
	var _operation = {};
	_operation.url = _url;
	
	_url = url.parse (_url, false);
	_operation.urlHost = _url.host;
	_operation.urlPort = _url.port ? _url.port : 80;
	_operation.urlPath = _url.pathname + (_url.search ? _url.search : "");
	
	var _requestOptions = {
		host : _operation.urlHost,
		port : _operation.urlPort,
		path : _operation.urlPath,
		headers : {}
	};
	if (_contentType !== null)
		_requestOptions.headers["Accept"] = _contentType;
	if (_etag !== null)
		_requestOptions.headers["If-None-Match"] = _etag;
	if (_timestamp !== null)
		_requestOptions.headers["If-Modified-Since"] = new Date (_timestamp).toGMTString ();
	_requestOptions.headers["User-Agent"] = "mosaic-examples-realtime-feeds/0.1";
	_requestOptions.headers["Referer"] = "http://mosaic-cloud.eu/";
	
	_operation.request = {}
	_operation.response = {};
	
	_operation.request.host = _requestOptions.host;
	_operation.request.port = _requestOptions.port;
	_operation.request.path = _requestOptions.path;
	_operation.request.headers = _requestOptions.headers;
	_operation.previousEtag = _etag;
	_operation.previousTimestamp = _timestamp;
	_operation.beginTimestamp = new Date () .getTime ();
	
	function _onResponseAbort (_request, _response) {
		_response.on ("data", function () {});
		_response.on ("end", function () {});
	}
	
	function _onResponse200 (_request, _response) {
		
		var _contentType = _operation.response.headers["content-type"];
		var _contentEncoding = _operation.response.headers["content-encoding"];
		var _etag = _operation.response.headers["etag"];
		var _timestamp = _operation.response.headers["date"];
		if (_timestamp !== undefined)
			try {
				_timestamp = new Date (_timestamp) .getTime ();
			} catch (_error) {
				_timestamp = undefined;
			}
		if (_contentType === undefined)
			_contentType = null;
		if (_contentEncoding === undefined)
			_contentEncoding = null;
		if (_etag === undefined)
			_etag = null;
		if (_timestamp === undefined)
			_timestamp = null;
		
		_operation.currentEtag = _etag;
		_operation.currentTimestamp = _timestamp;
		_operation.contentType = _contentType;
		_operation.contentEncoding = _contentEncoding;
		
		var _buffers = [];
		
		_response.on ("data",
				function (_data) {
					_buffers.push (_data);
				});
		
		_response.on ("end",
				function () {
					var _bufferSize = 0;
					for (var _bufferIndex in _buffers)
						_bufferSize += _buffers[_bufferIndex].length;
					var _buffer = new Buffer (_bufferSize);
					var _bufferOffset = 0;
					for (var _bufferIndex in _buffers) {
						var _bufferItem = _buffers[_bufferIndex];
						_bufferItem.copy (_buffer, _bufferOffset);
						_bufferOffset += _bufferItem.length;
					}
					_operation.contentLength = _bufferSize;
					_operation.finishTimestamp = new Date () .getTime ();
					_callback (null, _operation, _buffer);
				});
	};
	
	function _onResponse304 (_request, _response) {
		_onResponseAbort (_request, _response);
		_operation.currentEtag = _operation.previousEtag;
		_operation.currentTimestamp = _operation.previousTimestamp;
		_operation.contentType = null;
		_operation.contentEncoding = null;
		_operation.contentLength = null;
		_operation.finishTimestamp = new Date () .getTime ();
		_callback (null, _operation, null);
	};
	
	function _onResponse420 (_request, _response, _simulated) {
		if (!_simulated)
			_onResponseAbort (_request, _response);
		_operation.currentEtag = _operation.previousEtag;
		_operation.currentTimestamp = _operation.previousTimestamp;
		_operation.contentType = null;
		_operation.contentEncoding = null;
		_operation.contentLength = null;
		_operation.finishTimestamp = new Date () .getTime ();
		if (!_simulated) {
			if ((_hosts420Last[_operation.urlHost] === undefined) || (_hosts420Last[_operation.urlHost] === null)) {
				if (_hosts420Age[_operation.urlHost] !== undefined) {
					_hosts420Age[_operation.urlHost] *= configuration.fetcher420AgeMultiplier;
					if (_hosts420Age[_operation.urlHost] > configuration.fetcher420MaxAge)
						_hosts420Age[_operation.urlHost] = configuration.fetcher420MaxAge;
				} else
					_hosts420Age[_operation.urlHost] = configuration.fetcher420MinAge;
				if (_operation.response.headers["retry-after"] !== undefined) {
					var _retryAfter = parseInt (_operation.response.headers["retry-after"]);
					if (_retryAfter > 0)
						_hosts420Age[_operation.urlHost] = _retryAfter * 1000;
				}
				transcript.traceWarning ("throtling initiated for `%s` (%.2f)...", _operation.urlHost, _hosts420Age[_operation.urlHost] / 1000);
			}
			_hosts420Last[_operation.urlHost] = _operation.finishTimestamp;
		}
		_operation.error = {reason : "unexpected-status-code", statusCode : _operation.response.statusCode, simulated : _simulated};
		_callback (_operation.error, _operation, null);
	};
	
	function _onResponseXXX (_request, _response) {
		_onResponseAbort (_request, _response);
		_operation.contentType = null;
		_operation.finishTimestamp = new Date () .getTime ();
		_operation.error = {reason : "unexpected-status-code", statusCode : _operation.response.statusCode};
		_callback (_operation.error, _operation, undefined);
	};
	
	function _onResponse (_response) {
		_operation.response.httpVersion = _response.httpVersion;
		_operation.response.statusCode = _response.statusCode;
		_operation.response.headers = _response.headers;
		if (_operation.response.statusCode == 200)
			_onResponse200 (_request, _response);
		else if (_operation.response.statusCode == 304)
			_onResponse304 (_request, _response);
		else if (_operation.response.statusCode == 420)
			_onResponse420 (_request, _response, false);
		else
			_onResponseXXX (_request, _response);
		if ((_operation.response.statusCode != 420) && (_hosts420Last[_operation.urlHost] === null)) {
			delete _hosts420Last[_operation.urlHost];
			_hosts420Age[_operation.urlHost] /= configuration.fetcher420AgeDemultiplier;
			if (_hosts420Age[_operation.urlHost] < configuration.fetcher420MinAge)
				_hosts420Age[_operation.urlHost] = configuration.fetcher420MinAge;
			transcript.traceWarning ("throtling finalized for `%s` (%.2f)...", _operation.urlHost, _hosts420Age[_operation.urlHost] / 1000);
		}
	};
	
	function _onError (_error) {
		_callback ({reason : "unexpected-error", cause : _error}, undefined, undefined);
	};
	
	if (_hosts420Last[_operation.urlHost] !== undefined) {
		if ((_hosts420Last[_operation.urlHost] === null)
				|| ((_operation.beginTimestamp - _hosts420Last[_operation.urlHost]) <= _hosts420Age[_operation.urlHost])) {
			_operation.response.httpVersion = "1.1";
			_operation.response.statusCode = 420;
			_operation.response.headers = {};
			_onResponse420 (null, null, true);
			return;
		} else
			_hosts420Last[_operation.urlHost] = null;
	}
	
	var _request = http.get (_requestOptions);
	
	_request.on ("response", _onResponse);
	_request.on ("error", _onError);
	
	return (_request);
};

// ---------------------------------------

module.exports.fetch = _fetch;
module.exports.fetchUrl = _fetchUrl;

// ---------------------------------------
