'use strict';

var express = require('express');
var bodyParser = require('body-parser');
var http = require('http');
var cors = require('cors');
var oracle = require('oracle');
var parseString = require('xml2js').parseString;

var userConnections = {};
var siteUsers = {};
var companyUsers = {};

/**
 * ----------------------------------------------------------------------------
 * Server
 * ----------------------------------------------------------------------------
 */

var app = express();
app.use(bodyParser.json());
app.use(cors({credentials: true, origin: 'http://localhost:9393'}));

// all environments
app.set('port', process.env.PORT || 3000);

/**
 * POST a new notification to spread it to corresponding target
 * Payload: {
 *     id: <code_site> || <code_societe> || <num_asp_user>
 *     target: 'site' || 'societe' || 'user'
 *     cmd: event command
 *     msg: notification message
 * }
 */
app.post('/notification', function(req, res) {
    var id = req.body.id;
    var target = req.body.target;
    var cmd = req.body.cmd;
    var msg = req.body.msg;

    if (!id || !cmd || !target || !msg) {
        res.status(500).send('Wrong payload !');
        return;
    }

    var targets = [];

    switch (target) {
        case 'site':
            targets = filterUsers(siteUsers[id], cmd);
            break;
        case 'societe':
            targets = filterUsers(companyUsers[id], cmd);
            break;
        case 'user':
            targets = filterUsers([id], cmd);
            break;
    }

    if (targets && targets.length) {
        // emit to all matching sockets
        targets.forEach(function(socket) {
            socket.emit(cmd, msg);
        });

        res.status(200).end();
    } else {
        res.status(404).end();
    }
});

// start server
var server = http.createServer(app).listen(app.get('port'), function() {
    console.log((new Date()) + ': Express server listening on port ' + app.get('port'));
});

/**
 * Get all the sockets matching given user ids
 * @param {object} asps - list of user ids
 * @param {string} cmd - command to emit
 * @returns {object} array of socket
 */
function filterUsers(asps, cmd) {
    if (!asps) {
        return null;
    }

    var res = [];

    asps.forEach(function(asp) {
        var user = userConnections[asp];

        if (user && user.events[cmd]) {
            res.push(user.socket);
        }
    });

    return res;
}


/**
 * ----------------------------------------------------------------------------
 * Oracle
 * ----------------------------------------------------------------------------
 */

var connectData = {
    hostname: '',
    port: 1,
    database: '',
    user: '',
    password: ''
};

/**
 * Call the database to fetch the user notification preferences
 * @param {string} asp - user id
 * @param {string} site - user site
 * @param {string} company - user company
 * @returns {string} preferences as xml string
 */
function getUserPrefs(asp, site, company) {
    var connection = oracle.connectSync(connectData);

    var res = connection.executeSync('select PK_NOTIFICATION.GET_USER_PREF(\'' + asp +'\', \'' + company + '\', \'' + site + '\') as PREFS from DUAL', []);
    connection.close();

    return res[0].PREFS;
}

/**
 * ----------------------------------------------------------------------------
 * WebSocket
 * ----------------------------------------------------------------------------
 */

var io = require('socket.io')(server);

// Socket connection authentication
io.use(function(socket, next) {
    if (authenticate(socket, socket.handshake.query)) {
        next();
    } else {
        next(new Error('Not authorized'));
    }
});

// When someone successfully connect on the server
io.on('connection', function(socket) {
    console.log((new Date()) + ': connection opened');

    socket.on('disconnect', function() {
        var asp = this._asp;

        // remove user from lists
        delete userConnections[asp];

        for (var key in siteUsers) {
            siteUsers[key].splice(siteUsers[key].indexOf(asp), 1);
        }

        for (var key in companyUsers) {
            companyUsers[key].splice(companyUsers[key].indexOf(asp), 1);
        }
    });
});

/**
 * Authenticate the user that try to open a socket
 * @param {object} socket - socket allowed if success
 * @param {object} params - user information
 * @returns {boolean}
 */
function authenticate(socket, params) {
    console.log('Start authentication !');
    var asp = params.asp;
    var site = params.site;
    var company = params.societe;

    if (!asp || !site || !company) {
        return false;
    }

    console.log((new Date()) + ': authenticate user:' + asp + ' / site:' + site + ' / company:' + company);

    var userPrefs = getUserPrefs(asp, site, company);

    if (!userPrefs) {
        return false;
    }

    // save the asp here to remove it more easily on disconnection
    socket._asp = asp;

    // we store the socket for the user
    userConnections[asp] = {
        socket: socket,
        events: parseXml(userPrefs)
    };

    // we store the list of user of a site
    if (siteUsers[site]) {
        siteUsers[site].push(asp);
    } else {
        siteUsers[site] = [asp];
    }

    // we store the list of user of a company
    if (companyUsers[company]) {
        companyUsers[company].push(asp);
    } else {
        companyUsers[company] = [asp];
    }

    return true;
}

/**
 * Parse the preferences to usable form
 * @param {string} string - xml string to parse
 * @returns {object} list of subscribed events
 */
function parseXml(string) {
    var prefs = {};

    // encapsulate to avoid multiple root element
    string = '<root>' + string + '</root>';

    parseString(string, function(err, result) {
        var widgets = result.root.Widgets || [];

        widgets.forEach(function(widget) {
            if (widget.$.IsActive === 'true') {
                widget.Events.forEach(function(event) {
                    if (event.Event) {
                        event.Event.forEach(function(pref) {
                            if (pref.$.IsActive === 'true') {
                                prefs[pref.$.Cmd] = true;
                            }
                        });
                    }
                });
            }
        });
    });

    return prefs;
}
