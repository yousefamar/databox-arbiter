var fs = require('fs');
var https = require('https');
var express = require('express');
var bodyParser = require('body-parser');
var request = require('request');
var crypto = require('crypto');
var macaroons = require('macaroons.js');
var basicAuth = require('basic-auth');
var baseCat = require('./base-cat.json');

var DEBUG = !!process.env.DEBUG;
var PORT = process.env.PORT || 8080;

var HTTPS_CLIENT_CERT = process.env.HTTPS_CLIENT_CERT || '';
var HTTPS_CLIENT_PRIVATE_KEY = process.env.HTTPS_CLIENT_PRIVATE_KEY || '';

var CM_KEY = process.env.CM_KEY || '';

var containers = {};

var app = express();

var credentials = {
	key:  HTTPS_CLIENT_PRIVATE_KEY,
	cert: HTTPS_CLIENT_CERT,
};

// TODO: Check
app.enable('trust proxy');
app.disable('x-powered-by');

app.use(bodyParser.urlencoded({
	extended: false
}));

app.get('/status', function(req, res){
	res.send('active');
});

/**********************************************************/

app.all([ '/cat', '/token', '/store/*', '/cm/*'], function (req, res, next) {
	var creds = basicAuth(req);
	var key = req.get('X-Api-Key') || (creds && creds.name);

	if (!key) {
		res.status(401).send('Missing API Key');
		return;
	}

	req.key = key;

	for (name in containers) {
		var container = containers[name];
		if (!container.key || container.key !== key)
			continue;
		req.container = container;
		break;
	}

	next();
});

/**********************************************************/

app.all('/cm/*', function (req, res, next) {
	if (req.key !== CM_KEY) {
		res.status(401).send('Unauthorized: Arbiter key invalid');
		return;
	}
	next();
});

/**********************************************************/

app.post('/cm/upsert-container-info', function (req, res) {
	// TODO: Catch potential error
	var data = JSON.parse(req.query.data || req.body.data);

	if (data == null || !data.name) {
		res.status(400).send('Missing parameters');
		return;
	}

	var databoxType = data.type || '';

	// TODO: Store in a DB maybe? Probably not.
	if (!(data.name in containers) && databoxType == 'store') {
		containers[data.name] = {
			catItem: {
				'item-metadata': [
					{
						rel: 'urn:X-hypercat:rels:isContentType',
						val: 'application/vnd.hypercat.catalogue+json'
					},
					{
						rel: 'urn:X-hypercat:rels:hasDescription:en',
						val: data.name
					}
				],
				href: 'http://' + data.name + ':8080'
			}
		};
	} else {
		containers[data.name] = {}
	}

	for(var key in data) {
		containers[data.name][key] = data[key];
	}

	res.send(JSON.stringify(containers[data.name]));
});

/**********************************************************/

// Serve root Hypercat catalogue
app.get('/cat', function(req, res){
	var cat = JSON.parse(JSON.stringify(baseCat));

	for (var name in containers) {
		var container = containers[name];
		// TODO: If CM, show all
		// TODO: Hide items based on container permissions
		// TODO: If discoverable, but not accessible, inform as per PAS 7.3.1.2
		if(container.catItem) {
			cat.items.push(container.catItem);
		}
	}

	res.setHeader('Content-Type', 'application/json');
	res.send(cat);
});

/**********************************************************/

app.post('/token', function(req, res){
	if (req.body.target == null) {
		res.status(400).send('Missing parameters');
		return;
	}

	var targetContainer = containers[req.body.target];

	console.log("targetContainer::", targetContainer, req.body.target);

	if (typeof(targetContainer) == "undefined" && !targetContainer) {
		res.status(400).send("Target " + req.body.target + " has not been approved for arbitering");
		return;
	}

	if (!targetContainer.secret) {
		res.status(400).send("Target " + req.body.target + " has not registered itself for arbitering");
		return;
	}

	// TODO: Check permissions here!

	crypto.randomBytes(32, function(err, buffer){
		res.send(
			new macaroons.MacaroonsBuilder("http://arbiter:" + PORT, targetContainer.secret, buffer.toString('base64'))
				.add_first_party_caveat("target = " + req.body.target)
				.add_first_party_caveat('path = "/*"')
				.getMacaroon().serialize()
		);
	});
});

/**********************************************************/

app.get('/store/secret', function (req, res) {
	if (!req.container.type) {
		// NOTE: This should never happen if the CM is up to spec.
		res.status(500).send('Container type unknown by arbiter');
		return;
	}

	if (req.container.type !== 'store') {
		res.status(403).send('Container type "' + req.container.type + '" cannot use arbiter token minting capabilities as it is not a store type');
		return;
	}

	if (req.container.secret) {
		res.status(409).send('Store shared secret already retrieved');
		return;
	}

	crypto.randomBytes(macaroons.MacaroonsConstants.MACAROON_SUGGESTED_SECRET_LENGTH, function(err, buffer){
		if (err != null) {
			res.status(500).send('Unable to register container (secret generation)');
			return;
		}

		console.log("[/store/secret]" + req.container.name + " registered");

		req.container.secret = buffer;
		res.send(buffer.toString('base64'));
	});
});

https.createServer(credentials, app).listen(PORT);
