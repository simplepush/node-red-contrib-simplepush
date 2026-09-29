module.exports = function(RED) {
    var shared = require('./lib/shared');

    // A push shows at most 3 buttons on Android.
    var MAX_BUTTONS = 3;

    // Turns the node's input (or msg.input) into a notification input. Choice
    // options and actions may be given as comma separated labels.
    function buildInput(type, values) {
        if (!type) { return undefined; }
        var labels = Array.isArray(values) ? values : shared.splitLabels(values || '');
        switch (type) {
            case 'text':
                return { type: 'text' };
            case 'choice':
                labels = labels.map(String);
                if (labels.length === 0 || labels.length > MAX_BUTTONS) {
                    throw new Error('Simplepush error: a notification choice needs 1 to ' + MAX_BUTTONS + ' options');
                }
                return { type: 'choice', options: labels };
            case 'actions':
                if (labels.length === 0 || labels.length > MAX_BUTTONS) {
                    throw new Error('Simplepush error: a notification needs 1 to ' + MAX_BUTTONS + ' actions');
                }
                return {
                    type: 'actions',
                    actions: labels.map(function(a) {
                        if (typeof a === 'string') { return { key: a, label: a }; }
                        var action = { key: String(a.key || a.label), label: String(a.label || a.key) };
                        if (a.style) { action.style = a.style; }
                        return action;
                    })
                };
        }
        throw new Error('Simplepush error: unknown notification input type ' + type + ', use text, choice or actions');
    }

    function answerOf(reply) {
        if (!reply) { return {}; }
        switch (reply.type) {
            case 'text': return { text: reply.value };
            case 'choice': return { choice: reply.selectedValue };
            case 'actions': return { action: reply.selectedKey };
        }
        return {};
    }

    async function media(value) {
        if (value === undefined || value === null || value === '') { return undefined; }
        return typeof value === 'string' ? value : shared.toFile(value);
    }

    function SimplepushNotificationNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var account = RED.nodes.getNode(config.account);
        var inflight = new Set();
        var waiting = 0;

        function showWaiting() {
            if (waiting > 0) {
                node.status({ fill: "yellow", shape: "dot", text: "waiting for " + waiting + (waiting === 1 ? " answer" : " answers") });
            }
        }

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

            var content = shared.pick(config.message, msg.payload);
            if (content === undefined || content === null || content === '') {
                throw new Error('Simplepush error: payload is empty');
            }
            if (typeof content === 'object') { content = JSON.stringify(content); }

            var target = account.target(
                shared.pick(config.topic, msg.topic),
                shared.pick(config.member, msg.member),
                config.broadcast || msg.broadcast === true
            );

            var input;
            if (config.inputType) {
                input = buildInput(config.inputType, config.inputOptions);
            } else if (msg.input !== undefined && msg.input !== null) {
                if (typeof msg.input !== 'object') { throw new Error('Simplepush error: msg.input must be an object'); }
                input = buildInput(msg.input.type, msg.input.type === 'choice' ? msg.input.options : msg.input.actions);
            }
            var link = shared.pick(config.link, msg.link);
            if (input && link) {
                throw new Error('Simplepush error: a notification has either an input or a link, the input\'s buttons take the place of the link');
            }
            var image = await media(shared.pick(config.image, msg.image));
            var audio = await media(shared.pick(config.audio, msg.audio));
            if (image && audio) {
                throw new Error('Simplepush error: a notification carries an image or an audio clip, not both');
            }
            var timeout = shared.parseSeconds(shared.pick(config.timeout, msg.timeout), 'timeout');

            var options = Object.assign({}, target, {
                title: shared.pick(config.title, msg.title),
                content: String(content),
                tag: shared.pick(config.tag, msg.tag),
                priority: shared.parsePriority(shared.pick(config.priority, msg.priority)),
                input: input,
                link: link,
                image: image,
                audio: audio,
                shared: shared.pickBoolean(config.shared, msg.shared)
            });
            Object.keys(options).forEach(function(k) {
                if (options[k] === undefined || options[k] === '') { delete options[k]; }
            });
            if (options.title !== undefined) { options.title = String(options.title); }
            if (options.tag !== undefined) { options.tag = String(options.tag); }
            if (options.link !== undefined) { options.link = String(options.link); }

            var client = await account.client();
            node.status({ fill: "blue", shape: "dot", text: "sending" });
            var sent = await client.sendNotification(options);
            var group = shared.asGroup(sent);

            msg.notificationId = sent.notificationId;
            msg.groupId = sent.groupId;
            if (!input) {
                node.status({ fill: "green", shape: "dot", text: "sent" });
                return;
            }
            if (group.instances.length === 0) {
                throw new Error(target.broadcast
                    ? 'Simplepush error: the organization has no members to send to'
                    : 'Simplepush error: nobody is subscribed to topic "' + target.topic + '"');
            }

            // A notification does not expire. Without a timeout the node
            // listens until everyone answered or the flow is redeployed.
            var ac = new AbortController();
            inflight.add(ac);
            var timedOut = false;
            var timer = timeout !== undefined ? setTimeout(function() { timedOut = true; ac.abort(); }, timeout * 1000) : undefined;
            var open = new Map(group.instances.map(function(i) { return [i.notificationId, i]; }));
            waiting += open.size;
            showWaiting();

            // Every answer starts from the message as it came in; the first
            // one reuses it.
            var original = RED.util.cloneMessage(msg);
            var first = true;
            function copy() {
                var out = first ? msg : RED.util.cloneMessage(original);
                first = false;
                return out;
            }

            try {
                for await (const ev of group.inputs({ replay: true, signal: ac.signal })) {
                    if (ev.item.kind !== 'notificationCompleted' || !open.has(ev.instance.notificationId)) { continue; }
                    open.delete(ev.instance.notificationId);
                    waiting--;
                    showWaiting();
                    var out = copy();
                    out.status = 'completed';
                    out.notificationId = ev.instance.notificationId;
                    out.payload = answerOf(ev.item.reply);
                    out.completedAt = ev.item.raw.createdAt;
                    var recipient = shared.recipientOf(ev.recipient, ev.item.actor);
                    if (recipient) { out.recipient = recipient; } else { delete out.recipient; }
                    send([out, null]);
                }
            } catch (err) {
                if (!(timedOut && err && err.name === 'AbortError')) { throw err; }
                open.forEach(function(instance, id) {
                    var out = copy();
                    out.status = 'pending';
                    out.payload = 'pending';
                    out.notificationId = id;
                    if (instance.recipient) { out.recipient = shared.recipientOf(instance.recipient); } else { delete out.recipient; }
                    send([null, out]);
                });
            } finally {
                clearTimeout(timer);
                inflight.delete(ac);
                waiting -= open.size;
            }
            if (waiting === 0) { node.status({ fill: "green", shape: "dot", text: "done" }); } else { showWaiting(); }
        }
    }

    RED.nodes.registerType("simplepush-notification", SimplepushNotificationNode);
};
