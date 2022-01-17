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

            if (msg.actions && !(Array.isArray(msg.actions))) {
                throw 'Simplepush error: actions must be array'
            }

            var configActions
            if (config.actions) {
                configActions = config.actions.split(/[ ,]+/).filter(Boolean)
            }

            if ((configActions && configActions > 10) || (msg.actions && msg.actions.length > 10)) {
                throw 'Simplepush error: too many actions'
            }

            if ((config.actionTimeout && isNaN(parseInt(config.actionTimeout))) || (msg.timeout && isNaN(parseInt(msg.timeout)))) {
                throw 'Simplepush error: feedback timeout needs to be a number'
            }

            var notification;
            if (config.password && config.salt || msg.password && msg.salt) {
                notification = {
                    key: config.key || msg.key,
                    title: config.title || msg.title,
                    message: config.message || msg.payload,
                    event: config.event || msg.event,
                    actions: configActions || msg.actions,
                    password: config.password || msg.password,
                    salt: config.salt || msg.salt
                };
            } else {
                notification = {
                    key: config.key || msg.key,
                    title: config.title || msg.title,
                    message: config.message || msg.payload,
                    event: config.event || msg.event,
                    actions: configActions || msg.actions
                };
            }

            for (let k in notification) {
                if (!notification[k]) { delete notification[k]; }
            }

            var err = function (error) {
                done(error)
            }

            var feedbackCallback;
            if (config.actionOutputEnabled || msg.timeout) {
                feedbackCallback = function (response) {
                    msg.payload = response.actionSelected
                    msg.actionSelectedAt = response.actionSelectedAt
                    msg.actionDeliveredAt = response.actionDeliveredAt
                    msg.feedbackId = response.feedbackId
                    send(msg)
                };
            } else {
                feedbackCallback = null
            }

            var timeout;
            if (parseInt(config.actionTimeout) == 0 || parseInt(msg.timeout) == 0) {
                timeout = null
            } else {
                timeout = parseInt(config.actionTimeout) || parseInt(msg.timeout) || 180
            }

            simplepush.send(
                notification,
                err,
                feedbackCallback,
                timeout
            );
        });
    }
    RED.nodes.registerType("simplepush", SimplepushNode);
}