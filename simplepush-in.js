module.exports = function(RED) {
    var shared = require('./lib/shared');

    // Wait before listening again after a failure that may go away.
    var RETRY_MS = 30000;

    // Failures that won't go away by themselves: a missing token, a request
    // refused with a 4xx, or the event connection refused with one ("Unexpected
    // server response: 401"). 408, 425 and 429 are worth another try.
    function permanent(err) {
        if (!err) { return false; }
        if (err.name === 'SimplepushConfigError') { return true; }
        var status = err.name === 'HttpError' ? err.status : Number((/Unexpected server response:\s*(\d{3})/.exec(err.message || '') || [])[1]);
        return status >= 400 && status < 500 && [408, 425, 429].indexOf(status) === -1;
    }

    // Sends a message for every submission: what people send from the app on
    // their own, without a task.
    function SimplepushInNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var account = RED.nodes.getNode(config.account);
        var ac = new AbortController();
        var retryTimer;

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
            // Shares the account's connection with the task and notification
            // nodes, which also resumes after a dropped connection.
            for await (const submission of client.submissions({ signal: ac.signal })) {
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
                if (permanent(err)) {
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
