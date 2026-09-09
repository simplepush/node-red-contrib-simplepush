module.exports = function(RED) {
    // @simplepush/sdk is ESM-only; this node file is CommonJS, so it is loaded
    // through a dynamic import the first time a message arrives.
    let sdkPromise;
    function loadSdk() {
        if (!sdkPromise) { sdkPromise = import('@simplepush/sdk'); }
        return sdkPromise;
    }

    function splitList(value) {
        return String(value).split(/[ ,]+/).filter(Boolean);
    }

    // Downloads a URL so it can be uploaded as a task file attachment.
    async function fetchAttachment(url) {
        var res = await fetch(url);
        if (!res.ok) {
            throw new Error('Simplepush error: could not fetch attachment ' + url + ' (status ' + res.status + ')');
        }
        var filename = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '') || 'attachment';
        var contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
        return { filename: filename, data: new Uint8Array(await res.arrayBuffer()), contentType: contentType };
    }

    // A topic send returns a TaskGroup (one instance per recipient) whose
    // inputs() yields { instance, item, recipient }. A send to your own devices
    // returns a single Task whose inputs() yields the bare item. This gives
    // both the group shape.
    function asGroup(sent) {
        if (sent.instances) { return sent; }
        return {
            instances: [sent],
            inputs: async function*(streamOptions) {
                for await (const item of sent.inputs(streamOptions)) {
                    yield { instance: sent, item: item };
                }
            }
        };
    }

    function SimplepushNode(config) {
        RED.nodes.createNode(this, config);
        this.actions = config.actions || "";
        var node = this;

        // One Client per API token (a msg.apiToken override gets its own).
        var clients = new Map();
        var inflight = new Set();

        function clientFor(sdk, apiToken) {
            var client = clients.get(apiToken);
            if (!client) {
                client = new sdk.Client({ apiToken: apiToken });
                clients.set(apiToken, client);
            }
            return client;
        }

        node.on('input', function(msg, send, done) {
            handle(msg, send).then(function() { done(); }, function(err) {
                if (err && err.name === 'AbortError') { return; }
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err instanceof Error ? err : new Error(String(err)));
            });
        });

        node.on('close', function() {
            inflight.forEach(function(ac) { ac.abort(); });
            inflight.clear();
            clients.forEach(function(c) { c.close(); });
            clients.clear();
            node.status({});
        });

        async function handle(msg, send) {
            if (!msg.payload && !config.message) {
                throw new Error('Simplepush error: payload is empty');
            } else if (msg.payload && typeof(msg.payload) == 'object') {
                msg.payload = JSON.stringify(msg.payload);
            } else if (msg.payload) {
                msg.payload = String(msg.payload);
            }

            var credentials = node.credentials || {};
            var apiToken = credentials.apiToken || msg.apiToken;
            if (!apiToken) {
                throw new Error('Simplepush error: API token is empty. Create one in the app under Settings > API Token and enter it in the node config (or pass msg.apiToken)');
            }

            if (msg.key) {
                throw new Error('Simplepush error: msg.key is no longer supported. Send to a topic instead (msg.topic) and authenticate with an API token');
            }

            // Flows saved by version 1.x carry the old key in config.key. The app
            // migration imports every old key as a topic of the same name, so it
            // keeps working as the topic.
            var topic = config.topic || config.key || msg.topic;

            if (msg.attachments && !(Array.isArray(msg.attachments))) {
                throw new Error('Simplepush error: attachments must be array');
            }
            var attachments = (config.attachments && splitList(config.attachments)) || (msg.attachments && msg.attachments.map(String)) || [];
            if (attachments.length > 10) {
                throw new Error('Simplepush error: too many attachments');
            }

            if (msg.actions && !(Array.isArray(msg.actions))) {
                throw new Error('Simplepush error: actions must be array');
            }

            var configActions;
            if (config.actions) {
                configActions = splitList(config.actions);
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

            // A topic send is encrypted with the topic's password, a send to your
            // own devices (no topic) with the Personal Password.
            var topicPassword = credentials.topicPassword || config.password || msg.password;
            var personalPassword = credentials.personalPassword || msg.personalPassword;
            if (!topic && topicPassword) {
                throw new Error('Simplepush error: the topic password needs a topic. Sends to your own devices are encrypted with the Personal Password');
            }

            var options = {
                topic: topic,
                title: config.title || msg.title,
                content: config.message || msg.payload,
                tag: config.tag || config.event || msg.tag || msg.event,
                password: topic ? topicPassword : personalPassword
            };
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
                options.files = await Promise.all(attachments.map(fetchAttachment));
            }
            for (let k in options) {
                if (!options[k]) { delete options[k]; }
            }
            options.autoCommit = typeof msg.autoCommit === 'boolean' ? msg.autoCommit : config.autoCommit !== false;

            var sdk = await loadSdk();
            var client = clientFor(sdk, apiToken);

            node.status({ fill: "blue", shape: "dot", text: "sending" });
            var group = asGroup(await client.sendTask(options));

            if (!waitForAction) {
                node.status({ fill: "green", shape: "dot", text: "sent" });
                return;
            }

            if (group.instances.length === 0) {
                throw new Error('Simplepush error: nobody is subscribed to topic "' + topic + '"');
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

    RED.nodes.registerType("simplepush", SimplepushNode, {
        credentials: {
            apiToken: { type: "password" },
            topicPassword: { type: "password" },
            personalPassword: { type: "password" }
        }
    });
}
