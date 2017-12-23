var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto');

module.exports = function (server, config) {
    var io = socketIO.listen(server);

    io.sockets.on('connection', function (client) {
        registry_connect(client);
        registry_set(client,'screen',false);
        registry_set(client,'video',true);
        registry_set(client,'audio',false);

        // pass a message to another id
        client.on('message', function (details) {
            if (!details) return;

            var otherClient = io.to(details.to);
            if (!otherClient) return;

            details.from = client.id;
            otherClient.emit('message', details);
        });

        client.on('shareScreen', function () {
            registry_set(client,'screen',true);
        });

        client.on('unshareScreen', function (type) {
            registry_set(client,'screen',false);
            removeFeed('screen');
        });

        client.on('join', join);

        var client_room = null;

        function removeFeed(type) {
            if (client_room) {
                io.sockets.in(client_room).emit('remove', {
                    id: client.id,
                    type: type
                });
                if (!type) {
                    client.leave(client_room);
                    registry_leave(client,client_room);
                    client_room = undefined;
                }
            }
        }

        function join(name, cb) {
            // sanity check
            if (typeof name !== 'string') return;
            // check if maximum number of clients reached
            if (config.rooms && config.rooms.maxClients > 0 &&
                clientsInRoom(name) >= config.rooms.maxClients) {
                safeCb(cb)('full');
                return;
            }
            // leave any existing rooms
            removeFeed();
            safeCb(cb)(null, describeRoom(name));
            client.join(name);
            client_room = name;
            registry_join(client,client_room);
        }

        // we don't want to pass "leave" directly because the
        // event type string of "socket end" gets passed too.
        client.on('disconnect', function () {
            removeFeed();
            registry_disconnect(client);
        });
        client.on('leave', function () {
            removeFeed();
        });

        client.on('create', function (name, cb) {
            if (arguments.length == 2) {
                cb = (typeof cb == 'function') ? cb : function () {};
                name = name || uuid();
            } else {
                cb = name;
                name = uuid();
            }
            // check if exists
            var room = io.nsps['/'].adapter.rooms[name];
            if (room && room.length) {
                safeCb(cb)('taken');
            } else {
                join(name);
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function (data) {
            console.log('trace', JSON.stringify(
            [data.type, data.session, data.prefix, data.peer, data.time, data.value]
            ));
        });


        // tell client about stun and turn servers and generate nonces
        client.emit('stunservers', config.stunservers || []);

        // create shared secret nonces for TURN authentication
        // the process is described in draft-uberti-behave-turn-rest
        var credentials = [];
        // allow selectively vending turn credentials based on origin.
        var origin = client.handshake.headers.origin;
        if (!config.turnorigins || config.turnorigins.indexOf(origin) !== -1) {
            config.turnservers.forEach(function (server) {
                var hmac = crypto.createHmac('sha1', server.secret);
                // default to 86400 seconds timeout unless specified
                var username = Math.floor(new Date().getTime() / 1000) + (parseInt(server.expiry || 86400, 10)) + "";
                hmac.update(username);
                credentials.push({
                    username: username,
                    credential: hmac.digest('base64'),
                    urls: server.urls || server.url
                });
            });
        }
        client.emit('turnservers', credentials);
    });

    var clients = {}
    var rooms = {}

    function registry_connect(client) {
        clients[client.id] = {}
    }
    function registry_disconnect(client) {
        delete clients[client.id]
    }
    function registry_set(client,resource,value) {
        clients[client.id][resource] = value;
    }
    function registry_join(client,room) {
        if(!(room in rooms)) {
            rooms[room] = new Set();
        }
        rooms[room].add(client.id);
    }
    function registry_leave(client,room) {
        rooms[room].delete(client.id);
        if(rooms[room].size === 0) {
            delete rooms[room];
        }
    }

    function describeRoom(name) {
        var result = {
            clients: {}
        };
        if(!(name in rooms)) {
            return result;
        }
        for( var id of rooms[name].values() ) {
            result.clients[id] = clients[id];
        };
        return result;
    }

    function clientsInRoom(name) {
        return rooms[name].size;
    }

};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}
