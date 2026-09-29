module.exports = function(RED) {
    var shared = require('./lib/shared');

    // Wait before listening again after a failure that may go away.
    var RETRY_MS = 30000;

    // Sends a message for every submission: what people send from the app on
    // their own, without a task.
    function SimplepushInNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var account = RED.nodes.getNode(config.account);
        var ac = new AbortController();
        var retryTimer;
        // Where to pick up after a restart, so nothing sent meanwhile is lost.
        var since;
        var lastId;

        if (!account) {
            node.status({ fill: "red", shape: "ring", text: "no account" });
            return;
        }

        async function received(submission) {
            var msg = { payload: {}, submissionId: submission.id, submittedAt: submission.createdAt };
            var sender = shared.recipientOf(undefined, submission.actor);
            if (sender) { msg.sender = sender; }
            if (submission.body && submission.body.text !== undefined) { msg.payload.text = submission.body.text; }
            if (submission.location) { msg.payload.location = submission.location; }
            if (submission.photo) { msg.payload.photo = await shared.readFile(node, submission.photo, 'photo'); }
            if (submission.file) { msg.payload.file = await shared.readFile(node, submission.file, 'file'); }
            if (submission.audio) { msg.payload.audio = await shared.readFile(node, submission.audio, 'audio clip'); }
            node.send(msg);
        }

        async function listen() {
            var client = await account.client();
            node.status({ fill: "green", shape: "dot", text: "listening" });
            var options = { signal: ac.signal };
            if (since) { options.since = since; }
            for await (const submission of client.submissions(options)) {
                if (submission.id !== undefined && submission.id === lastId) { continue; }
                lastId = submission.id;
                if (submission.createdAt) { since = submission.createdAt; }
                try {
                    await received(submission);
                } catch (err) {
                    node.error(err);
                }
            }
        }

        function start() {
            listen().then(function() {
                // The stream only ends when the node closes.
            }, function(err) {
                if (ac.signal.aborted) { return; }
                // A missing or rejected token or a missing permission won't go
                // away by itself; anything else is tried again.
                if (err && (err.name === 'SimplepushConfigError' || (err.name === 'HttpError' && err.status >= 400 && err.status < 500))) {
                    node.status({ fill: "red", shape: "ring", text: "stopped" });
                    node.error('Simplepush: stopped listening for submissions: ' + err.message);
                    return;
                }
                node.status({ fill: "yellow", shape: "ring", text: "retrying" });
                node.warn('Simplepush: listening for submissions failed, retrying in ' + (RETRY_MS / 1000) + ' seconds: ' + (err && err.message || err));
                retryTimer = setTimeout(start, RETRY_MS);
            });
        }
        start();

        node.on('close', function() {
            clearTimeout(retryTimer);
            ac.abort();
            node.status({});
        });
    }

    RED.nodes.registerType("simplepush-in", SimplepushInNode);
};
