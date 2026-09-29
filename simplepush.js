module.exports = function(RED) {
    var shared = require('./lib/shared');

    function SimplepushNode(config) {
        RED.nodes.createNode(this, config);
        this.actions = config.actions || "";
        var node = this;
        var account = RED.nodes.getNode(config.account);
        var inflight = new Set();

        node.on('input', function(msg, send, done) {
            handle(msg, send).then(function() { done(); }, function(err) {
                if (err && err.name === 'AbortError') { return done(); }
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err instanceof Error ? err : new Error(String(err)));
            });
        });

        node.on('close', function() {
            inflight.forEach(function(ac) { ac.abort(); });
            inflight.clear();
            node.status({});
        });

        async function handle(msg, send) {
            if (!account) {
                throw new Error('Simplepush error: select a Simplepush account in the node');
            }
            if (!msg.payload && !config.message) {
                throw new Error('Simplepush error: payload is empty');
            } else if (msg.payload && typeof(msg.payload) == 'object') {
                msg.payload = JSON.stringify(msg.payload);
            } else if (msg.payload) {
                msg.payload = String(msg.payload);
            }

            if (msg.key) {
                throw new Error('Simplepush error: msg.key is no longer supported. Send to a topic instead (msg.topic)');
            }
            if (msg.password !== undefined || msg.personalPassword !== undefined) {
                throw new Error('Simplepush error: passwords are no longer read from the message. Add the topic and its password, or your Personal Password, to the Simplepush account');
            }

            // Flows saved by version 1.x carry the old key in config.key and
            // the password in config.password. The app migration imports every
            // old key as a topic of the same name.
            var target = account.target(
                config.topic || config.key || msg.topic,
                config.member || msg.member,
                config.broadcast || msg.broadcast === true,
                config.password
            );

            if (msg.attachments && !(Array.isArray(msg.attachments))) {
                throw new Error('Simplepush error: attachments must be array');
            }
            var attachments = (config.attachments && shared.splitList(config.attachments)) || (msg.attachments && msg.attachments.map(String)) || [];
            if (attachments.length > 10) {
                throw new Error('Simplepush error: too many attachments');
            }

            if (msg.actions && !(Array.isArray(msg.actions))) {
                throw new Error('Simplepush error: actions must be array');
            }

            var configActions;
            if (config.actions) {
                configActions = shared.splitList(config.actions);
            }
            var actions = configActions || (msg.actions && msg.actions.map(String));
            if (actions && actions.length > 10) {
                throw new Error('Simplepush error: too many actions');
            }

            // The config timeout wins when the field holds a number (0 included).
            // A blank field defers to msg.timeout; without either there is no
            // timeout.
            var configTimeout = config.actionTimeout === undefined || config.actionTimeout === null ? "" : String(config.actionTimeout).trim();
            if ((configTimeout !== "" && isNaN(parseInt(configTimeout))) || (msg.timeout !== undefined && isNaN(parseInt(msg.timeout)))) {
                throw new Error('Simplepush error: timeout needs to be a number');
            }
            var timeout = configTimeout !== "" ? parseInt(configTimeout) : (msg.timeout !== undefined ? parseInt(msg.timeout) : 0);
            if (timeout <= 0) { timeout = null; }

            var options = Object.assign({}, target, {
                title: config.title || msg.title,
                content: config.message || msg.payload,
                tag: config.tag || config.event || msg.tag || msg.event
            });
            var waitForAction = Boolean(actions && actions.length > 0);
            if (waitForAction) {
                options.inputs = [{
                    type: "actions",
                    required: true,
                    actions: actions.map(function(a) { return { key: a, label: a }; })
                }];
                if (timeout !== null) {
                    options.expiresAt = new Date(Date.now() + timeout * 1000);
                }
            }
            if (attachments.length > 0) {
                options.files = await Promise.all(attachments.map(shared.fetchFile));
            }
            for (let k in options) {
                if (!options[k]) { delete options[k]; }
            }
            options.autoCommit = typeof msg.autoCommit === 'boolean' ? msg.autoCommit : config.autoCommit !== false;

            var client = await account.client();

            node.status({ fill: "blue", shape: "dot", text: "sending" });
            var group = shared.asGroup(await client.sendTask(options));

            if (!waitForAction) {
                node.status({ fill: "green", shape: "dot", text: "sent" });
                return;
            }

            if (group.instances.length === 0) {
                throw new Error(target.broadcast
                    ? 'Simplepush error: the organization has no members to send to'
                    : 'Simplepush error: nobody is subscribed to topic "' + target.topic + '"');
            }

            node.status({ fill: "yellow", shape: "dot", text: "waiting for action" });
            var ac = new AbortController();
            inflight.add(ac);
            var streamOptions = { signal: ac.signal };
            if (timeout !== null) { streamOptions.idleMs = timeout * 1000; }

            // The SDK ends each task's stream on its terminal event (completed,
            // declined, canceled, deleted, expired) and the group stream once
            // every task ended or the idle timeout fired.
            var answered = 0;
            try {
                for await (const ev of group.inputs(streamOptions)) {
                    var item = ev.item;
                    if (item.kind !== "taskCompleted") { continue; }
                    var action = item.uploads.find(function(u) { return u.kind === "action" && u.key; });
                    if (!action) { continue; }
                    answered++;

                    var out = answered === 1 ? msg : RED.util.cloneMessage(msg);
                    out.payload = action.key;
                    out.taskId = ev.instance.taskId;
                    out.actionSelectedAt = item.raw.createdAt;
                    if (ev.recipient) { out.recipient = ev.recipient; }
                    emit(out, action.key);
                }
            } finally {
                inflight.delete(ac);
            }

            if (answered < group.instances.length) {
                if (timeout === null) {
                    throw new Error('Simplepush error: the task was declined, canceled or deleted before an action was selected');
                }
                throw new Error('Simplepush error: timeout waiting for an action, or the task was declined, canceled or deleted');
            }
            node.status({ fill: "green", shape: "dot", text: "action received" });

            function emit(out, selected) {
                if (configActions) {
                    var index = configActions.indexOf(selected);
                    if (index == -1) { return; }
                    var outputMsgs = [];
                    for (var i = 0; i < configActions.length; i++) {
                        outputMsgs.push(i == index ? out : null);
                    }
                    send(outputMsgs);
                } else {
                    send(out);
                }
            }
        }
    }

    RED.nodes.registerType("simplepush", SimplepushNode);
}
