module.exports = function(RED) {
    var shared = require('./lib/shared');

    var INPUT_TYPES = ['actions', 'text', 'choice', 'slider', 'photo', 'voiceRecording', 'file', 'location'];

    // How a task ended without an answer.
    var TERMINAL_STATUS = {
        taskDeclined: 'declined',
        taskCanceled: 'canceled',
        taskDeleted: 'deleted',
        taskExpired: 'expired'
    };
    // One output each after the answer outputs, expired last. A deleted
    // task gets none: deletion only reaches the sender's event stream when
    // every holder of that task, the sender included, deleted it.
    var TERMINAL_OUTPUTS = ['declined', 'canceled', 'expired'];

    function optionalNumber(value, what) {
        if (value === undefined || value === null || String(value).trim() === '') { return undefined; }
        var number = Number(value);
        if (!Number.isFinite(number)) {
            throw new Error('Simplepush error: ' + what + ' must be a number');
        }
        return number;
    }

    function labels(value) {
        return Array.isArray(value) ? value.map(String).map(function(s) { return s.trim(); }).filter(Boolean) : shared.splitLabels(value || '');
    }

    // Turns the node's inputs (or msg.inputs) into task inputs. Entries use
    // the SDK's input shape; actions and choice options may also be given as
    // comma separated labels, and `required` defaults to true.
    function buildInputs(entries) {
        var seen = new Set();
        return entries.map(function(entry) {
            if (!entry || INPUT_TYPES.indexOf(entry.type) === -1) {
                throw new Error('Simplepush error: unknown input type ' + (entry && entry.type) + ', use one of ' + INPUT_TYPES.join(', '));
            }
            if (seen.has(entry.type)) {
                throw new Error('Simplepush error: each input type can only be used once');
            }
            seen.add(entry.type);
            var input = { type: entry.type, required: entry.required !== false };
            if (entry.description) { input.description = String(entry.description); }
            switch (entry.type) {
                case 'actions':
                    input.actions = (Array.isArray(entry.actions) ? entry.actions : labels(entry.actions)).map(function(a) {
                        if (typeof a === 'string') { return { key: a, label: a }; }
                        var action = { key: String(a.key || a.label), label: String(a.label || a.key) };
                        if (a.style) { action.style = a.style; }
                        return action;
                    }).filter(function(a) { return a.label; });
                    if (input.actions.length === 0) {
                        throw new Error('Simplepush error: an actions input needs at least one action');
                    }
                    break;
                case 'text':
                    if (entry.defaultValue) { input.defaultValue = String(entry.defaultValue); }
                    break;
                case 'choice':
                    input.options = labels(entry.options);
                    if (input.options.length === 0) {
                        throw new Error('Simplepush error: a choice input needs at least one option');
                    }
                    if (entry.multi) {
                        input.multi = true;
                        var min = optionalNumber(entry.minSelections, 'minSelections');
                        var max = optionalNumber(entry.maxSelections, 'maxSelections');
                        if (min !== undefined) { input.minSelections = min; }
                        if (max !== undefined) { input.maxSelections = max; }
                    }
                    break;
                case 'slider':
                    input.min = optionalNumber(entry.min, 'the slider minimum');
                    input.max = optionalNumber(entry.max, 'the slider maximum');
                    if (input.min === undefined || input.max === undefined || input.min >= input.max) {
                        throw new Error('Simplepush error: a slider needs a minimum below its maximum');
                    }
                    var step = optionalNumber(entry.step, 'the slider step');
                    var defaultValue = optionalNumber(entry.defaultValue, 'the slider default value');
                    if (step !== undefined) { input.step = step; }
                    if (entry.unit) { input.unit = String(entry.unit); }
                    if (defaultValue !== undefined) { input.defaultValue = defaultValue; }
                    break;
            }
            return input;
        });
    }

    // The answer of a completed task: one key per answered input.
    async function answerOf(node, item) {
        var answer = {};
        for (const upload of item.uploads) {
            switch (upload.kind) {
                case 'action': if (upload.key !== undefined) { answer.action = upload.key; } break;
                case 'text': if (upload.value !== undefined) { answer.text = upload.value; } break;
                case 'choice': if (upload.value !== undefined) { answer.choice = upload.value; } break;
                case 'multiChoice': answer.choices = upload.values || []; break;
                case 'slider': if (upload.value !== undefined) { answer.slider = upload.value; } break;
                case 'location': if (upload.location) { answer.location = upload.location; } break;
                case 'photo': answer.photo = await shared.readFile(node, upload, 'photo'); break;
                case 'voice': answer.voice = await shared.readFile(node, upload, 'voice recording'); break;
                case 'file': answer.file = await shared.readFile(node, upload, 'file'); break;
            }
        }
        return answer;
    }

    function SimplepushNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var account = RED.nodes.getNode(config.account);
        var inflight = new Set();
        var waiting = 0;

        // Flows saved by version 1.x have no inputs, only a list of actions.
        var configInputs = Array.isArray(config.taskInputs) && config.taskInputs.length > 0
            ? config.taskInputs
            : (config.actions ? [{ type: 'actions', actions: shared.splitList(config.actions) }] : []);
        var configActions = [];
        configInputs.forEach(function(entry) {
            if (entry.type === 'actions') { configActions = labels(entry.actions); }
        });

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
            if (msg.key) {
                throw new Error('Simplepush error: msg.key is no longer supported. Send to a topic instead (msg.topic)');
            }
            if (msg.password !== undefined || msg.personalPassword !== undefined) {
                throw new Error('Simplepush error: passwords are no longer read from the message. Add the topic and its password, or your Personal Password, to the Simplepush account');
            }

            var content = shared.pick(config.message, msg.payload);
            if (content === undefined || content === null || content === '') {
                throw new Error('Simplepush error: payload is empty');
            }
            if (typeof content === 'object') { content = JSON.stringify(content); }

            // Flows saved by version 1.x carry the old key in config.key and
            // the password in config.password. The app migration imports every
            // old key as a topic of the same name.
            var target = account.target(
                shared.pick(config.topic || config.key, msg.topic),
                shared.pick(config.member, msg.member),
                config.broadcast || msg.broadcast === true,
                config.password
            );

            var entries = configInputs;
            if (entries.length === 0 && msg.inputs !== undefined) {
                if (!Array.isArray(msg.inputs)) { throw new Error('Simplepush error: msg.inputs must be an array'); }
                entries = msg.inputs;
            }
            if (entries.length === 0 && msg.actions !== undefined) {
                if (!Array.isArray(msg.actions)) { throw new Error('Simplepush error: msg.actions must be an array'); }
                entries = [{ type: 'actions', actions: msg.actions.map(String) }];
            }
            var inputs = buildInputs(entries);

            var files = config.attachments ? shared.splitList(config.attachments) : msg.attachments;
            if (files !== undefined && !Array.isArray(files)) { throw new Error('Simplepush error: attachments must be an array'); }
            var links = config.links ? shared.splitList(config.links) : msg.links;
            if (links !== undefined && !Array.isArray(links)) { throw new Error('Simplepush error: links must be an array'); }

            // The 1.x timeout, the time to wait for an action, became how long
            // the task stays open.
            var expiresIn = shared.parseSeconds(shared.pick(config.expiresIn, shared.pick(config.actionTimeout, msg.expiresIn !== undefined ? msg.expiresIn : msg.timeout)), 'expiresIn');

            var options = Object.assign({}, target, {
                title: shared.pick(config.title, msg.title),
                content: String(content),
                tag: shared.pick(config.tag || config.event, msg.tag !== undefined ? msg.tag : msg.event),
                priority: shared.parsePriority(shared.pick(config.priority, msg.priority)),
                inputs: inputs,
                links: links && links.map(String),
                autoCommit: shared.pickBoolean(config.autoCommit !== false, msg.autoCommit),
                shared: shared.pickBoolean(config.shared, msg.shared),
                expiresAt: expiresIn !== undefined ? new Date(Date.now() + expiresIn * 1000) : undefined
            });
            if (shared.pickBoolean(config.markdown, msg.markdown)) { options.contentFormat = 'markdown'; }
            if (files && files.length > 0) {
                options.files = await Promise.all(files.map(shared.toFile));
            }
            Object.keys(options).forEach(function(k) {
                if (options[k] === undefined || options[k] === '' || (Array.isArray(options[k]) && options[k].length === 0)) { delete options[k]; }
            });
            if (options.title !== undefined) { options.title = String(options.title); }
            if (options.tag !== undefined) { options.tag = String(options.tag); }

            var client = await account.client();
            node.status({ fill: "blue", shape: "dot", text: "sending" });
            var sent = await client.sendTask(options);
            var group = shared.asGroup(sent);

            msg.taskId = sent.taskId;
            msg.groupId = sent.groupId;
            if (inputs.length === 0) {
                node.status({ fill: "green", shape: "dot", text: "sent" });
                return;
            }
            if (group.instances.length === 0) {
                throw new Error(target.broadcast
                    ? 'Simplepush error: the organization has no members to send to'
                    : 'Simplepush error: nobody is subscribed to topic "' + target.topic + '"');
            }

            var ac = new AbortController();
            inflight.add(ac);
            var remaining = group.instances.length;
            waiting += remaining;
            showWaiting();

            var answerOutputs = Math.max(configActions.length, 1);
            var outputs = answerOutputs + TERMINAL_OUTPUTS.length;
            // Every answer starts from the message as it came in; the first
            // one reuses it.
            var original = RED.util.cloneMessage(msg);
            var first = true;
            function emit(out, index) {
                var outputMsgs = new Array(outputs).fill(null);
                outputMsgs[index] = out;
                send(outputMsgs);
            }
            function copy() {
                var out = first ? msg : RED.util.cloneMessage(original);
                first = false;
                return out;
            }

            // Each task's stream ends on how it ended: completed, declined,
            // canceled, deleted or expired. The group stream ends once every
            // task has. replay covers answers given before listening started.
            //
            // Who declined each task, in order. A task for one recipient has one
            // entry; a shared task ends declined once everyone has declined.
            var declines = new Map();
            try {
                for await (const ev of group.inputs({ replay: true, signal: ac.signal })) {
                    var item = ev.item;
                    var instance = ev.instance;
                    if (item.kind === 'taskDeclinedByRecipient') {
                        var decline = {};
                        var decliner = shared.recipientOf(ev.recipient, item.actor);
                        if (decliner) { decline.recipient = decliner; }
                        if (item.reason) { decline.reason = item.reason; }
                        if (item.note) { decline.note = item.note; }
                        if (!declines.has(instance.taskId)) { declines.set(instance.taskId, []); }
                        declines.get(instance.taskId).push(decline);
                        continue;
                    }
                    var status = item.kind === 'taskCompleted' ? 'completed' : TERMINAL_STATUS[item.kind];
                    if (!status) { continue; }
                    remaining--;
                    waiting--;
                    showWaiting();
                    if (status === 'deleted') { continue; }

                    var out = copy();
                    out.status = status;
                    out.taskId = instance.taskId;
                    var recipient = shared.recipientOf(ev.recipient, item.actor);
                    if (recipient) { out.recipient = recipient; } else { delete out.recipient; }
                    if (status !== 'completed') {
                        out.payload = status;
                        if (status === 'declined') {
                            out.declines = declines.get(instance.taskId) || [];
                            if (out.declines.length === 1 && out.declines[0].note !== undefined) { out.note = out.declines[0].note; }
                        }
                        emit(out, answerOutputs + TERMINAL_OUTPUTS.indexOf(status));
                        continue;
                    }
                    out.payload = await answerOf(node, item);
                    out.completedAt = item.raw.createdAt;
                    var index = configActions.indexOf(out.payload.action);
                    emit(out, index === -1 ? 0 : index);
                }
            } finally {
                inflight.delete(ac);
                waiting -= remaining;
            }
            if (waiting === 0) { node.status({ fill: "green", shape: "dot", text: "done" }); } else { showWaiting(); }
        }
    }

    RED.nodes.registerType("simplepush", SimplepushNode);
};
