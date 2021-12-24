module.exports = function(RED) {
    const simplepush = require('simplepush-notifications');

    function SimplepushNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!msg.payload) {
                throw 'Simplepush error: payload is empty';
            } else if (typeof(msg.payload) == 'object') {
                msg.payload = JSON.stringify(msg.payload);
            } else {
                msg.payload = String(msg.payload);
            }

            if (!config.key && !msg.key) {
                throw 'Simplepush error: key is empty'
            }

            var notification;
            if (config.password && config.salt || msg.password && msg.salt) {
                notification = {
                    'key': config.key || msg.key,
                    'title': config.title || msg.title,
                    'message': config.message || msg.payload,
                    'event': config.event || msg.event,
                    'password': config.password || msg.password,
                    'salt': config.salt || msg.salt
                };
            } else {
                notification = {
                    'key': config.key || msg.key,
                    'title': config.title || msg.title,
                    'message': config.message || msg.payload,
                    'event': config.event || msg.event
                };
            }

            for (let k in notification) {
                if (!notification[k]) { delete notification[k]; }
            }

            simplepush.send(notification, function (err) {
                if (err) {
                    done(err.message);
                }

                done();
            });
        });
    }
    RED.nodes.registerType("simplepush", SimplepushNode);
}